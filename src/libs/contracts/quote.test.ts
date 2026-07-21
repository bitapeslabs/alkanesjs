import { describe, test, expect } from "bun:test";
import { quoteExactIn, quoteExactOut, applySlippage } from "./quote";

/*
  Hand-computed reference values.

  reserveIn = 1_000_000, reserveOut = 2_000_000, fee = 10/1000:
    net       = 990
    amountOut = (990 * 10_000 * 2_000_000) / (1000 * 1_000_000 + 990 * 10_000)
              = 19_800_000_000_000 / 1_009_900_000
              = 19_605  (floored, exact value 19_605.90…)
*/
describe("quoteExactIn", () => {
  test("constant product with a 1% fee", () => {
    expect(
      quoteExactIn({
        amountIn: 10_000n,
        reserveIn: 1_000_000n,
        reserveOut: 2_000_000n,
        feePer1000: 10n,
      }),
    ).toBe(19_605n);
  });

  test("a zero fee is the plain constant product", () => {
    /* (1000 * 1000 * 1_000_000) / (1000 * 1_000_000 + 1000 * 1000) = 999.00… */
    expect(
      quoteExactIn({
        amountIn: 1_000n,
        reserveIn: 1_000_000n,
        reserveOut: 1_000_000n,
        feePer1000: 0n,
      }),
    ).toBe(999n);
  });

  test("a large trade against a deep pool", () => {
    expect(
      quoteExactIn({
        amountIn: 123_456_789n,
        reserveIn: 10_000_000_000n,
        reserveOut: 25_000_000_000n,
        feePer1000: 10n,
      }),
    ).toBe(301_866_078n);
  });

  test("the fee strictly reduces the output", () => {
    const args = {
      amountIn: 10_000n,
      reserveIn: 1_000_000n,
      reserveOut: 2_000_000n,
    };
    const free = quoteExactIn({ ...args, feePer1000: 0n });
    const taxed = quoteExactIn({ ...args, feePer1000: 10n });
    expect(taxed < free).toBe(true);
  });

  test("a zero or negative input quotes zero", () => {
    const args = {
      reserveIn: 1_000_000n,
      reserveOut: 2_000_000n,
      feePer1000: 10n,
    };
    expect(quoteExactIn({ ...args, amountIn: 0n })).toBe(0n);
    expect(quoteExactIn({ ...args, amountIn: -5n })).toBe(0n);
  });

  test("empty reserves and out-of-range fees are rejected", () => {
    expect(() =>
      quoteExactIn({
        amountIn: 1n,
        reserveIn: 0n,
        reserveOut: 2_000_000n,
        feePer1000: 10n,
      }),
    ).toThrow();
    expect(() =>
      quoteExactIn({
        amountIn: 1n,
        reserveIn: 1_000_000n,
        reserveOut: 2_000_000n,
        feePer1000: 1000n,
      }),
    ).toThrow();
  });
});

/*
  reserveIn = 1_000_000, reserveOut = 2_000_000, fee = 10/1000, out = 19_605:
    amountIn = (1000 * 1_000_000 * 19_605) / (990 * (2_000_000 - 19_605)) + 1
             = 19_605_000_000_000 / 1_960_591_050 + 1
             = 9_999 + 1
             = 10_000
*/
describe("quoteExactOut", () => {
  test("inverts the constant product with a 1% fee", () => {
    expect(
      quoteExactOut({
        amountOut: 19_605n,
        reserveIn: 1_000_000n,
        reserveOut: 2_000_000n,
        feePer1000: 10n,
      }),
    ).toBe(10_000n);
  });

  test("a zero output requires no input", () => {
    expect(
      quoteExactOut({
        amountOut: 0n,
        reserveIn: 1_000_000n,
        reserveOut: 2_000_000n,
        feePer1000: 10n,
      }),
    ).toBe(0n);
  });

  test("draining the out-side reserve is impossible", () => {
    expect(() =>
      quoteExactOut({
        amountOut: 2_000_000n,
        reserveIn: 1_000_000n,
        reserveOut: 2_000_000n,
        feePer1000: 10n,
      }),
    ).toThrow();
  });

  /*
    Round-trip sanity: pricing the floored output of an exact-in quote back
    into an exact-out quote must never ask for MORE than the original input.
    Both quotes floor, and quoteExactOut adds the usual +1, so equality is the
    expected outcome rather than a strict inequality.
  */
  test("round trips back to at most the original input", () => {
    const pools = [
      { reserveIn: 1_000_000n, reserveOut: 2_000_000n, feePer1000: 10n },
      { reserveIn: 10_000_000_000n, reserveOut: 25_000_000_000n, feePer1000: 10n },
      { reserveIn: 777_777n, reserveOut: 3_141_592n, feePer1000: 3n },
      { reserveIn: 1_000_000n, reserveOut: 1_000_000n, feePer1000: 0n },
    ];
    const inputs = [1n, 7n, 1_000n, 10_000n, 123_456_789n, 500_000n];

    for (const pool of pools) {
      for (const amountIn of inputs) {
        const amountOut = quoteExactIn({ ...pool, amountIn });
        if (amountOut <= 0n) continue;
        const required = quoteExactOut({ ...pool, amountOut });
        expect(required <= amountIn).toBe(true);
      }
    }
  });
});

describe("applySlippage", () => {
  test("basis points come off the quote", () => {
    expect(applySlippage(19_605n, 50)).toBe(19_506n); // 0.50%
    expect(applySlippage(1_000_000n, 100)).toBe(990_000n); // 1.00%
  });

  test("zero slippage is the identity", () => {
    expect(applySlippage(19_605n, 0)).toBe(19_605n);
  });

  test("full slippage floors to zero", () => {
    expect(applySlippage(19_605n, 10_000)).toBe(0n);
  });

  test("the result is floored, never rounded up", () => {
    /* 101 * 9999 / 10000 = 100.9899 -> 100 */
    expect(applySlippage(101n, 1)).toBe(100n);
  });

  test("a non-positive quote stays zero", () => {
    expect(applySlippage(0n, 50)).toBe(0n);
    expect(applySlippage(-1n, 50)).toBe(0n);
  });

  test("out-of-range basis points are rejected", () => {
    expect(() => applySlippage(100n, -1)).toThrow();
    expect(() => applySlippage(100n, 10_001)).toThrow();
    expect(() => applySlippage(100n, 1.5)).toThrow();
  });
});
