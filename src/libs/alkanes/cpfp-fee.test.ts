import { describe, test, expect } from "bun:test";
import {
  MIN_RELAY_FEE_RATE,
  computeCpfpChildFee,
  type CpfpFeeInputs,
} from "./cpfp-fee";

/*
  The whole point of the corrected formula: the child must always end up at or
  above the package rate, and the package must always end up at or above what
  the parent already pays. The naive "childFee = packageFee - parentFee"
  breaks the moment the parent overpays.
*/
const assertInvariant = (params: CpfpFeeInputs) => {
  const result = computeCpfpChildFee(params);

  const parentRate = params.parentFee / params.parentVsize;
  const childRate = result.childFee / params.childVsize;
  const packageRate =
    (params.parentFee + result.childFee) /
    (params.parentVsize + params.childVsize);

  //childRate >= packageRate >= parentRate
  expect(childRate).toBeGreaterThanOrEqual(packageRate - 1e-9);
  expect(packageRate).toBeGreaterThanOrEqual(parentRate - 1e-9);

  //and the package clears the rate that was actually asked for, unless the
  //parent already exceeded it (in which case the parent rate is the floor)
  expect(packageRate).toBeGreaterThanOrEqual(
    Math.max(params.packageFeeRate, parentRate) - 1e-9,
  );

  //reported values agree with what the caller would recompute
  expect(result.parentRate).toBeCloseTo(parentRate, 9);
  expect(result.childRate).toBeCloseTo(childRate, 9);
  expect(result.packageRate).toBeCloseTo(packageRate, 9);

  return { result, parentRate, childRate, packageRate };
};

describe("computeCpfpChildFee", () => {
  test("relay-floor parent bumped to a normal package rate", () => {
    const { childRate, packageRate } = assertInvariant({
      parentFee: Math.ceil(MIN_RELAY_FEE_RATE * 141),
      parentVsize: 141,
      childVsize: 110,
      packageFeeRate: 10,
    });

    expect(packageRate).toBeGreaterThanOrEqual(10);
    expect(childRate).toBeGreaterThan(10);
  });

  test("parent already pays MORE than the requested package rate", () => {
    /*
      parentRate = 5000/200 = 25 sat/vB, well above the 5 sat/vB asked for.
      The effective package rate must be raised to the parent's rate rather
      than the child being handed a sub-parent (or negative) fee.
    */
    const params: CpfpFeeInputs = {
      parentFee: 5000,
      parentVsize: 200,
      childVsize: 150,
      packageFeeRate: 5,
    };

    const { result, parentRate, childRate } = assertInvariant(params);

    expect(result.effectivePackageRate).toBe(parentRate);
    expect(result.childFee).toBeGreaterThan(0);
    //the naive formula would have produced ceil(5 * 350) - 5000 = -3250
    expect(childRate).toBeGreaterThanOrEqual(parentRate - 1e-9);
  });

  test("parent rate exactly equals the package rate", () => {
    const { result, parentRate, childRate } = assertInvariant({
      parentFee: 2000,
      parentVsize: 200,
      childVsize: 200,
      packageFeeRate: 10,
    });

    expect(parentRate).toBe(10);
    expect(childRate).toBeGreaterThanOrEqual(10);
    expect(result.childFee).toBe(2000);
  });

  test("zero-fee parent (pure sponsor child)", () => {
    const { result, packageRate } = assertInvariant({
      parentFee: 0,
      parentVsize: 200,
      childVsize: 150,
      packageFeeRate: 8,
    });

    //the child alone has to carry the whole package
    expect(result.childFee).toBe(Math.ceil(8 * 350));
    expect(packageRate).toBeGreaterThanOrEqual(8);
  });

  test("invariant holds across a sweep", () => {
    const parentFees = [0, 28, 141, 500, 5000, 50_000];
    const parentVsizes = [110, 141, 200, 1500];
    const childVsizes = [110, 154, 400];
    const packageRates = [MIN_RELAY_FEE_RATE, 1, 2.5, 10, 50, 300];

    for (const parentFee of parentFees) {
      for (const parentVsize of parentVsizes) {
        for (const childVsize of childVsizes) {
          for (const packageFeeRate of packageRates) {
            assertInvariant({
              parentFee,
              parentVsize,
              childVsize,
              packageFeeRate,
            });
          }
        }
      }
    }
  });

  test("rejects non-positive vsizes", () => {
    expect(() =>
      computeCpfpChildFee({
        parentFee: 100,
        parentVsize: 0,
        childVsize: 100,
        packageFeeRate: 5,
      }),
    ).toThrow();

    expect(() =>
      computeCpfpChildFee({
        parentFee: 100,
        parentVsize: 100,
        childVsize: 0,
        packageFeeRate: 5,
      }),
    ).toThrow();
  });

  test("MIN_RELAY_FEE_RATE is not clamped up to 1", () => {
    expect(MIN_RELAY_FEE_RATE).toBe(0.2);
  });
});
