/*─────────────────────────────────────────────────────────────
  ALKABI WIRE CODECS — legacy calldata & raw returndata
  -----------------------------------------------------------
  Borsh-mode IO reuses borsher end to end. These codecs cover the
  other two wire modes an alkabi document can declare, driven by
  the same schema trees:

  • LegacyCodec (bidirectional) — the positional u128-word format,
    as calldata words (inputs) or their contiguous LE bytes (outputs):
      ints        → one word each
      struct/$ref → fields in declaration order
      Vec<T>      → one length word, then the elements
      string      → UTF-8 bytes + NUL terminator, packed LE into words
  • RawCodec (outputs) — the response bytes as-is:
      ints        → fixed-width LE reads (u8..u32 → number, u64/u128 → bigint)
      string      → UTF-8 to end of buffer
      Vec<u8>     → the remaining bytes (Uint8Array)
      struct/$ref → sequential reads (tuples are `_0`/`_1` structs)

  Both carry a phantom type parameter so ResolveSchema can extract
  the value type in spec definitions.
──────────────────────────────────────────────────────────────*/

import { AlkabiSchemaDef, AlkabiTypes } from "./types";

/* 16-byte little-endian word packing (the alkanes calldata convention) */
function bytesToWords(data: Uint8Array): bigint[] {
  const out: bigint[] = [];
  for (let off = 0; off < data.length; off += 16) {
    const buf = new Uint8Array(16);
    buf.set(data.subarray(off, off + 16));
    let word = 0n;
    for (let i = 0; i < 16; i++) {
      word |= BigInt(buf[i]) << (8n * BigInt(i));
    }
    out.push(word);
  }
  return out;
}

const INT_WIDTHS: Record<string, number> = {
  u8: 1,
  u16: 2,
  u32: 4,
  u64: 8,
  u128: 16,
};

const isUnsignedInt = (s: string): s is keyof typeof INT_WIDTHS =>
  s in INT_WIDTHS;

export class LegacyCodec<T = unknown> {
  declare readonly _type: T;

  constructor(
    private readonly schema: AlkabiSchemaDef,
    private readonly types: AlkabiTypes,
  ) {}

  encodeCalldata(value: unknown): bigint[] {
    const words: bigint[] = [];
    this.encode(this.schema, value, words);
    return words;
  }

  /** Decode legacy-format response bytes (contiguous LE u128 words). */
  decodeReturn(bytes: Uint8Array): T {
    const cursor = { offset: 0 };
    const value = this.decode(this.schema, bytes, cursor);
    return value as T;
  }

  private readWord(buf: Uint8Array, cursor: { offset: number }): bigint {
    if (cursor.offset + 16 > buf.length) {
      throw new Error(
        `alkabi legacy: buffer too short for a u128 word at offset ${cursor.offset} (have ${buf.length})`,
      );
    }
    let word = 0n;
    for (let i = 0; i < 16; i++) {
      word |= BigInt(buf[cursor.offset + i]) << (8n * BigInt(i));
    }
    cursor.offset += 16;
    return word;
  }

  private decode(
    schema: AlkabiSchemaDef,
    buf: Uint8Array,
    cursor: { offset: number },
  ): unknown {
    if (typeof schema === "string") {
      if (isUnsignedInt(schema)) {
        const word = this.readWord(buf, cursor);
        // one full word per int; JS type follows the declared width
        return INT_WIDTHS[schema] <= 4 ? Number(word) : word;
      }
      if (schema === "bool") {
        return this.readWord(buf, cursor) !== 0n;
      }
      if (schema === "string") {
        // NUL-terminated bytes packed LE into words
        const out: number[] = [];
        scan: while (cursor.offset < buf.length) {
          const start = cursor.offset;
          this.readWord(buf, cursor); // advances 16 bytes
          for (let i = 0; i < 16; i++) {
            const byte = buf[start + i];
            if (byte === 0) break scan;
            out.push(byte);
          }
        }
        return new TextDecoder().decode(new Uint8Array(out));
      }
      throw new Error(`alkabi legacy: unsupported primitive "${schema}"`);
    }

    if ("$ref" in schema) {
      const resolved = this.types[schema.$ref];
      if (!resolved) {
        throw new Error(`alkabi legacy: $ref "${schema.$ref}" not found`);
      }
      return this.decode(resolved, buf, cursor);
    }

    if ("struct" in schema) {
      const out: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(schema.struct)) {
        out[name] = this.decode(field, buf, cursor);
      }
      return out;
    }

    if ("array" in schema) {
      const length =
        schema.array.len != null
          ? schema.array.len
          : Number(this.readWord(buf, cursor)); // Vec: u128 length word
      const out: unknown[] = [];
      for (let i = 0; i < length; i++) {
        out.push(this.decode(schema.array.type, buf, cursor));
      }
      return out;
    }

    throw new Error(
      `alkabi legacy: schema not supported in legacy mode: ${JSON.stringify(schema)}`,
    );
  }

  private encode(schema: AlkabiSchemaDef, value: unknown, out: bigint[]): void {
    if (typeof schema === "string") {
      if (isUnsignedInt(schema)) {
        if (typeof value !== "bigint" && typeof value !== "number") {
          throw new Error(`alkabi legacy: expected ${schema}, got ${typeof value}`);
        }
        out.push(BigInt(value));
        return;
      }
      if (schema === "bool") {
        out.push(value ? 1n : 0n);
        return;
      }
      if (schema === "string") {
        if (typeof value !== "string") {
          throw new Error(`alkabi legacy: expected string, got ${typeof value}`);
        }
        // NUL-terminated: the decoder scans LE bytes until the first 0.
        const utf8 = new TextEncoder().encode(value);
        if (utf8.includes(0)) {
          throw new Error("alkabi legacy: strings cannot contain NUL bytes");
        }
        const terminated = new Uint8Array(utf8.length + 1);
        terminated.set(utf8);
        out.push(...bytesToWords(terminated));
        return;
      }
      throw new Error(`alkabi legacy: unsupported primitive "${schema}"`);
    }

    if ("$ref" in schema) {
      const resolved = this.types[schema.$ref];
      if (!resolved) {
        throw new Error(`alkabi legacy: $ref "${schema.$ref}" not found`);
      }
      this.encode(resolved, value, out);
      return;
    }

    if ("struct" in schema) {
      if (typeof value !== "object" || value === null) {
        throw new Error("alkabi legacy: expected an object for struct");
      }
      for (const [name, field] of Object.entries(schema.struct)) {
        if (!(name in (value as Record<string, unknown>))) {
          throw new Error(`alkabi legacy: missing struct field "${name}"`);
        }
        this.encode(field, (value as Record<string, unknown>)[name], out);
      }
      return;
    }

    if ("array" in schema) {
      if (!Array.isArray(value)) {
        throw new Error("alkabi legacy: expected an array");
      }
      if (schema.array.len != null) {
        if (value.length !== schema.array.len) {
          throw new Error(
            `alkabi legacy: fixed array expects ${schema.array.len} elements, got ${value.length}`,
          );
        }
      } else {
        out.push(BigInt(value.length)); // Vec: length-prefixed with a full word
      }
      for (const element of value) {
        this.encode(schema.array.type, element, out);
      }
      return;
    }

    throw new Error(
      `alkabi legacy: schema not supported in legacy mode: ${JSON.stringify(schema)}`,
    );
  }
}

export class RawCodec<T = unknown> {
  declare readonly _type: T;

  constructor(
    private readonly schema: AlkabiSchemaDef,
    private readonly types: AlkabiTypes,
  ) {}

  decodeReturn(bytes: Uint8Array): T {
    const cursor = { offset: 0 };
    const value = this.read(this.schema, bytes, cursor, true);
    return value as T;
  }

  private read(
    schema: AlkabiSchemaDef,
    buf: Uint8Array,
    cursor: { offset: number },
    isTail: boolean,
  ): unknown {
    if (typeof schema === "string") {
      if (isUnsignedInt(schema)) {
        const width = INT_WIDTHS[schema];
        if (cursor.offset + width > buf.length) {
          throw new Error(
            `alkabi raw: buffer too short for ${schema} (need ${width} bytes at offset ${cursor.offset}, have ${buf.length})`,
          );
        }
        let n = 0n;
        for (let i = 0; i < width; i++) {
          n |= BigInt(buf[cursor.offset + i]) << (8n * BigInt(i));
        }
        cursor.offset += width;
        return width <= 4 ? Number(n) : n;
      }
      if (schema === "bool") {
        if (cursor.offset >= buf.length) {
          throw new Error("alkabi raw: buffer too short for bool");
        }
        return buf[cursor.offset++] !== 0;
      }
      if (schema === "string") {
        if (!isTail) {
          throw new Error(
            "alkabi raw: variable-width string only supported as the final field",
          );
        }
        const text = new TextDecoder().decode(buf.subarray(cursor.offset));
        cursor.offset = buf.length;
        return text;
      }
      throw new Error(`alkabi raw: unsupported primitive "${schema}"`);
    }

    if ("$ref" in schema) {
      const resolved = this.types[schema.$ref];
      if (!resolved) {
        throw new Error(`alkabi raw: $ref "${schema.$ref}" not found`);
      }
      return this.read(resolved, buf, cursor, isTail);
    }

    if ("struct" in schema) {
      const fields = Object.entries(schema.struct);
      const out: Record<string, unknown> = {};
      for (let i = 0; i < fields.length; i++) {
        const [name, field] = fields[i];
        out[name] = this.read(
          field,
          buf,
          cursor,
          isTail && i === fields.length - 1,
        );
      }
      return out;
    }

    if ("array" in schema) {
      if (schema.array.len != null) {
        const out: unknown[] = [];
        for (let i = 0; i < schema.array.len; i++) {
          out.push(this.read(schema.array.type, buf, cursor, false));
        }
        return out;
      }
      // Length-less array in raw mode = "the remaining bytes".
      if (schema.array.type !== "u8") {
        throw new Error(
          "alkabi raw: only Vec<u8> (remaining bytes) is supported for raw arrays",
        );
      }
      if (!isTail) {
        throw new Error(
          "alkabi raw: remaining-bytes array only supported as the final field",
        );
      }
      const rest = buf.subarray(cursor.offset);
      cursor.offset = buf.length;
      return rest;
    }

    throw new Error(
      `alkabi raw: schema not supported in raw mode: ${JSON.stringify(schema)}`,
    );
  }
}
