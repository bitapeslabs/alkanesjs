/*─────────────────────────────────────────────────────────────
  CONTRACT WASM RUNTIME (experiment)
  -----------------------------------------------------------
  Runs a view by executing the contract's own wasm against a stub
  host, instead of asking an indexer to simulate it. The contract
  bytes are supplied by the caller; storage reads are served from a
  batched espo `get_keys`.

  The obstacle this works around: `__load_storage` is a SYNCHRONOUS
  host call, but fetching a key is async, and JS cannot block on a
  promise inside a sync import. So execution is prefetch/replay —
  run with the keys already held, note every key that was missing,
  fetch the whole batch at once, and run again from scratch. Only a
  round that missed nothing produced its answer from complete data,
  so only that round's output is returned. Contracts are
  deterministic, so this settles (usually in two rounds: one to
  learn the keys, one to answer).

  A view that reaches for anything beyond context, storage and
  height — calling another alkane, reading the transaction — isn't
  pure, and its import traps. The caller falls back to simulate.

  Every `get_keys` this issues goes through the normal transport, so
  `new Provider({ debug: true })` logs them like any other call.
──────────────────────────────────────────────────────────────*/

import { debugEvent } from "@/debug";

export interface AlkaneIdLike {
  block: bigint | number | string;
  tx: bigint | number | string;
}

/** Fetch a batch of storage keys. Absent keys must come back zero-length. */
export type StorageFetcher = (
  keys: Uint8Array[],
) => Promise<Map<string, Uint8Array>>;

export interface WasmViewOptions {
  /** Contract bytes, or an already-compiled module (cache this across calls). */
  wasm: Uint8Array | WebAssembly.Module;
  /** The alkane being called — becomes `myself` in the context. */
  alkaneId: AlkaneIdLike;
  opcode: bigint;
  /** Calldata input words, opcode NOT included. */
  words: bigint[];
  height: bigint;
  fetchKeys: StorageFetcher;
  /** Give up after this many fetch rounds (default 8). */
  maxRounds?: number;
}

const EMPTY = new Uint8Array(0);

/** Storage keys are a readable keyword followed by binary, so show both. */
function describeKey(key: Uint8Array): string {
  let text = "";
  let i = 0;
  while (i < key.length && key[i] >= 0x20 && key[i] < 0x7f) {
    text += String.fromCharCode(key[i]);
    i++;
  }
  const rest = key.subarray(i);
  return rest.length ? `${text}+${bytesToHex(rest)}` : text || bytesToHex(key);
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function u128le(v: bigint): Uint8Array {
  const out = new Uint8Array(16);
  let x = v;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function u64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/**
 * The serialized `Context` the contract parses out of `__load_context`:
 * `[myself.block, myself.tx, caller.block, caller.tx, vout, incoming_count]`
 * then `[opcode, ...inputs]`, every field a little-endian u128. `incoming_count`
 * is zero — a view is never called with alkanes attached — so no transfer
 * triples follow the header.
 */
export function serializeContext(
  alkaneId: AlkaneIdLike,
  opcode: bigint,
  words: bigint[],
  vout: bigint = 0n,
): Uint8Array {
  const fields: bigint[] = [
    BigInt(alkaneId.block),
    BigInt(alkaneId.tx),
    0n,
    0n, // caller
    vout,
    0n, // incoming alkanes
    opcode,
    ...words,
  ];
  const out = new Uint8Array(fields.length * 16);
  fields.forEach((f, i) => out.set(u128le(f), i * 16));
  return out;
}

/**
 * Pull `response.data` out of the serialized ExtendedCallResponse:
 * `[count u128][ (block,tx,value) u128 x3 ] x count [pairs u32][ (len,bytes) x2 ] x pairs [data]`.
 */
function parseResponseData(parcel: Uint8Array): Uint8Array {
  const view = new DataView(parcel.buffer, parcel.byteOffset, parcel.byteLength);
  const readU32 = (p: number): number => {
    if (p + 4 > parcel.length) throw new Error("wasm view: truncated response");
    return view.getUint32(p, true);
  };

  if (parcel.length < 16) throw new Error("wasm view: truncated response");
  // transfer count is a u128 but only ever small; the high bytes must be zero
  for (let i = 8; i < 16; i++) {
    if (parcel[i] !== 0) throw new Error("wasm view: bad response parcel");
  }
  const count = Number(view.getBigUint64(0, true));
  if (count > 4096) throw new Error("wasm view: bad response parcel");

  let pos = 16 + count * 48;
  const pairs = readU32(pos);
  pos += 4;
  for (let i = 0; i < pairs; i++) {
    // each pair is a length-prefixed key then a length-prefixed value
    for (let half = 0; half < 2; half++) {
      pos += 4 + readU32(pos);
    }
  }
  if (pos > parcel.length) throw new Error("wasm view: truncated response");
  return parcel.slice(pos);
}

/** Imports that mean the view isn't pure — reaching outside its own storage. */
const IMPURE = new Set([
  "__call",
  "__delegatecall",
  "__staticcall",
  "__returndatacopy",
  "__request_transaction",
  "__load_transaction",
  "__request_block",
  "__load_block",
]);

/** Raised from an import the stub host can't stand in for. Never recoverable
 *  by fetching more storage, so it aborts the run rather than retrying. */
/** The contract panicked — `env.abort`. Its own revert, not a host gap. */
export class ContractRevertError extends Error {
  constructor() {
    super("wasm view: contract reverted");
    this.name = "ContractRevertError";
  }
}

export class UnrunnableViewError extends Error {
  constructor(name: string) {
    super(
      IMPURE.has(name)
        ? `wasm view: not pure — contract called ${name}`
        : `wasm view: unsupported host import ${name}`,
    );
    this.name = "UnrunnableViewError";
  }
}

interface RunOutcome {
  data?: Uint8Array;
  error?: unknown;
  misses: Set<string>;
}

/**
 * One complete execution. Synchronous by necessity — the storage imports have
 * to answer inline — so it can only serve keys already in `storage`; anything
 * else is recorded in `misses` and answered as absent for this attempt.
 */
function runOnce(
  module: WebAssembly.Module,
  context: Uint8Array,
  height: bigint,
  storage: Map<string, Uint8Array>,
): RunOutcome {
  const misses = new Set<string>();
  let instance: WebAssembly.Instance | undefined;

  const memory = (): Uint8Array => {
    const m = instance?.exports.memory as WebAssembly.Memory | undefined;
    if (!m) throw new Error("wasm view: contract exports no memory");
    return new Uint8Array(m.buffer);
  };

  /**
   * Alkanes passes a pointer to the bytes themselves, with their u32 length in
   * the four bytes immediately before it.
   */
  const lenPrefixed = (ptr: number): Uint8Array => {
    const mem = memory();
    if (ptr < 4 || ptr > mem.length) return EMPTY;
    const len = new DataView(mem.buffer).getUint32(ptr - 4, true);
    return mem.slice(ptr, Math.min(ptr + len, mem.length));
  };

  const write = (ptr: number, bytes: Uint8Array): number => {
    memory().set(bytes, ptr);
    return bytes.length;
  };

  // `via` is the import that asked — the contract reads a key twice, once for
  // its length and once for its bytes
  const lookup = (key: Uint8Array, via: string): Uint8Array => {
    const hex = bytesToHex(key);
    const held = storage.get(hex);
    if (held === undefined) {
      misses.add(hex);
      debugEvent("HOST", `${via} ${describeKey(key)} → not held yet`);
      return EMPTY;
    }
    debugEvent("HOST", `${via} ${describeKey(key)} → ${held.length} bytes`);
    return held;
  };

  // A JS import adapts to whatever signature the wasm declares — surplus
  // arguments are dropped and a surplus return value is ignored — so these
  // need no per-version tailoring as the host ABI drifts.
  const host: Record<string, (...a: number[]) => number | void> = {
    __request_context: () => context.length,
    __load_context: (ptr) => write(ptr, context),
    __request_storage: (ptr) =>
      lookup(lenPrefixed(ptr), "__request_storage").length,
    __load_storage: (keyPtr, outPtr) =>
      write(outPtr, lookup(lenPrefixed(keyPtr), "__load_storage")),
    __height: (ptr) => write(ptr, u64le(height)),
    __sequence: (ptr) => write(ptr, u128le(0n)),
    __fuel: (ptr) => write(ptr, u64le(0n)),
    __balance: (_who, _what, ptr) => write(ptr, u128le(0n)),
    __log: () => undefined,
    abort: () => {
      throw new ContractRevertError();
    },
  };

  const imports: WebAssembly.Imports = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    const bucket: WebAssembly.ModuleImports = (imports[imp.module] ??= {});
    if (imp.kind !== "function") continue;
    const impl = host[imp.name];
    bucket[imp.name] =
      impl ??
      (() => {
        throw new UnrunnableViewError(imp.name);
      });
  }

  try {
    instance = new WebAssembly.Instance(module, imports);
    const execute = instance.exports.__execute as (() => number) | undefined;
    if (!execute) throw new Error("wasm view: contract exports no __execute");
    return { data: parseResponseData(lenPrefixed(execute())), misses };
  } catch (error) {
    return { error, misses };
  }
}

/**
 * Evaluate a view by running the contract, fetching whatever storage it reaches
 * for along the way. Resolves with the raw `response.data` bytes.
 */
export async function runWasmView(o: WasmViewOptions): Promise<Uint8Array> {
  const module =
    o.wasm instanceof WebAssembly.Module
      ? o.wasm
      // a Uint8Array over any ArrayBufferLike is a fine BufferSource at runtime;
      // the DOM types just insist on a plain ArrayBuffer
      : await WebAssembly.compile(o.wasm as unknown as BufferSource);
  const context = serializeContext(o.alkaneId, o.opcode, o.words);
  const storage = new Map<string, Uint8Array>();
  const maxRounds = o.maxRounds ?? 8;

  for (let round = 0; round < maxRounds; round++) {
    const { data, error, misses } = runOnce(module, context, o.height, storage);
    debugEvent(
      "WASM",
      error
        ? `run ${round}: ${(error as Error).message}`
        : misses.size
          ? `run ${round}: needs ${misses.size} more key(s), re-running`
          : `run ${round}: answered from ${storage.size} key(s)`,
    );

    // A run that wanted nothing it didn't have saw the real storage, so its
    // outcome is the true one — whether that's an answer or a genuine failure.
    if (misses.size === 0) {
      if (error) throw error;
      return data!;
    }
    // Otherwise the run was working from incomplete storage; an error here is
    // most likely a consequence of that, so fetch and try again.
    if (
      error instanceof UnrunnableViewError ||
      error instanceof ContractRevertError
    ) {
      throw error;
    }

    const fetched = await o.fetchKeys([...misses].map(hexToBytes));
    for (const hex of misses) {
      // a key that came back absent is now KNOWN absent, not still missing —
      // without this the same key is re-requested every round and never settles
      storage.set(hex, fetched.get(hex) ?? EMPTY);
    }
  }
  throw new Error(`wasm view: storage did not settle in ${maxRounds} rounds`);
}
