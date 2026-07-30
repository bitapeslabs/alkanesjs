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

Ids are `{ block: bigint, tx: bigint }`. Ids the SDK hands **back** — a
deployment's id, `balances.alkanes()` — are `AlkaneId` instances, and the
conversions read straight off them:

```ts
const id = await deployment.send().waitForDeployment();

id.toString()      // "2:74" — the universal spelling; `${id}` prints it too
id.toSchema()      // { block: 2, tx: 74n } — the borsh argument shape
id.toObject()      // { block: 2n, tx: 74n } — plain data, methods shed
id.equals(other)   // structural equality, accepts anything id-shaped
JSON.stringify(id) // '"2:74"' — toJSON() sidesteps the bigint restriction
```

Ids you **write** can stay plain: every input position in the SDK is typed
`AlkaneIdData` — the structural `{ block, tx }` shape — so a hand-written
`{ block: 2n, tx: 0n }` is accepted wherever an id is wanted, alongside real
instances. The statics mirror the instance methods for exactly those values,
converting without constructing:

```ts
AlkaneId.fromString("2:0")        // parse the universal spelling
AlkaneId.from(idLike)             // normalize string | {block,tx} | AlkaneId
AlkaneId.toString(idLike)         // "2:0"
AlkaneId.toSchema(idLike)         // the borsh shape, from anything id-shaped
AlkaneId.equal(a, b)
```

Rule of thumb: got an instance, use its methods; got something merely
id-shaped, use the statics (or `AlkaneId.from` it once and keep the
instance).

## `Amount`

An `Amount` wraps a base-unit value (8 decimals by default) and answers in
whichever form you need. **The constructor is decided by what you hold**,
because the type tells the denomination: numbers and decimal strings are how
humans write *tokens*, so they scale; bigints and base-unit strings are how
the *wire* speaks, so they are taken verbatim:

```ts
Amount.fromNumber(1)               // 1 token
Amount.fromString("2.221")         // 2.221 tokens — exact, digits never float
Amount.fromBigint(viewResult)      // base units — what views and balances return
Amount.fromBaseUnits("222100000")  // base units as text — what espo reports
```

Four forms read off any of them:

```ts
const amt = Amount.fromString("2.221");
amt.bigint            // 222100000n — the wire value, what calldata wants
amt.stringBaseUnits   // "222100000"
amt.string            // "2.221" — every digit kept; `${amt}` prints this
amt.number            // 2.221 — lossy above 2^53, display only
amt.toLocaleString()  // "2.221" with locale grouping ("1,234.5")
JSON.stringify(amt)   // '"222100000"' — the exact form; fromBaseUnits reads it back
```

`transfer()` accepts an `Amount` or a plain bigint interchangeably
(`AmountLike`); borsh call arguments are typed `bigint`, so hand them
`.bigint`. The trap the names guard: `fromString("2.221")` reads tokens,
`fromBaseUnits` refuses anything with a decimal point — handing text to the
wrong one would be silently off by 10^8.

## `bitcoin`

bitcoinjs-lib **with its elliptic-curve library already initialized**. Use
this export, not your own copy: taproot operations throw
`No ECC Library provided` on an uninitialized copy, and initializing yours
does not initialize the SDK's.
