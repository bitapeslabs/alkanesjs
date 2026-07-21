/*
  Pure helpers for AlkaneId values and for the argument encodings the alkanes
  contracts expect. Nothing here touches the network, so it is all directly
  unit-testable.
*/

import type { AlkaneId } from "@/apis";

/** `"block:tx"` — the key shape used by espo, FormattedUtxo.alkanes and the wallet. */
export const alkaneIdKey = (id: AlkaneId): string => `${id.block}:${id.tx}`;

/** Parse a `"block:tx"` key back into an AlkaneId. Throws on a malformed key. */
export function parseAlkaneId(key: string): AlkaneId {
  const [block, tx] = key.split(":");
  if (block === undefined || tx === undefined || block === "" || tx === "") {
    throw new Error(`Malformed alkane id: ${key}`);
  }
  return { block: BigInt(block), tx: BigInt(tx) };
}

export const alkaneIdsEqual = (a: AlkaneId, b: AlkaneId): boolean =>
  a.block === b.block && a.tx === b.tx;

/** Ordering used by the AMM to canonicalise a pair: block first, then tx. */
export function compareAlkaneIds(a: AlkaneId, b: AlkaneId): number {
  if (a.block !== b.block) return a.block < b.block ? -1 : 1;
  if (a.tx !== b.tx) return a.tx < b.tx ? -1 : 1;
  return 0;
}

/** The pair in canonical (sorted) order, i.e. `[token0, token1]`. */
export function sortAlkaneIds(a: AlkaneId, b: AlkaneId): [AlkaneId, AlkaneId] {
  return compareAlkaneIds(a, b) <= 0 ? [a, b] : [b, a];
}

/**
 * `Vec<AlkaneId>` as the alkanes cellpack ABI encodes it: ONE length word
 * holding the COUNT OF IDS (not the count of words), then two words per id in
 * `block, tx` order.
 *
 * `[{block: 2n, tx: 5n}, {block: 32n, tx: 0n}]` -> `[2n, 2n, 5n, 32n, 0n]`
 */
export function encodeAlkaneIdVec(ids: AlkaneId[]): bigint[] {
  const out: bigint[] = [BigInt(ids.length)];
  for (const id of ids) {
    out.push(id.block, id.tx);
  }
  return out;
}

/** Read `count * (block LE u128 || tx LE u128)` out of a decoded u128 word array. */
export function decodeAlkaneIdVec(words: bigint[]): AlkaneId[] {
  if (words.length === 0) return [];
  const count = Number(words[0]);
  const ids: AlkaneId[] = [];
  for (let i = 0; i < count; i++) {
    const block = words[1 + i * 2];
    const tx = words[2 + i * 2];
    if (block === undefined || tx === undefined) break;
    ids.push({ block, tx });
  }
  return ids;
}

/** Little-endian u128 read out of a byte buffer. */
export function readU128LE(bytes: Uint8Array, offset: number): bigint {
  let n = 0n;
  for (let i = 0; i < 16; i++) {
    n |= BigInt(bytes[offset + i] ?? 0) << (8n * BigInt(i));
  }
  return n;
}
