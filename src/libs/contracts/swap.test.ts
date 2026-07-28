import { describe, test, expect } from "bun:test";
import { buildSwapOptions } from "./swap";
import {
  buildSwapCallData,
  buildSwapExactInCallData,
  buildSwapExactOutCallData,
} from "./amm";

const FACTORY = { block: 4n, tx: 65522n };
const SELL = { block: 2n, tx: 5n };
const BUY = { block: 32n, tx: 0n };
const ASSET_ADDRESS = "bcrt1qexampleassetaddress";

const base = {
  factoryId: FACTORY,
  sellId: SELL,
  buyId: BUY,
  deadline: 0n,
  assetAddress: ASSET_ADDRESS,
};

describe("buildSwapOptions exact-in (the default)", () => {
  test("omitting mode emits the opcode 13 cellpack with the FULL path", () => {
    const options = buildSwapOptions({
      ...base,
      sellAmount: 5_000n,
      minAmountOut: 900n,
    });
    expect(options.protostones?.[1].calldata).toEqual(
      buildSwapExactInCallData(FACTORY, {
        path: [SELL, BUY],
        amountIn: 5_000n,
        amountOutMin: 900n,
        deadline: 0n,
      }),
    );
  });

  test("implicitInput emits opcode 29 with the REMAINING hops only", () => {
    const options = buildSwapOptions({
      ...base,
      sellAmount: 5_000n,
      minAmountOut: 900n,
      implicitInput: true,
    });
    expect(options.protostones?.[1].calldata).toEqual(
      buildSwapCallData(FACTORY, {
        path: [BUY],
        amountOutMin: 900n,
        deadline: 0n,
      }),
    );
  });

  test("a multi-hop path is carried whole through opcode 13", () => {
    const MID = { block: 2n, tx: 9n };
    const options = buildSwapOptions({
      ...base,
      sellAmount: 5_000n,
      minAmountOut: 900n,
      path: [SELL, MID, BUY],
    });
    expect(options.protostones?.[1].calldata).toEqual(
      buildSwapExactInCallData(FACTORY, {
        path: [SELL, MID, BUY],
        amountIn: 5_000n,
        amountOutMin: 900n,
        deadline: 0n,
      }),
    );
  });

  test("a path that does not span sell -> buy is rejected", () => {
    const MID = { block: 2n, tx: 9n };
    expect(() =>
      buildSwapOptions({
        ...base,
        sellAmount: 5_000n,
        minAmountOut: 900n,
        path: [MID, BUY],
      }),
    ).toThrow();
  });

  test("mode: exactIn is byte-identical to omitting mode", () => {
    const implicit = buildSwapOptions({
      ...base,
      sellAmount: 5_000n,
      minAmountOut: 900n,
    });
    const explicit = buildSwapOptions({
      ...base,
      sellAmount: 5_000n,
      minAmountOut: 900n,
      mode: "exactIn",
    });
    expect(explicit).toEqual(implicit);
  });
});

describe("buildSwapOptions exact-out", () => {
  const options = buildSwapOptions({
    ...base,
    sellAmount: 5_000n, //reinterpreted as amount_in_max
    minAmountOut: 900n, //reinterpreted as the exact amount_out
    mode: "exactOut",
  });

  test("the message carries the opcode 14 cellpack with the FULL path", () => {
    expect(options.protostones?.[1].calldata).toEqual(
      buildSwapExactOutCallData(FACTORY, {
        path: [SELL, BUY],
        amountOut: 900n,
        amountInMax: 5_000n,
        deadline: 0n,
      }),
    );
  });

  test("path[0] is the sell token, which opcode 29 would have omitted", () => {
    const words = options.protostones?.[1].calldata ?? [];
    //[factory.block, factory.tx, 14, path_len, sell.block, sell.tx, ...]
    expect(words[2]).toBe(14n);
    expect(words[3]).toBe(2n);
    expect(words[4]).toBe(SELL.block);
    expect(words[5]).toBe(SELL.tx);
  });

  /*
    The ceiling is what must be ATTACHED: the factory's _return_leftovers sweeps
    whatever it did not consume back through the message pointer.
  */
  test("the shifter attaches amount_in_max, not the exact-out amount", () => {
    expect(options.protostones?.[0].edicts?.[0].amount).toBe(5_000n);
    expect(options.transfers?.[0].amount).toBe(5_000n);
  });

  test("a non-positive requested output is rejected", () => {
    expect(() =>
      buildSwapOptions({
        ...base,
        sellAmount: 5_000n,
        minAmountOut: 0n,
        mode: "exactOut",
      }),
    ).toThrow();
  });

  test("a zero ceiling is still rejected", () => {
    expect(() =>
      buildSwapOptions({
        ...base,
        sellAmount: 0n,
        minAmountOut: 900n,
        mode: "exactOut",
      }),
    ).toThrow();
  });

  test("the same token on both sides is still rejected", () => {
    expect(() =>
      buildSwapOptions({
        ...base,
        buyId: SELL,
        sellAmount: 5_000n,
        minAmountOut: 900n,
        mode: "exactOut",
      }),
    ).toThrow();
  });
});
