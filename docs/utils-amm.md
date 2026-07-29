# `alkanesjs/utils/amm` — constant-product math

```ts
import { quoteExactIn, quoteExactOut, applySlippage } from "alkanesjs/utils/amm";
```

Pure bigint arithmetic for constant-product (x·y=k) pools — floor division
everywhere, fee expressed per 1000. No network, no contract, no ids: you
bring the reserves (from your pool's ABI), this prices the trade.

```ts
// what the pool would pay out for a known input
const out = quoteExactIn({
  amountIn,
  reserveIn,       // reserve of the token you sell
  reserveOut,      // reserve of the token you buy
  feePer1000: 10n, // 10 == 1.0%
});

// what input a known output would cost
const cost = quoteExactOut({ amountOut, reserveIn, reserveOut, feePer1000 });

// turn a quote into a slippage floor for the swap's calldata
const minOut = applySlippage(out, 300); // 300 bps == 3%
```

A complete pricing pass against a live pool, everything typed by *your* ABI:

```ts
const pool = new Contract(AMMPoolAbi, POOL_ID, provider);
const [reserves, feePer1000] = await pool
  .bundle()
  .getReserves().unwrap()
  .getTotalFee().unwrap();

const minOut = applySlippage(
  quoteExactIn({ amountIn, reserveIn: reserves._1, reserveOut: reserves._0, feePer1000 }),
  SLIPPAGE_BPS,
);
```

Watch the reserve orientation: `getReserves` answers in the pool's **sorted
token order** (token 0, token 1). `reserveIn` is whichever side you are
selling — flip both when you flip direction.

Alkanesjs ships no AMM contract, no factory id, and no opcode table — those
belong to the deployment you are integrating, via its ABI document.
