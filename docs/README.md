# alkanesjs documentation

alkanesjs is a TypeScript SDK for the [alkanes](https://alkanes.build)
metaprotocol on Bitcoin: deploying contracts, calling them through typed ABI
documents, building protostone transactions, and reading back what they did.

## The module map

The package is split into entries by *what kind of work you are doing*. The
root is deliberately small — it is the set of things every script needs. Each
entry is importable on its own and documented on its own page:

| Entry                                    | What lives there                                     | Docs                             |
| ---------------------------------------- | ---------------------------------------------------- | -------------------------------- |
| `alkanesjs`                              | `Provider`, `Account`, `Contract`, `AlkaneId`, `Amount`, `bitcoin` | [core.md](./core.md)             |
| `alkanesjs/boxed`                        | result handling: `consumeOrThrow`, `isBoxedError`, …  | [boxed.md](./boxed.md)           |
| `alkanesjs/traces`                       | decoding what protostones did                         | [traces.md](./traces.md)         |
| `alkanesjs/abi`                          | alkabi documents: overrides, local wasm views         | [abi.md](./abi.md)               |
| `alkanesjs/utils/amm`                    | constant-product pool math (pure bigint)              | [utils-amm.md](./utils-amm.md)   |
| `alkanesjs/utils/frbtc`                  | frBTC premium math + live signer lookup               | [utils-frbtc.md](./utils-frbtc.md) |
| `alkanesjs/wallets`                      | browser wallet connectors (SSR-safe, no bitcoinjs)    | —                                |
| `alkanesjs/debug`                        | wire-level request logging                            | —                                |

Two pages cut across the entries:

- [transactions.md](./transactions.md) — the transaction builder: transfers,
  calls, shadow space, chaining transactions, packages. Start here to
  understand what a built transaction *is*.
- [conventions.md](./conventions.md) — the wire facts everything else assumes:
  ids, amounts, cellpacks, shadow vouts, `SchemaAlkaneId`.

## Design rules

The structure follows three rules, and additions should too:

1. **The root is the 90% path.** A script that deploys a contract, calls it,
   and checks a balance imports from `alkanesjs` and nothing else. Anything
   not on that path lives in an entry named after its purpose.
2. **alkanesjs defines no contracts.** No ids, no ABIs, no opcode tables for
   specific deployments — you bring the ABI document, the SDK brings the
   machinery. Where a specific contract imposes knowledge an ABI cannot carry
   (frBTC's premium arithmetic, its signer lookup), that knowledge lives under
   `alkanesjs/utils/<name>` as plain functions.
3. **Entries share types structurally, never nominally.** Each entry bundles
   its own type graph, so an entry must not name core *classes* (`Provider`,
   `Account`, `Contract`) in its public signatures — two flattened copies of a
   class with private members are incompatible even when identical. Entries
   expose functions, constants, interfaces; classes live in the root. Where an
   entry needs "a provider", it declares the structural slice it actually uses
   (see `FrbtcSignerSource` in `utils/frbtc`).

## Quick orientation

```ts
import { Account, AlkaneId, Contract, Provider, bitcoin } from "alkanesjs";
import { consumeOrThrow } from "alkanesjs/boxed";

const provider = new Provider({
  metashrewUrl: "https://kirby.alkanode.com/rpc",
  espoUrl: "https://api.alkanode.com/rpc",
  network: bitcoin.networks.bitcoin,
  explorerUrl: "https://mempool.space",
  defaultFeeRate: 3,
});

const me = Account.fromWIF(WIF, provider);
const token = new Contract(MyTokenAbi, AlkaneId.fromString("2:123"), provider);

// a view — simulated, nothing broadcast
const name = await token.getName().unwrap();

// a state change — built, signed, broadcast, waited out
await me
  .tx()
  .call(token, "mint", { amount: 5n })
  .build()
  .send()
  .waitForConfirmation();
```

Every page below assumes this shape and explains one part of it in depth.

## Adding an entry

One row in each of three places, plus a stub folder:

1. the entry source (`src/<name>.ts` — a re-export file with a header
   explaining what belongs there),
2. `ENTRIES` in `esbuild.config.mjs` (bundles) and the list in
   `rollup.config.mjs` (flattened `.d.ts`),
3. `package.json#exports` (+ `files`), and a `<name>/package.json` stub so
   classic non-`exports`-aware resolution still finds it (the `/wallets`
   pattern).

Then document it here.
