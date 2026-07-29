# `alkanesjs` — the core entry

Everything on the 90% path: connect, sign, call, deploy, and the two value
types ids and amounts travel as.

```ts
import {
  Account,
  AlkaneId,
  Amount,
  Contract,
  Provider,
  ViewAccount,
  bitcoin,
} from "alkanesjs";
```

## `Provider`

One object holding the endpoints and the network. Everything else is
constructed against it.

```ts
const provider = new Provider({
  metashrewUrl: "https://kirby.alkanode.com/rpc", // simulation + views
  espoUrl: "https://api.alkanode.com/rpc",        // index + broadcast
  network: bitcoin.networks.bitcoin,
  explorerUrl: "https://mempool.space",
  defaultFeeRate: 3,                              // sat/vB, overridable per tx
});
```

- `provider.rpc.espo` / `.alkanes` / `.electrum` / … — the raw RPC clients,
  for anything below the SDK's surfaces.
- `provider.simulateBlock([tx1, tx2, …])` — run transactions in order against
  one shared state, the way a block would. Each sees what the ones before it
  did. See [transactions.md](./transactions.md#chaining-transactions).
- `provider.sendPackage([parent, child])` — broadcast a dependent run of
  transactions as ONE package (CPFP): judged on combined fee rate, mined
  together. See [transactions.md](./transactions.md#packages-cpfp).
- `provider.waitForConfirmation(txid)` — poll until mined.
- `provider.height()` — the height the endpoint has indexed to.

## `Account` and `ViewAccount`

An `Account` holds a key and signs; a `ViewAccount` is address-only — it
builds transactions a *simulation* accepts, but refuses to broadcast them.
Same building API, so simulation code and production code read identically.

```ts
const me = Account.fromWIF(wif, provider);
const her = Account.fromMnemonic(mnemonic, provider);  // BIP39 → BIP86 taproot
const watch = ViewAccount.fromAddress(address, provider);
```

- `me.address()` — the BTC address; `me.assetAddress()` — where alkanes live.
- `me.tx()` — start a transaction. The whole builder is documented in
  [transactions.md](./transactions.md).
- `me.deploy(wasm)` — start a deployment (below).
- `me.getBalances()` — every alkane the account holds, from espo's index:

```ts
const balances = await me.getBalances();   // Balances extends Map<string, bigint>
balances.amountOf(tortilla);               // bigint — 0n when absent
balances.alkanes();                        // AlkaneId[] — everything held
```

## `Contract`

A typed handle over an **alkabi document** — the JSON ABI a contract's build
emits (see [abi.md](./abi.md)). The document's method names, argument shapes
and return shapes all flow into the type system; there is nothing to
hand-write.

```ts
const taco = new Contract(TortillaAbi, AlkaneId.fromString("2:71"), provider);

// one view — a simulation, nothing broadcast
const consts = await taco.getConsts().unwrap();

// several views, one round trip
const [consts, admin] = await taco
  .bundle()
  .getConsts().unwrap()
  .getTacoclickerAdminAlkaneId().unwrap();
```

Views resolve like promises; `.unwrap()` converts a boxed failure into a
throw at the await site (see [boxed.md](./boxed.md)). State-changing methods
go through a transaction — `.call(contract, "method", args)` — because a call
that changes state IS a transaction; the builder page covers it.

## Deployment

A contract deploys as a commit/reveal pair, priced and submitted as one
package. The constructor call is typed by the ABI document even though the
contract does not exist yet:

```ts
const id = await me
  .deploy(wasm)                                  // Uint8Array of the build
  .call(MyAbi, "initialize", { premine: 1_000n })
  .build()
  .send()
  .waitForDeployment();                          // resolves to the AlkaneId
```

Each link of the chain is awaitable on its own: stop at `.build()` for the
package, at `.send()` for the txids, at `.waitForDeployment()` for the id.

## `AlkaneId`

Ids are `{ block: bigint, tx: bigint }`. The class adds constructors and
helpers as **statics**, so plain object literals stay assignable — a hand
written `{ block: 2n, tx: 0n }` is a valid `AlkaneId` everywhere.

```ts
AlkaneId.fromString("2:0")        // parse the universal spelling
AlkaneId.from(idLike)             // normalize string | {block,tx} | AlkaneId
AlkaneId.toString(id)             // "2:0"
AlkaneId.toSchema(id)             // { block: number, tx: bigint } — the borsh shape
AlkaneId.equal(a, b)
```

## `Amount`

Token amounts are `bigint`s in base units (8 decimals). `Amount` converts
human numbers losslessly — `fromString` never lets the digits become a float:

```ts
Amount.fromNumber(1)         // 100000000n
Amount.fromString("2.221")   // 222100000n — exact
Amount.toString(150000000n)  // "1.5"
```

## `bitcoin`

bitcoinjs-lib **with its elliptic-curve library already initialized**. Use
this export, not your own copy: taproot operations throw
`No ECC Library provided` on an uninitialized copy, and initializing yours
does not initialize the SDK's.
