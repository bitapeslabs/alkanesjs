/*
  Pure fee arithmetic for a 2-transaction CPFP package. Kept free of any
  imports so it can be unit tested (and reasoned about) without spinning up
  bitcoinjs / the alkanes runtime.
*/

/*
  Bitcoin Core v30 lowered the default minrelaytxfee, so 0.2 sat/vB is a real
  relayable rate. This is deliberately NOT clamped up to 1: a CPFP parent is
  supposed to pay as close to the floor as possible and let the child buy the
  whole package's priority.

  Operational caveat: nodes on pre-v30 defaults (1 sat/vB) or a mempool whose
  DYNAMIC minimum has risen above this reject the parent outright, and since
  the pair is broadcast sequentially (no submitpackage), a rejected parent
  orphans the child. Callers broadcasting through such nodes should raise the
  parent rate via `CpfpPackageParams.parentFeeRate` / `BuildSwapParams.
  parentFeeRate`; wallet-side, the broadcast loop must abort on the parent's
  failure so the child is never sent alone.
*/
export const MIN_RELAY_FEE_RATE = 0.2;

export type CpfpFeeInputs = {
  parentFee: number;
  parentVsize: number;
  childVsize: number;
  /** the rate the whole package should achieve (sat/vB) */
  packageFeeRate: number;
};

export type CpfpFeeResult = {
  childFee: number;
  parentRate: number;
  childRate: number;
  packageRate: number;
  effectivePackageRate: number;
  targetPackageFee: number;
};

/**
 * Fee arithmetic for a 2-tx CPFP package.
 *
 * The naive `childFee = packageFee - parentFee` inverts when the parent
 * already pays above the requested package rate, producing a child rate BELOW
 * the parent's. Taking the max of the per-child-vsize fee and the package
 * deficit, against an effective rate floored at the parent's own rate, keeps
 * the invariant `childRate >= packageRate >= parentRate`.
 */
export function computeCpfpChildFee({
  parentFee,
  parentVsize,
  childVsize,
  packageFeeRate,
}: CpfpFeeInputs): CpfpFeeResult {
  if (parentVsize <= 0 || childVsize <= 0) {
    throw new Error("CPFP vsizes must be positive");
  }

  const parentRate = parentFee / parentVsize;
  const effectivePackageRate = Math.max(packageFeeRate, parentRate);
  const targetPackageFee = Math.ceil(
    effectivePackageRate * (parentVsize + childVsize),
  );
  const childFee = Math.max(
    Math.ceil(childVsize * effectivePackageRate),
    targetPackageFee - parentFee,
  );

  return {
    childFee,
    parentRate,
    childRate: childFee / childVsize,
    packageRate: (parentFee + childFee) / (parentVsize + childVsize),
    effectivePackageRate,
    targetPackageFee,
  };
}
