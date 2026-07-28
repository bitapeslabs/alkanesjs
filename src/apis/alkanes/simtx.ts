/*───────────────────────────────────────────────────────────────
  alkanes_simulatetransaction / alkanes_simulateblock — the
  authoritative way to ask what a raw transaction, or a block of
  them, would do. Signed or not; nothing here checks a signature.

  The wire format is metashrew's: a hex protobuf request in, a hex
  protobuf response out. kirby speaks the same contract and answers
  tip-state requests itself, so the same call works against either —
  which is the point: the SDK targets the standard API, and kirby is
  just the fast way to reach it.

  The codec below is hand-rolled rather than generated. The messages
  involved are small and fixed (see alkanes-rs
  `crates/alkanes-support/proto/alkanes.proto`), and a proto toolchain
  would be a heavy dependency for six message types that change with
  the protocol, not with fashion.

  Traces decode into the same espo-shaped JSON the rest of the SDK
  already reads — `{event, data}` tagging, u128 as minimal big-endian
  hex — so a trace from this path is indistinguishable from one off
  `alkanes_trace` or `alkanes_simulateblock`.
──────────────────────────────────────────────────────────────*/

import type { AlkanesTraceEncodedResult } from "./types";

/*------------------------------------------------------------*
 | Wire primitives                                             |
 *------------------------------------------------------------*/

/** One LEB128 varint out of `b` at `i`: the value and the next offset. */
function readVarint(b: Uint8Array, i: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  for (;;) {
    const byte = b[i++];
    if (byte === undefined) throw new Error("truncated varint");
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, i];
    shift += 7n;
  }
}

function writeVarint(n: bigint | number, out: number[]): void {
  let v = BigInt(n);
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

type Field = { no: number; num: bigint; bytes: Uint8Array };

/** Every field of one protobuf message, in wire order. */
function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < b.length) {
    const [key, afterKey] = readVarint(b, i);
    const no = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      const [num, next] = readVarint(b, afterKey);
      out.push({ no, num, bytes: new Uint8Array() });
      i = next;
    } else if (wire === 2) {
      const [len, start] = readVarint(b, afterKey);
      const end = start + Number(len);
      out.push({ no, num: 0n, bytes: b.subarray(start, end) });
      i = end;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return out;
}

const first = (fs: Field[], no: number): Field | undefined =>
  fs.find((f) => f.no === no);
const all = (fs: Field[], no: number): Field[] => fs.filter((f) => f.no === no);

/** `message uint128 { uint64 lo = 1; uint64 hi = 2; }` */
function u128(b: Uint8Array): bigint {
  const fs = fields(b);
  const lo = first(fs, 1)?.num ?? 0n;
  const hi = first(fs, 2)?.num ?? 0n;
  return (hi << 64n) | lo;
}

const hexOf = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** u128 the way espo writes one: minimal big-endian hex. */
const hex128 = (v: bigint): string => "0x" + v.toString(16);

/*------------------------------------------------------------*
 | Request                                                     |
 *------------------------------------------------------------*/

/**
 * The request's `height` is not a state pin — state is always the tip. It
 * selects the consensus era (fuel forks, revert containment), and `0` means
 * pre-genesis rules under which nothing modern runs the same. A correct
 * "what would this do now" therefore carries the CURRENT height, which is why
 * the provider fetches one before calling this.
 */
export function encodeSimulateTransactionRequest(
  txHex: string,
  height: number,
): string {
  const tx = txHex.replace(/^0x/, "");
  const bytes: number[] = [];
  if (height > 0) {
    bytes.push(1 << 3); // field 1: height, varint
    writeVarint(height, bytes);
  }
  bytes.push((2 << 3) | 2); // field 2: transaction, length-delimited
  writeVarint(tx.length / 2, bytes);
  for (let i = 0; i < tx.length; i += 2) {
    bytes.push(parseInt(tx.substr(i, 2), 16));
  }
  return "0x" + hexOf(new Uint8Array(bytes));
}

/*------------------------------------------------------------*
 | Response                                                    |
 *------------------------------------------------------------*/

/** One executed protostone: where its trace files, and what it burned. */
export interface SimulatedProtostone {
  index: number;
  /** The shadow vout its trace is filed under, as `alkanes_trace` files one. */
  vout: number;
  /** espo-shaped trace events — what `.trace`/`.traces` already speak. */
  events: AlkanesTraceEncodedResult;
  fuelUsed: bigint;
}

export interface SimulatedTransaction {
  txid: string;
  height: number;
  protostones: SimulatedProtostone[];
  /** What each real output ended up holding. */
  outputs: { vout: number; alkanes: { id: string; value: string }[] }[];
  /**
   * The runtime sheet — protorune's `u32::MAX` vout, which is not an output at
   * all. It is the protocol-wide total of everything held by contracts rather
   * than by outputs, so it is reported apart from the outputs a caller can
   * actually spend.
   */
  runtime: { id: string; value: string }[];
  totalFuelUsed: bigint;
  /** Set only for wire-level failures (e.g. no runestone) — a revert is not
   *  an error here, it is a trace whose last event has status "failure". */
  error?: string;
}

function bytesOf(hex: string): Uint8Array {
  const raw = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(raw.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(raw.substr(i * 2, 2), 16);
  }
  return bytes;
}

export function decodeSimulateTransactionResponse(
  hex: string,
): SimulatedTransaction {
  return simulatedTransaction(fields(bytesOf(hex)));
}

/** One `SimulateTransactionResponse`, already split into its fields. */
function simulatedTransaction(fs: Field[]): SimulatedTransaction {
  const protostones: SimulatedProtostone[] = all(fs, 3).map((f) => {
    const ps = fields(f.bytes);
    const outpoint = first(ps, 2);
    const vout = outpoint ? Number(first(fields(outpoint.bytes), 2)?.num ?? 0n) : 0;
    const trace = first(ps, 3);
    return {
      index: Number(first(ps, 1)?.num ?? 0n),
      vout,
      events: trace ? decodeTraceEvents(trace.bytes) : [],
      fuelUsed: first(ps, 4)?.num ?? 0n,
    };
  });

  const RUNTIME_VOUT = 0xffffffff;
  const byVout = all(fs, 4).map((f) => {
    const vb = fields(f.bytes);
    return {
      vout: Number(first(vb, 1)?.num ?? 0n),
      alkanes: all(vb, 2).map((t) => {
        const { id, value } = transfer(t.bytes);
        return { id: `${id.block}:${id.tx}`, value: value.toString() };
      }),
    };
  });
  const outputs = byVout.filter((v) => v.vout !== RUNTIME_VOUT);
  const runtime = byVout.find((v) => v.vout === RUNTIME_VOUT)?.alkanes ?? [];

  const error = first(fs, 8);
  return {
    txid: new TextDecoder().decode(first(fs, 1)?.bytes ?? new Uint8Array()),
    height: Number(first(fs, 2)?.num ?? 0n),
    protostones,
    outputs,
    runtime,
    totalFuelUsed: first(fs, 5)?.num ?? 0n,
    ...(error && error.bytes.length > 0
      ? { error: new TextDecoder().decode(error.bytes) }
      : {}),
  };
}

/*------------------------------------------------------------*
 | Whole blocks                                                |
 *------------------------------------------------------------*/

export interface SimulatedBlock {
  blockHash: string;
  height: number;
  /** One entry per tx in the block, in block order — the coinbase and any
   *  transaction without a runestone included, carrying `error` and nothing
   *  else, so `txs[i]` is `block.txdata[i]`. */
  txs: SimulatedTransaction[];
  totalFuelUsed: bigint;
  error?: string;
}

export function encodeSimulateBlockRequest(
  blockHex: string,
  height: number,
): string {
  const block = blockHex.replace(/^0x/, "");
  const bytes: number[] = [];
  if (height > 0) {
    bytes.push(1 << 3); // field 1: height, varint
    writeVarint(height, bytes);
  }
  bytes.push((2 << 3) | 2); // field 2: block, length-delimited
  writeVarint(block.length / 2, bytes);
  for (let i = 0; i < block.length; i += 2) {
    bytes.push(parseInt(block.substr(i, 2), 16));
  }
  return "0x" + hexOf(new Uint8Array(bytes));
}

export function decodeSimulateBlockResponse(hex: string): SimulatedBlock {
  const fs = fields(bytesOf(hex));
  const error = first(fs, 6);
  return {
    blockHash: new TextDecoder().decode(first(fs, 1)?.bytes ?? new Uint8Array()),
    height: Number(first(fs, 2)?.num ?? 0n),
    txs: all(fs, 3).map((f) => simulatedTransaction(fields(f.bytes))),
    totalFuelUsed: first(fs, 4)?.num ?? 0n,
    ...(error && error.bytes.length > 0
      ? { error: new TextDecoder().decode(error.bytes) }
      : {}),
  };
}

/*
  A block around a list of transactions, so they can be asked about together.

  `alkanes_simulateblock` takes a consensus-encoded block because that is what
  the indexer indexes; nothing here is mined, and only two things about the
  wrapper matter. The header is 80 bytes the view reads a `prev_blockhash` and
  a timestamp out of and otherwise ignores — a contract calling `800000000:0`
  in a simulated block sees this, which is the honest answer, since a block
  that does not exist has no header. And the coinbase has to be first and has
  to look like one (a single input spending the null outpoint), because the
  view skips `txdata[0]` on that test rather than on its position; without it
  the first real transaction would be skipped as the coinbase.

  Its size is not free: block fuel is shared out by virtual size, so the
  coinbase takes a share exactly as it does in a real block. Keeping it minimal
  keeps that share minimal.
*/
const COINBASE =
  "01000000" + // version
  "01" + // one input
  "0".repeat(64) + // null outpoint: txid
  "ffffffff" + // null outpoint: index
  "0100" + // scriptSig: one byte, OP_0
  "ffffffff" + // sequence
  "01" + // one output
  "0".repeat(16) + // value 0
  "00" + // empty scriptPubKey
  "00000000"; // locktime

/** A bitcoin varint, which is not the protobuf one. */
function compactSize(n: number): string {
  if (n < 0xfd) return n.toString(16).padStart(2, "0");
  if (n <= 0xffff) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    return "fd" + hexOf(b);
  }
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return "fe" + hexOf(b);
}

/**
 * Wrap raw transactions in a block, coinbase first. `prevBlockHash` is the
 * hash the block would build on, big-endian as everything displays it; left
 * out it is zeroed, which is what a block nobody has mined deserves.
 */
export function blockOf(txHexes: readonly string[], prevBlockHash?: string): string {
  const prev = (prevBlockHash ?? "0".repeat(64)).replace(/^0x/, "");
  const header =
    "01000000" + // version
    (prev.match(/../g) ?? []).reverse().join("") + // prev hash, little-endian
    "0".repeat(64) + // merkle root — nothing here is committed to
    "00000000" + // time
    "00000000" + // bits
    "00000000"; // nonce
  const txs = [COINBASE, ...txHexes.map((h) => h.replace(/^0x/, ""))];
  return "0x" + header + compactSize(txs.length) + txs.join("");
}

/*------------------------------------------------------------*
 | Trace protobuf → espo-shaped events                         |
 *------------------------------------------------------------*/

function alkaneId(b: Uint8Array): { block: bigint; tx: bigint } {
  const fs = fields(b);
  return {
    block: first(fs, 1) ? u128(first(fs, 1)!.bytes) : 0n,
    tx: first(fs, 2) ? u128(first(fs, 2)!.bytes) : 0n,
  };
}

function transfer(b: Uint8Array): {
  id: { block: bigint; tx: bigint };
  value: bigint;
} {
  const fs = fields(b);
  return {
    id: first(fs, 1) ? alkaneId(first(fs, 1)!.bytes) : { block: 0n, tx: 0n },
    value: first(fs, 2) ? u128(first(fs, 2)!.bytes) : 0n,
  };
}

const espoId = (id: { block: bigint; tx: bigint }) => ({
  block: hex128(id.block),
  tx: hex128(id.tx),
});

const espoTransfer = (t: { id: { block: bigint; tx: bigint }; value: bigint }) => ({
  id: espoId(t.id),
  value: hex128(t.value),
});

/** A storage key as espo shows one: its text when it is text, hex otherwise. */
function keyText(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return "0x" + hexOf(b);
  }
}

const CALL_TYPE: Record<number, string> = {
  1: "call",
  2: "delegatecall",
  3: "staticcall",
};

/**
 * `AlkanesTrace` protobuf → the sandshrew/espo JSON events every other trace
 * source in this SDK produces. Field numbers follow
 * `alkanes.proto`; the rendering follows espo's `protobuf_trace_events`.
 */
export function decodeTraceEvents(b: Uint8Array): AlkanesTraceEncodedResult {
  const out: unknown[] = [];
  for (const ev of all(fields(b), 1)) {
    const oneof = fields(ev.bytes);
    const enter = first(oneof, 1);
    const exit = first(oneof, 2);
    const create = first(oneof, 3);

    if (enter) {
      const e = fields(enter.bytes);
      const traceCtx = fields(first(e, 2)?.bytes ?? new Uint8Array());
      const ctx = fields(first(traceCtx, 1)?.bytes ?? new Uint8Array());
      out.push({
        event: "invoke",
        data: {
          type: CALL_TYPE[Number(first(e, 1)?.num ?? 0n)] ?? "unknown",
          context: {
            myself: espoId(alkaneId(first(ctx, 1)?.bytes ?? new Uint8Array())),
            caller: espoId(alkaneId(first(ctx, 2)?.bytes ?? new Uint8Array())),
            inputs: all(ctx, 3).map((f) => hex128(u128(f.bytes))),
            incomingAlkanes: all(ctx, 5).map((f) => espoTransfer(transfer(f.bytes))),
            vout: Number(first(ctx, 4)?.num ?? 0n),
          },
          fuel: Number(first(traceCtx, 2)?.num ?? 0n),
        },
      });
    } else if (exit) {
      const x = fields(exit.bytes);
      const resp = fields(first(x, 2)?.bytes ?? new Uint8Array());
      out.push({
        event: "return",
        data: {
          status: Number(first(x, 1)?.num ?? 0n) === 0 ? "success" : "failure",
          response: {
            alkanes: all(resp, 1).map((f) => espoTransfer(transfer(f.bytes))),
            data: "0x" + hexOf(first(resp, 3)?.bytes ?? new Uint8Array()),
            storage: all(resp, 2).map((f) => {
              const kv = fields(f.bytes);
              return {
                key: keyText(first(kv, 1)?.bytes ?? new Uint8Array()),
                value: "0x" + hexOf(first(kv, 2)?.bytes ?? new Uint8Array()),
              };
            }),
          },
        },
      });
    } else if (create) {
      const c = fields(create.bytes);
      out.push({
        event: "create",
        data: espoId(alkaneId(first(c, 1)?.bytes ?? new Uint8Array())),
      });
    }
  }
  return out as AlkanesTraceEncodedResult;
}
