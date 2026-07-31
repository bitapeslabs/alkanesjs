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
constructed against it. For the hosted infrastructure, two come predefined:

```ts
import { networks } from "alkanesjs";

networks.Mainnet   // hosted kirby + espo, mainnet
networks.Regtest   // the hosted regtest pair, play money, and a faucet
```

Each is usable two ways. Reached as a value it **is** a provider — quiet, no
logging. **Called**, it builds a fresh one with whatever you want changed:

```ts
networks.Regtest                        // the shared provider, debug off
networks.Regtest({ debug: 1 })          // same endpoints, wire logging on
networks.Mainnet({ defaultFeeRate: 8 })
```

Calling always returns a NEW provider and never disturbs the shared one. The
value form is built on first use and reused, so everything that reaches for
`networks.Mainnet` shares one pacer and one set of RPC clients.

Note that logging itself is global — one wrapper around one fetch — so
`{ debug: 1 }` anywhere turns it on everywhere. `provider.setDebug(n)` and
the root's `setFetchDebug(n)` are the same switch.

These are ordinary `Provider` instances; construct your own to point at
other endpoints or choose your own fee rate:

```ts
const provider = new Provider({
  metashrewUrl: "https://kirby.alkanode.com/rpc", // simulation + views
  espoUrl: "https://api.alkanode.com/rpc",        // index + broadcast
  network: bitcoin.networks.bitcoin,
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
const fresh = Account.generate(provider);              // a brand new wallet
const watch = ViewAccount.fromAddress(address, provider);
```

Every account is **taproot** unless `addressType` says otherwise
(`"nativeSegwit"`, `"nestedSegwit"`, `"legacy"`), and each type derives under
its conventional BIP purpose — 86, 84, 49, 44.

`Account.generate(provider)` makes a fresh BIP39 wallet — taproot, index 0,
12 words (`{ words: 24 }` for 256 bits of entropy). It is a full HD account:
`setIndex` walks it, `exportMnemonic` hands back the phrase. Nothing
persists it, so export the mnemonic and keep it somewhere before paying the
address, or the funds are unrecoverable.

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

### Walking an HD wallet

An account from a mnemonic is one address of a wallet, and can walk to the
others. `setIndex` re-derives in place — a different address AND a different
signing key — and returns the account, so it chains:

```ts
const wallet = Account.fromMnemonic(words, provider);

wallet.index;                    // 0 — where the walk starts
wallet.address();                // …the first address
wallet.setIndex(1).address();    // …the second, now signing with its key
wallet.isHD;                     // true
```

`index` is `null` — and `setIndex` throws — for an account with no walk to
take: one from a WIF, one behind an external signer, or one derived at an
explicit `path` (a verbatim path is not a position on a walk).

Everything reads the address and key at **build** time, so transactions built
after a `setIndex` use the new index. A transaction already built is already
signed and keeps the key it was signed with — so build, send, then walk.

### Exporting key material

```ts
me.exportWIF();        // this account's private key, in WIF
me.exportMnemonic();   // the seed phrase — HD accounts only
```

For an HD account `exportWIF()` gives the key at the **current** index; walk
and export again for another. `exportWIF` throws behind an external signer
(the wallet holds the key, the SDK never sees it), and `exportMnemonic`
throws for anything not derived from a mnemonic.

Both hand out spending authority as a string — a mnemonic over the whole
wallet, not just one index. Never log one, never send one anywhere.

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
