# `alkanesjs/traces` — reading what protostones did

```ts
import { decodeTrace, extractAbiErrorMessage } from "alkanesjs/traces";
import type { AlkanesTraceResult, AlkanesTraceEncodedResult } from "alkanesjs/traces";
```

A trace is the indexer's record of one protostone's execution. It is a
**flat list in execution order**, not a tree: `invoke` opens a frame,
`return` closes it, and nesting is reconstructed by balance. The last
`return` of a balanced trace is the outermost exit — it carries the
returndata, and on failure, the revert reason.

Everything in this entry is pure decoding. The traces themselves come from
the core entry:

| Source | Shape |
| --- | --- |
| `TxOutcome.trace` (a simulation) | already decoded |
| `TxOutcome.traces` | encoded — espo's own JSON, values still `0x` hex |
| `provider.rpc.alkanes.alkanes_trace(txid, vout)` | encoded, from the chain |
| `provider.rpc.espo.getAlkaneTxSummary(txid)` | encoded, per outpoint |

## Decoding

`decodeTrace` turns encoded events into typed ones — ids parsed, amounts
`bigint`:

```ts
const { traces } = consumeOrThrow(
  await provider.rpc.espo.getAlkaneTxSummary(txid),
);

for (const { outpoint, events } of traces) {
  const decoded = decodeTrace(events as AlkanesTraceEncodedResult);
  const exit = decoded.findLast((e) => e.event === "return");
  if (exit?.event === "return" && exit.data.status !== "success") {
    const raw = exit.data.response.data;
    console.log(`${outpoint} reverted: ${extractAbiErrorMessage(raw) ?? raw}`);
  }
}
```

## Revert reasons

A revert's reason travels in the returndata behind the `08c379a0` selector
(the Solidity `Error(string)` convention, reused by alkanes).
`extractAbiErrorMessage` peels it; it returns `null` for data that is not an
error payload, so `?? raw` is the usual fallback.

## Why you read traces at all

**Mined is not succeeded.** A transaction whose protostone reverted confirms
like any other — the BTC moved, the alkanes did not. Balance checks tell you
*that* nothing happened; the trace tells you *why*:

```
TORTILLA ADMIN PROXY: transfer of admin alkane id not found
```

Where a shadow vout number is needed (`alkanes_trace`), remember the wire
formula: the trace of call *n* files under `real_outputs + 1 + n`. Prefer the
sources that already file traces per outpoint (`getAlkaneTxSummary`,
`TxOutcome.trace`) and you never compute it.
