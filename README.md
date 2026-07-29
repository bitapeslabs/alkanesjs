# alkanesjs

A TypeScript SDK for the [alkanes](https://alkanes.build) metaprotocol on
Bitcoin: deploy contracts, call them through typed ABI documents, build
protostone transactions (including dependent CPFP packages), and read back
what they did. Small bundle, strict types, no oyl/sdk dependency — execute,
simulate and trace are implemented here.

```ts
import { Account, AlkaneId, Contract, Provider, bitcoin } from "alkanesjs";

const provider = new Provider({
  metashrewUrl: "https://kirby.alkanode.com/rpc",
  espoUrl: "https://api.alkanode.com/rpc",
  network: bitcoin.networks.bitcoin,
  explorerUrl: "https://mempool.space",
  defaultFeeRate: 3,
});

const me = Account.fromWIF(WIF, provider);
const token = new Contract(MyTokenAbi, AlkaneId.fromString("2:123"), provider);

const name = await token.getName().unwrap();          // a view — simulated

await me                                              // a state change
  .tx()
  .call(token, "mint", { amount: 5n })
  .build()
  .send()
  .waitForConfirmation();
```

## Entries

The root entry is the 90% path — `Provider`, `Account`, `Contract`,
`AlkaneId`, `Amount`, `bitcoin`. Everything else lives in an entry named
after its purpose:

| Import from | For |
| --- | --- |
| `alkanesjs` | connecting, signing, calling, deploying |
| `alkanesjs/boxed` | result handling: `consumeOrThrow`, `isBoxedError`, … |
| `alkanesjs/traces` | decoding what protostones did |
| `alkanesjs/abi` | alkabi documents: overrides, local wasm views |
| `alkanesjs/utils/amm` | constant-product pool math |
| `alkanesjs/utils/frbtc` | frBTC premium math + live signer lookup |
| `alkanesjs/wallets` | browser wallet connectors (SSR-safe) |
| `alkanesjs/debug` | wire-level request logging |

alkanesjs defines **no contracts** — no hardcoded ids, ABIs or opcode
tables. You bring the ABI document your contract's build emitted; the SDK
brings the machinery.

## Documentation

[docs/README.md](./docs/README.md) is the index. Highlights:

- [core.md](./docs/core.md) — Provider, accounts, contracts, deployment, ids, amounts
- [transactions.md](./docs/transactions.md) — the builder: transfers, calls,
  shadow space, chained transactions, CPFP packages
- [conventions.md](./docs/conventions.md) — the wire facts everything assumes

## Building

```
npm i
npm run build
```

Build artifacts land in `dist/` — one CJS + ESM + flattened `.d.ts` triple
per entry. Adding an entry is documented at the bottom of
[docs/README.md](./docs/README.md#adding-an-entry).
