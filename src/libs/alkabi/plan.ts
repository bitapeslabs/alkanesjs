/*─────────────────────────────────────────────────────────────
  VIEW PLAN EVALUATION (static simulate fast-path)
  -----------------------------------------------------------
  A faithful TypeScript port of the alkabi plan evaluator
  (Rust `alkabi::plan`). A plan is a pure expression over storage
  keys, calldata words, and block height that reproduces a view's
  response bytes. Given the contract's storage (fetched in one
  batched espo `get_keys` call), evaluating the plan replaces a
  full `simulate` round-trip.

  Semantics mirror the Rust evaluator exactly: all numbers are
  u128 with wrapping add/sub/mul; div/mod by zero throws; `u`
  reads at most the first 16 bytes little-endian; a missing key
  is zero-length; calldata is the post-opcode input words
  flattened into 16-byte little-endian chunks.
──────────────────────────────────────────────────────────────*/

const U128_MASK = (1n << 128n) - 1n;
const wrap = (n: bigint): bigint => n & U128_MASK;

const LOOP_LIMIT = 65_536n;

export interface PlanExpr {
  readonly v: number;
  readonly expr: unknown;
  readonly trials: number;
}

/** Storage resolver: key bytes → value bytes (zero-length if unset). */
export interface PlanContext {
  words: bigint[];
  height: bigint;
  storage: (key: Uint8Array) => Uint8Array;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function calldataBytes(words: bigint[]): Uint8Array {
  const out = new Uint8Array(words.length * 16);
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    for (let j = 0; j < 16; j++) {
      out[i * 16 + j] = Number(w & 0xffn);
      w >>= 8n;
    }
  }
  return out;
}

function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null) {
    throw new Error(`plan: expected object, got ${typeof v}`);
  }
  return v as Record<string, unknown>;
}

export function evalBytes(
  expr: unknown,
  ctx: PlanContext,
  varVal?: bigint,
): Uint8Array {
  const o = obj(expr);

  if ("bytes" in o) return hexToBytes(o.bytes as string);

  if ("storage" in o) {
    const key = evalBytes(o.storage, ctx, varVal);
    return ctx.storage(key);
  }

  if ("calldata" in o) {
    const c = obj(o.calldata);
    const all = calldataBytes(ctx.words);
    const start = Number(c.start ?? 0);
    if (start > all.length) throw new Error("plan: calldata start out of range");
    const end =
      c.len != null ? Math.min(start + Number(c.len), all.length) : all.length;
    return all.slice(start, end);
  }

  if ("concat" in o) {
    const parts = (o.concat as unknown[]).map((p) => evalBytes(p, ctx, varVal));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  if ("slice" in o) {
    const s = obj(o.slice);
    const of = evalBytes(s.of, ctx, varVal);
    const start = Number(evalNum(s.start, ctx, varVal));
    const len = Number(evalNum(s.len, ctx, varVal));
    if (start > of.length || start + len > of.length) {
      throw new Error("plan: slice out of range");
    }
    return of.slice(start, start + len);
  }

  if ("le" in o) {
    const l = obj(o.le);
    const n = evalNum(l.of, ctx, varVal);
    const width = Number(l.width);
    const out = new Uint8Array(width);
    let v = n;
    for (let i = 0; i < width; i++) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }

  if ("if" in o) {
    const i = obj(o.if);
    return evalBool(i.cond, ctx, varVal)
      ? evalBytes(i.then, ctx, varVal)
      : evalBytes(i.else, ctx, varVal);
  }

  if ("loop" in o) {
    const l = obj(o.loop);
    const count = evalNum(l.count, ctx, varVal);
    if (count > LOOP_LIMIT) throw new Error("plan: loop count exceeds limit");
    const parts: Uint8Array[] = [];
    for (let i = 0n; i < count; i++) {
      parts.push(evalBytes(l.body, ctx, i));
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  if ("hex" in o) {
    const inner = evalBytes(o.hex, ctx, varVal);
    return new TextEncoder().encode(bytesToHex(inner));
  }

  if ("decimal" in o) {
    const n = evalNum(o.decimal, ctx, varVal);
    return new TextEncoder().encode(n.toString());
  }

  throw new Error(`plan: unrecognized bytes expr: ${JSON.stringify(expr)}`);
}

export function evalNum(
  expr: unknown,
  ctx: PlanContext,
  varVal?: bigint,
): bigint {
  const o = obj(expr);

  if ("num" in o) return BigInt(o.num as string);
  if ("word" in o) {
    const i = Number(o.word);
    if (i >= ctx.words.length) throw new Error(`plan: word ${i} missing`);
    return ctx.words[i];
  }
  if ("u" in o) {
    const bytes = evalBytes(o.u, ctx, varVal);
    const take = Math.min(bytes.length, 16);
    let n = 0n;
    for (let i = 0; i < take; i++) n |= BigInt(bytes[i]) << (8n * BigInt(i));
    return n;
  }
  if ("len" in o) return BigInt(evalBytes(o.len, ctx, varVal).length);
  if ("height" in o) return ctx.height;
  if ("var" in o) {
    if (varVal === undefined) throw new Error("plan: `var` outside a loop");
    return varVal;
  }
  if ("add" in o) {
    const [a, b] = o.add as [unknown, unknown];
    return wrap(evalNum(a, ctx, varVal) + evalNum(b, ctx, varVal));
  }
  if ("sub" in o) {
    const [a, b] = o.sub as [unknown, unknown];
    return wrap(evalNum(a, ctx, varVal) - evalNum(b, ctx, varVal));
  }
  if ("mul" in o) {
    const [a, b] = o.mul as [unknown, unknown];
    return wrap(evalNum(a, ctx, varVal) * evalNum(b, ctx, varVal));
  }
  if ("div" in o) {
    const [a, b] = o.div as [unknown, unknown];
    const d = evalNum(b, ctx, varVal);
    if (d === 0n) throw new Error("plan: division by zero");
    return evalNum(a, ctx, varVal) / d;
  }
  if ("mod" in o) {
    const [a, b] = o.mod as [unknown, unknown];
    const d = evalNum(b, ctx, varVal);
    if (d === 0n) throw new Error("plan: modulo by zero");
    return evalNum(a, ctx, varVal) % d;
  }
  if ("shr" in o) {
    const [a, b] = o.shr as [unknown, unknown];
    const s = evalNum(b, ctx, varVal);
    const x = evalNum(a, ctx, varVal);
    return s >= 128n ? 0n : x >> s;
  }
  if ("shl" in o) {
    const [a, b] = o.shl as [unknown, unknown];
    const s = evalNum(b, ctx, varVal);
    const x = evalNum(a, ctx, varVal);
    return s >= 128n ? 0n : (x << s) & U128_MASK;
  }
  if ("and" in o) {
    const [a, b] = o.and as [unknown, unknown];
    return evalNum(a, ctx, varVal) & evalNum(b, ctx, varVal);
  }
  if ("or" in o) {
    const [a, b] = o.or as [unknown, unknown];
    return evalNum(a, ctx, varVal) | evalNum(b, ctx, varVal);
  }
  if ("xor" in o) {
    const [a, b] = o.xor as [unknown, unknown];
    return evalNum(a, ctx, varVal) ^ evalNum(b, ctx, varVal);
  }

  throw new Error(`plan: unrecognized num expr: ${JSON.stringify(expr)}`);
}

export function evalBool(
  expr: unknown,
  ctx: PlanContext,
  varVal?: bigint,
): boolean {
  const o = obj(expr);
  const pair = (k: string) => o[k] as [unknown, unknown];

  if ("eq" in o) {
    const [a, b] = pair("eq");
    return evalNum(a, ctx, varVal) === evalNum(b, ctx, varVal);
  }
  if ("ne" in o) {
    const [a, b] = pair("ne");
    return evalNum(a, ctx, varVal) !== evalNum(b, ctx, varVal);
  }
  if ("lt" in o) {
    const [a, b] = pair("lt");
    return evalNum(a, ctx, varVal) < evalNum(b, ctx, varVal);
  }
  if ("lte" in o) {
    const [a, b] = pair("lte");
    return evalNum(a, ctx, varVal) <= evalNum(b, ctx, varVal);
  }
  if ("gt" in o) {
    const [a, b] = pair("gt");
    return evalNum(a, ctx, varVal) > evalNum(b, ctx, varVal);
  }
  if ("gte" in o) {
    const [a, b] = pair("gte");
    return evalNum(a, ctx, varVal) >= evalNum(b, ctx, varVal);
  }
  if ("beq" in o) {
    const [a, b] = pair("beq");
    const ba = evalBytes(a, ctx, varVal);
    const bb = evalBytes(b, ctx, varVal);
    if (ba.length !== bb.length) return false;
    return ba.every((x, i) => x === bb[i]);
  }
  if ("and" in o) {
    return (o.and as unknown[]).every((p) => evalBool(p, ctx, varVal));
  }
  if ("or" in o) {
    return (o.or as unknown[]).some((p) => evalBool(p, ctx, varVal));
  }
  if ("not" in o) return !evalBool(o.not, ctx, varVal);

  throw new Error(`plan: unrecognized bool expr: ${JSON.stringify(expr)}`);
}

/**
 * Collect the storage keys a plan reads, exploring EVERY branch so that a
 * single batched fetch covers all keys the evaluation could touch.
 *
 * The distinction that minimizes round-trips: a `storage(keyExpr)` whose key
 * is computable from calldata, height, constants, and already-known storage is
 * collected now, regardless of which `if`/`and`/`or` branch it sits in — so
 * `if s(k1)==2 { s(k2) } else { s(k3) }` yields {k1, k2, k3} in one pass. Only
 * a key whose *bytes* depend on a not-yet-fetched storage value (e.g.
 * `s(s(k))`) is deferred; the caller fetches what was found and calls again,
 * so nested-key plans still resolve in the minimum number of rounds.
 *
 * `known` is the storage fetched so far. The returned keys are those newly
 * resolvable this round (may include already-known ones; the caller filters).
 */
export function collectPlanKeys(
  plan: PlanExpr,
  words: bigint[],
  height: bigint,
  known: Map<string, Uint8Array>,
): Uint8Array[] {
  const out = new Map<string, Uint8Array>();
  const c: Collector = { words, height, known, out };
  collectBytes(plan.expr, c, undefined);
  return [...out.values()];
}

interface Collector {
  words: bigint[];
  height: bigint;
  known: Map<string, Uint8Array>;
  out: Map<string, Uint8Array>;
}

/** Strict eval context: unknown storage throws, so a key that depends on an
 *  unfetched value is reported as unresolvable rather than silently wrong. */
function strictCtx(c: Collector): PlanContext {
  return {
    words: c.words,
    height: c.height,
    storage: (key) => {
      const v = c.known.get(bytesToHex(key));
      if (v === undefined) throw new Error("plan: key depends on unfetched storage");
      return v;
    },
  };
}

function tryResolveKey(
  keyExpr: unknown,
  c: Collector,
  varVal: bigint | undefined,
): void {
  try {
    const key = evalBytes(keyExpr, strictCtx(c), varVal);
    c.out.set(bytesToHex(key), key);
  } catch {
    // key not yet resolvable — a later round will pick it up
  }
}

function collectBytes(expr: unknown, c: Collector, varVal: bigint | undefined): void {
  const o = obj(expr);
  if ("bytes" in o) return;
  if ("storage" in o) {
    collectBytes(o.storage, c, varVal); // keys nested inside the key computation
    tryResolveKey(o.storage, c, varVal);
    return;
  }
  if ("calldata" in o) return;
  if ("concat" in o) {
    (o.concat as unknown[]).forEach((p) => collectBytes(p, c, varVal));
    return;
  }
  if ("slice" in o) {
    const s = obj(o.slice);
    collectBytes(s.of, c, varVal);
    collectNum(s.start, c, varVal);
    collectNum(s.len, c, varVal);
    return;
  }
  if ("le" in o) {
    collectNum(obj(o.le).of, c, varVal);
    return;
  }
  if ("if" in o) {
    const i = obj(o.if);
    collectBool(i.cond, c, varVal); // all three branches, unconditionally
    collectBytes(i.then, c, varVal);
    collectBytes(i.else, c, varVal);
    return;
  }
  if ("loop" in o) {
    const l = obj(o.loop);
    collectNum(l.count, c, varVal);
    // If the count is resolvable, walk the body per iteration so var-dependent
    // keys become concrete; otherwise walk once (finds var-independent keys).
    try {
      const count = evalNum(l.count, strictCtx(c), varVal);
      const n = count > LOOP_LIMIT ? LOOP_LIMIT : count;
      for (let i = 0n; i < n; i++) collectBytes(l.body, c, i);
    } catch {
      collectBytes(l.body, c, undefined);
    }
    return;
  }
  if ("hex" in o) return collectBytes(o.hex, c, varVal);
  if ("decimal" in o) return collectNum(o.decimal, c, varVal);
}

function collectNum(expr: unknown, c: Collector, varVal: bigint | undefined): void {
  const o = obj(expr);
  if ("u" in o) return collectBytes(o.u, c, varVal);
  if ("len" in o) return collectBytes(o.len, c, varVal);
  for (const k of ["add", "sub", "mul", "div", "mod", "shr", "shl", "and", "or", "xor"]) {
    if (k in o) {
      const [a, b] = o[k] as [unknown, unknown];
      collectNum(a, c, varVal);
      collectNum(b, c, varVal);
      return;
    }
  }
  // num / word / height / var read no storage
}

function collectBool(expr: unknown, c: Collector, varVal: bigint | undefined): void {
  const o = obj(expr);
  for (const k of ["eq", "ne", "lt", "lte", "gt", "gte"]) {
    if (k in o) {
      const [a, b] = o[k] as [unknown, unknown];
      collectNum(a, c, varVal);
      collectNum(b, c, varVal);
      return;
    }
  }
  if ("beq" in o) {
    const [a, b] = o.beq as [unknown, unknown];
    collectBytes(a, c, varVal);
    collectBytes(b, c, varVal);
    return;
  }
  if ("and" in o) return (o.and as unknown[]).forEach((p) => collectBool(p, c, varVal));
  if ("or" in o) return (o.or as unknown[]).forEach((p) => collectBool(p, c, varVal));
  if ("not" in o) return collectBool(o.not, c, varVal);
}

/** Evaluate the plan to raw response bytes given a resolved storage map. */
export function evalPlan(
  plan: PlanExpr,
  words: bigint[],
  height: bigint,
  storage: Map<string, Uint8Array>,
): Uint8Array {
  const ctx: PlanContext = {
    words,
    height,
    storage: (key) => storage.get(bytesToHex(key)) ?? new Uint8Array(0),
  };
  return evalBytes(plan.expr, ctx);
}

/** Whether the plan references block height (so we know to fetch it). */
export function planUsesHeight(expr: unknown): boolean {
  if (typeof expr !== "object" || expr === null) return false;
  const o = expr as Record<string, unknown>;
  if ("height" in o) return true;
  return Object.values(o).some((v) =>
    Array.isArray(v)
      ? v.some((x) => planUsesHeight(x))
      : planUsesHeight(v),
  );
}
