# alkanesjs

A TypeScript SDK for the [alkanes](https://alkanes.build) metaprotocol on
Bitcoin: deploy contracts, call them through typed ABI documents, build
protostone transactions (including dependent CPFP packages), and read back
what they did. Small bundle, strict types, no oyl/sdk dependency — execute,
simulate and trace are implemented here.

A whole flow, start to finish — a fresh wallet, funded from the regtest
faucet, minting DIESEL. Copy it and run it:

```ts
import { Account, AlkaneId, Contract, networks } from "alkanesjs";
import { TokenAbi } from "alkanesjs/abis";

const DIESEL = AlkaneId.fromString("2:0");

const me = Account.generate(networks.Regtest);
const diesel = new Contract(TokenAbi, DIESEL, networks.Regtest);

const start = async () => {
  // a brand new wallet has nothing, so ask the regtest faucet for coins
  console.log("Requesting rBTC from faucet to initiate a mint...");
  const faucet = await me.tx().requestFaucet({ amount: 0.1 }).waitForConfirmation();
  console.log(`Faucet TX confirmed: https://regtest.espo.sh/tx/${faucet.txid}`);

  // a view — simulated, nothing broadcast
  const name = await diesel.getName().unwrap();

  // a state change — built, signed, broadcast
  console.log(`Minting ${name}..`);
  const sent = await me.tx().call(diesel, "mintTokens").build().send();
  console.log(`Waiting for TX: https://regtest.espo.sh/tx/${sent.txid}`);

  // confirmed is not succeeded — the traces say what the protostones did
  const done = await sent.waitForConfirmation();
  console.log(done.ok ? done.traces : `reverted: ${done.error}`);
};

start();
```

Everything in it is real: `Account.generate` makes a BIP39 wallet,
`requestFaucet` is regtest-only, `TokenAbi` ships with the package, and
`done.traces` is what the mint's protostone actually did.

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
| `alkanesjs/abis` | shipped ABI documents: Oyl AMM, frBTC, plain tokens |
| `alkanesjs/utils/amm` | constant-product pool math |
| `alkanesjs/utils/frbtc` | frBTC premium math + live signer lookup |
| `alkanesjs/wallets` | browser wallet connectors (SSR-safe) |

alkanesjs binds **no contracts** — no hardcoded ids, no opcode tables in
code. ABI documents for widely-deployed contracts ship as data under
`alkanesjs/abis`; for your own contracts you bring the document the build
emitted, and the SDK brings the machinery either way.

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
