/*
  Constant-product quote math for the Oyl AMM pools. Pure bigint arithmetic,
  floor division everywhere, fee expressed per 1000 (the pool's opcode 20,
  default 10 == 1.0%). Kept free of imports so it is trivially unit-testable.
*/

export interface QuoteExactInParams {
  amountIn: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
  /** pool fee per 1000 (10 == 1.0%) */
  feePer1000: bigint;
}

export interface QuoteExactOutParams {
  amountOut: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
  /** pool fee per 1000 (10 == 1.0%) */
  feePer1000: bigint;
}

const assertReserves = (reserveIn: bigint, reserveOut: bigint) => {
  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new Error("AMM quote: reserves must be positive");
  }
};

const assertFee = (feePer1000: bigint) => {
  if (feePer1000 < 0n || feePer1000 >= 1000n) {
    throw new Error("AMM quote: feePer1000 must be in [0, 1000)");
  }
};

/**
 * How much of the OUT token a swap of `amountIn` receives.
 *
 * `amountOut = ((1000 - f) * amountIn * reserveOut) /
 *              (1000 * reserveIn + (1000 - f) * amountIn)`
 */
export function quoteExactIn({
  amountIn,
  reserveIn,
  reserveOut,
  feePer1000,
}: QuoteExactInParams): bigint {
  assertFee(feePer1000);
  assertReserves(reserveIn, reserveOut);
  if (amountIn <= 0n) return 0n;

  const net = 1000n - feePer1000;
  const numerator = net * amountIn * reserveOut;
  const denominator = 1000n * reserveIn + net * amountIn;

  return numerator / denominator;
}

/**
 * How much of the IN token is required to receive exactly `amountOut`.
 *
 * `amountIn = (1000 * reserveIn * amountOut) /
 *             ((1000 - f) * (reserveOut - amountOut)) + 1`
 *
 * The trailing `+ 1` is the usual floor-division correction, so this is a
 * (slightly) conservative overestimate of the true requirement.
 */
export function quoteExactOut({
  amountOut,
  reserveIn,
  reserveOut,
  feePer1000,
}: QuoteExactOutParams): bigint {
  assertFee(feePer1000);
  assertReserves(reserveIn, reserveOut);
  if (amountOut <= 0n) return 0n;
  if (amountOut >= reserveOut) {
    throw new Error(
      "AMM quote: amountOut must be strictly below the out-side reserve",
    );
  }

  const net = 1000n - feePer1000;
  const numerator = 1000n * reserveIn * amountOut;
  const denominator = net * (reserveOut - amountOut);

  return numerator / denominator + 1n;
}

/**
 * The `amount_out_min` to put in the swap cellpack: `amountOut` reduced by
 * `slippageBps` basis points, floored.
 */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error("applySlippage: slippageBps must be an integer in [0, 10000]");
  }
  if (amountOut <= 0n) return 0n;

  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}
