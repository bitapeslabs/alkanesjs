import { describe, test, expect } from "bun:test";
import {
  AMM_FACTORY_OPCODES,
  buildSwapCallData,
  buildSwapExactOutCallData,
  encodeSwapExactOutCallData,
  encodeSwapImplicitCallData,
} from "./amm";

const A = { block: 2n, tx: 5n };
const B = { block: 32n, tx: 0n };
const C = { block: 4n, tx: 77n };
const FACTORY = { block: 4n, tx: 65522n };

describe("encodeSwapExactOutCallData (opcode 14)", () => {
  /*
    Opcodes 13/14 take the FULL path including the input token, so a single hop
    A -> B is `[A, B]` and the length word (the id COUNT) is 2.
  */
  test("a single hop lays out opcode, path, then the three scalars", () => {
    expect(
      encodeSwapExactOutCallData({
        path: [A, B],
        amountOut: 1_000n,
        amountInMax: 9_999n,
        deadline: 0n,
      }),
    ).toEqual([
      14n, //opcode
      2n, //path_len: the COUNT OF IDS, not the word count
      2n,
      5n, //A.block, A.tx
      32n,
      0n, //B.block, B.tx
      1_000n, //amount_out
      9_999n, //amount_in_max
      0n, //deadline
    ]);
  });

  test("the opcode word is the factory's swapTokensForExactTokens", () => {
    const words = encodeSwapExactOutCallData({
      path: [A, B],
      amountOut: 1n,
      amountInMax: 2n,
      deadline: 3n,
    });
    expect(words[0]).toBe(AMM_FACTORY_OPCODES.swapTokensForExactTokens);
    expect(words[0]).toBe(14n);
  });

  test("amount_out precedes amount_in_max, not the other way round", () => {
    const words = encodeSwapExactOutCallData({
      path: [A, B],
      amountOut: 111n,
      amountInMax: 222n,
      deadline: 333n,
    });
    expect(words.slice(-3)).toEqual([111n, 222n, 333n]);
  });

  test("a two hop path carries a length word of 3 and six id words", () => {
    const words = encodeSwapExactOutCallData({
      path: [A, B, C],
      amountOut: 7n,
      amountInMax: 8n,
      deadline: 9n,
    });
    expect(words[0]).toBe(14n);
    expect(words[1]).toBe(3n);
    expect(words.slice(2, 8)).toEqual([2n, 5n, 32n, 0n, 4n, 77n]);
    expect(words.slice(8)).toEqual([7n, 8n, 9n]);
    expect(words.length).toBe(11); // 1 opcode + 1 len + 6 id words + 3 scalars
  });

  test("a deadline is passed through verbatim as a block height", () => {
    const words = encodeSwapExactOutCallData({
      path: [A, B],
      amountOut: 1n,
      amountInMax: 2n,
      deadline: 900_000n,
    });
    expect(words[words.length - 1]).toBe(900_000n);
  });

  test("u128-scale amounts survive intact", () => {
    const big = (1n << 100n) + 7n;
    const words = encodeSwapExactOutCallData({
      path: [A, B],
      amountOut: big,
      amountInMax: big + 1n,
      deadline: 0n,
    });
    expect(words.slice(-3)).toEqual([big, big + 1n, 0n]);
  });
});

describe("buildSwapExactOutCallData", () => {
  test("prepends the factory block and tx to the encoded call", () => {
    const args = {
      path: [A, B],
      amountOut: 1_000n,
      amountInMax: 9_999n,
      deadline: 0n,
    };
    expect(buildSwapExactOutCallData(FACTORY, args)).toEqual([
      FACTORY.block,
      FACTORY.tx,
      ...encodeSwapExactOutCallData(args),
    ]);
  });

  test("the full single hop cellpack reads block, tx, 14, path, scalars", () => {
    expect(
      buildSwapExactOutCallData(FACTORY, {
        path: [A, B],
        amountOut: 1_000n,
        amountInMax: 9_999n,
        deadline: 0n,
      }),
    ).toEqual([
      4n,
      65522n, //factory
      14n,
      2n, //opcode, path_len
      2n,
      5n,
      32n,
      0n, //A, B
      1_000n,
      9_999n,
      0n,
    ]);
  });
});

describe("encodeSwapImplicitCallData (opcode 29) is unchanged", () => {
  /*
    Regression guard: the wallet's existing exact-IN path goes through opcode
    29, which names only the REMAINING hops and takes amount_out_min BEFORE the
    deadline with no third scalar.
  */
  test("a single hop names only the buy id", () => {
    expect(
      encodeSwapImplicitCallData({
        path: [B],
        amountOutMin: 1_000n,
        deadline: 0n,
      }),
    ).toEqual([29n, 1n, 32n, 0n, 1_000n, 0n]);
  });

  test("the opcode is still swapExactTokensForTokensImplicit", () => {
    expect(AMM_FACTORY_OPCODES.swapExactTokensForTokensImplicit).toBe(29n);
  });

  test("buildSwapCallData still prepends the factory prefix", () => {
    expect(
      buildSwapCallData(FACTORY, {
        path: [B],
        amountOutMin: 1_000n,
        deadline: 0n,
      }),
    ).toEqual([4n, 65522n, 29n, 1n, 32n, 0n, 1_000n, 0n]);
  });

  test("the two encoders disagree on both opcode and path length", () => {
    const implicit = encodeSwapImplicitCallData({
      path: [B],
      amountOutMin: 1n,
      deadline: 0n,
    });
    const exactOut = encodeSwapExactOutCallData({
      path: [A, B],
      amountOut: 1n,
      amountInMax: 2n,
      deadline: 0n,
    });
    expect(implicit[0]).toBe(29n);
    expect(exactOut[0]).toBe(14n);
    expect(implicit[1]).toBe(1n);
    expect(exactOut[1]).toBe(2n);
  });
});
