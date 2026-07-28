import { describe, test, expect } from "bun:test";
import {
  alkaneIdKey,
  parseAlkaneId,
  alkaneIdsEqual,
  compareAlkaneIds,
  sortAlkaneIds,
  encodeAlkaneIdVec,
  decodeAlkaneIdVec,
  readU128LE,
} from "./alkane-id";

describe("encodeAlkaneIdVec", () => {
  /*
    The cellpack ABI writes ONE length word holding the COUNT OF IDS (not the
    number of u128 words that follow), then two words per id, block first.
  */
  test("the length word is the id COUNT, not the word count", () => {
    const words = encodeAlkaneIdVec([
      { block: 2n, tx: 5n },
      { block: 32n, tx: 0n },
    ]);
    expect(words[0]).toBe(2n);
    expect(words.length).toBe(5); // 1 length word + 2 ids * 2 words
  });

  test("each id contributes exactly two words in block, tx order", () => {
    expect(
      encodeAlkaneIdVec([
        { block: 2n, tx: 5n },
        { block: 32n, tx: 0n },
      ]),
    ).toEqual([2n, 2n, 5n, 32n, 0n]);
  });

  test("a single hop is one length word plus one id", () => {
    expect(encodeAlkaneIdVec([{ block: 4n, tx: 77n }])).toEqual([1n, 4n, 77n]);
  });

  test("an empty path is just a zero length word", () => {
    expect(encodeAlkaneIdVec([])).toEqual([0n]);
  });

  test("big ids survive intact", () => {
    const big = { block: 2n, tx: (1n << 100n) + 7n };
    expect(encodeAlkaneIdVec([big])).toEqual([1n, 2n, (1n << 100n) + 7n]);
  });

  test("decodes back to the same ids", () => {
    const ids = [
      { block: 2n, tx: 5n },
      { block: 32n, tx: 0n },
      { block: 4n, tx: 999n },
    ];
    expect(decodeAlkaneIdVec(encodeAlkaneIdVec(ids))).toEqual(ids);
  });
});

describe("alkane id helpers", () => {
  test("key and parse round trip", () => {
    expect(alkaneIdKey({ block: 32n, tx: 0n })).toBe("32:0");
    expect(parseAlkaneId("32:0")).toEqual({ block: 32n, tx: 0n });
  });

  test("a malformed key throws", () => {
    expect(() => parseAlkaneId("32")).toThrow();
    expect(() => parseAlkaneId("32:")).toThrow();
  });

  test("equality compares both halves", () => {
    expect(alkaneIdsEqual({ block: 2n, tx: 1n }, { block: 2n, tx: 1n })).toBe(true);
    expect(alkaneIdsEqual({ block: 2n, tx: 1n }, { block: 2n, tx: 2n })).toBe(false);
    expect(alkaneIdsEqual({ block: 2n, tx: 1n }, { block: 3n, tx: 1n })).toBe(false);
  });

  test("ordering is block first, then tx", () => {
    expect(compareAlkaneIds({ block: 2n, tx: 9n }, { block: 32n, tx: 0n })).toBe(-1);
    expect(compareAlkaneIds({ block: 2n, tx: 9n }, { block: 2n, tx: 10n })).toBe(-1);
    expect(compareAlkaneIds({ block: 2n, tx: 9n }, { block: 2n, tx: 9n })).toBe(0);
  });

  test("sorting is order-insensitive", () => {
    const a = { block: 32n, tx: 0n };
    const b = { block: 2n, tx: 9n };
    expect(sortAlkaneIds(a, b)).toEqual([b, a]);
    expect(sortAlkaneIds(b, a)).toEqual([b, a]);
  });
});

describe("readU128LE", () => {
  test("reads little endian at an offset", () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 0x20; // 32
    bytes[16] = 0x01;
    bytes[17] = 0x01; // 257
    expect(readU128LE(bytes, 0)).toBe(32n);
    expect(readU128LE(bytes, 16)).toBe(257n);
  });
});
