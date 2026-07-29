# `alkanesjs/boxed` — result handling

```ts
import { consumeOrThrow, isBoxedError } from "alkanesjs/boxed";
```

Fallible SDK operations return a `BoxedResponse<T, E>` instead of throwing: a
union of success (`{ status: true, data }`) and error
(`{ status: false, errorType, message }`). The point is that failure is a
*value* — it can be inspected, logged, or deliberately ignored without a
try/catch at every call site.

## The two you will actually use

```ts
import { consumeOrThrow, isBoxedError } from "alkanesjs/boxed";

// Throw at the call site if it failed — the "just give me the value" path
const { balances } = consumeOrThrow(
  await provider.rpc.espo.getAddressBalances(addr),
);

// Branch on failure without throwing
const result = await tx.simulate();
if (isBoxedError(result.calls[0])) {
  console.log("first call reverted:", result.calls[0].message);
}
```

`isBoxedError` is duck-typed (`status === false`), so it is safe on a boxed
value no matter which entry produced it.

## The rest of the surface

| Export | What it does |
| --- | --- |
| `BoxedSuccess` / `BoxedError` | construct results (mostly for SDK-shaped APIs of your own) |
| `Ok` / `Err` / `isOk` / `isErr` | bxrs aliases for the same |
| `consumeOrNull(r)` | value or `null`, never throws |
| `consumeOrCallback(r, cb)` | value, or hand the error to `cb` |
| `consumeAll([...])` | all values, or the first error |
| `retryOnBoxedError(opts)(fn)` | retry a boxed-returning function on failure |
| `BoxedPromise` | a thenable over `Promise<BoxedResponse>` with the same combinators |

## Where you meet boxes vs. where the SDK unwraps for you

The **fluent surfaces unwrap themselves**: `contract.getName().unwrap()`,
`tx.build().send()`, `deploy…waitForDeployment()` — these throw on failure,
and you never see the box. Boxes appear at the *data* surfaces:

- `provider.rpc.*` — every raw RPC method
- `TxOutcome.calls` / `.result` — per-call outcomes of a simulation, boxed so
  one reverted call does not throw away the others
- `alkanesjs/utils/frbtc` lookups

Rule of thumb: if you chained it, it throws; if you fetched it, it is boxed.
