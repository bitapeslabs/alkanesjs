import { AlkanesParsedSimulationResult } from "./types";
import { AlkanesTraceEncodedResult, AlkanesTraceResult } from "./types";
export const stripHex = (s: string) => (s.startsWith("0x") ? s.slice(2) : s);
export function toU64LittleEndianHex(numStr: string): string {
  const num = BigInt(numStr);
  const hex = num.toString(16).padStart(16, "0"); // 8 bytes = 16 hex chars

  const bytes = hex.match(/.{2}/g);
  if (!bytes) throw new Error("Invalid hex conversion");

  const littleEndian = bytes.reverse().join("");
  return `0x${littleEndian}`;
}

export function makeFakeBlock(height: number | bigint): string {
  const buf = new Uint8Array(80); // zero-initialised
  const h = BigInt(height);

  // write height LE into bytes 72-79
  for (let i = 0; i < 8; i++) {
    buf[72 + i] = Number((h >> BigInt(8 * i)) & 0xffn);
  }

  // Uint8Array → hex ↦ 0x…
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}`;
}

export function toU64BigEndianHex(numStr: string): string {
  const MAX_U64 = BigInt("0xffffffffffffffff"); // 2^64-1
  const num = BigInt(numStr);

  if (num < 0n || num > MAX_U64) {
    throw new RangeError("Value exceeds u64 range");
  }

  // 8 bytes → 16 hex digits
  const hex = num.toString(16).padStart(16, "0");
  return `0x${hex}`;
}
export function toU128LittleEndianHex(numStr: string): string {
  // 2^128 − 1  =  340282366920938463463374607431768211455
  const MAX_U128 = BigInt("0xffffffffffffffffffffffffffffffff");
  const num = BigInt(numStr);

  if (num < 0n || num > MAX_U128) {
    throw new RangeError("Value exceeds u128 range");
  }

  // 16 bytes → 32 hex digits
  const hex = num.toString(16).padStart(32, "0");

  // Split into byte pairs, reverse order, join
  const littleEndian = (hex.match(/.{2}/g) as string[]).reverse().join("");

  return `0x${littleEndian}`;
}

export function mapToPrimitives(v: any): any {
  switch (typeof v) {
    case "bigint":
      return "0x" + v.toString(16);
    case "object": {
      if (v === null) return null;
      if (Buffer.isBuffer(v)) return "0x" + v.toString("hex");
      if (Array.isArray(v)) return v.map(mapToPrimitives);
      return Object.fromEntries(
        Object.entries(v).map(([k, val]) => [k, mapToPrimitives(val)]),
      );
    }
    default:
      return v;
  }
}

export function unmapFromPrimitives(v: any): any {
  switch (typeof v) {
    case "string":
      if (v.startsWith("0x") && v !== "0x")
        return Buffer.from(stripHex(v), "hex");
      if (!isNaN(v as any)) return BigInt(v);
      return v;
    case "object": {
      if (v === null) return null;
      if (Array.isArray(v)) return v.map(unmapFromPrimitives);
      return Object.fromEntries(
        Object.entries(v).map(([k, val]) => [k, unmapFromPrimitives(val)]),
      );
    }
    default:
      return v;
  }
}

export function parseSimulateReturn(
  v: string,
): AlkanesParsedSimulationResult | undefined {
  if (v === "0x") return undefined;

  const toUtf8 = Buffer.from(stripHex(v), "hex").toString("utf8");
  const isUtf8 = !/[\uFFFD]/.test(toUtf8);

  const rev = Buffer.from(
    Array.from(Buffer.from(stripHex(v), "hex")).reverse(),
  ).toString("hex");

  return {
    string: isUtf8 ? toUtf8 : "0x" + stripHex(v),
    bytes: "0x" + stripHex(v),
    le: BigInt("0x" + rev).toString(),
    be: BigInt("0x" + stripHex(v)).toString(),
  };
}

function hexLEToBigInt(hex: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }

  let raw = hex.slice(2); // strip `0x`
  if (raw.length % 2 !== 0) raw = "0" + raw; // make even length

  // reverse byte order (little-endian → big-endian)
  let be = "";
  for (let i = 0; i < raw.length; i += 2) {
    be = raw.substring(i, i + 2) + be;
  }
  return BigInt("0x" + be);
}

/**
 * Recursively walks a structure and converts every *hex string* (`/^0x[0-9a-f]+$/i`)
 * it finds into a `bigint` via `hexLEToBigInt`.
 */
function deepHexToBigInt<T>(value: T): unknown {
  if (Array.isArray(value)) {
    return value.map(deepHexToBigInt);
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "data") {
        out[k] = v; // leave 'data' field untouched
      } else {
        out[k] = deepHexToBigInt(v as never);
      }
    }
    return out;
  }

  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
    return hexLEToBigInt(value);
  }

  return value;
}

/**
 * A trace as espo and the alkanes indexer write one, where every u128 is
 * minimal **big-endian** hex (`format!("0x{:x}")` in `espo/src/alkanes/trace.rs`
 * and `alkanes-support`'s `fmt_u128_hex`). `0xcf16` is 53014, not 5839.
 *
 * This is deliberately separate from `decodeAlkanesTrace`, which byte-reverses
 * every hex string it finds. Both cannot be right about the same bytes; see
 * `hexLEToBigInt` above.
 */
export function decodeTrace(
  encoded: AlkanesTraceEncodedResult,
): AlkanesTraceResult {
  return deepBigEndianHex(encoded) as unknown as AlkanesTraceResult;
}

/**
 * Every hex string read big-endian, except returndata, which stays a string.
 *
 * The exemption is only for the response's `data` — the raw bytes a call
 * returned. An event's own `data` is its whole payload, so skipping every key
 * named `data` would skip the entire trace.
 */
function deepBigEndianHex<T>(value: T): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => deepBigEndianHex(entry));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        k === "data" && typeof v === "string" ? v : deepBigEndianHex(v as never);
    }
    return out;
  }
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
    return BigInt(value);
  }
  return value;
}

export function decodeAlkanesTrace(
  encoded: AlkanesTraceEncodedResult,
): AlkanesTraceResult {
  // `deepHexToBigInt` already returns data in the correct shape,
  // but TS needs a cast to satisfy the compiler.
  const decoded = deepHexToBigInt(encoded) as unknown as AlkanesTraceResult;
  return decoded;
}

export function extractAbiErrorMessage(data: string): string | null {
  if (!data?.startsWith("0x")) return null;
  const hex = data.slice(2).toLowerCase();
  const ERROR_SELECTOR = "08c379a0";
  if (hex.length < 8 || !hex.startsWith(ERROR_SELECTOR)) return null;

  const body = hex.slice(8);

  const hexToUtf8 = (h: string): string =>
    decodeURIComponent(
      h.replace(/(..)/g, "%$1"), // percent-encode every byte
    );

  if (body.length >= 128 && body.startsWith("0".repeat(62) + "20")) {
    const lenHex = body.slice(64, 128);
    const len = parseInt(lenHex, 16);
    const strHex = body.slice(128, 128 + len * 2);
    try {
      return hexToUtf8(strHex);
    } catch {
      return null;
    }
  }

  try {
    return hexToUtf8(body);
  } catch {
    return null;
  }
}
