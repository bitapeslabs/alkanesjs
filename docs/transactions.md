# The transaction builder

Every alkanes transaction the SDK builds has the same shape:

```
inputs → transfer stone —edicts→ calls' shadow vouts → … → outputs
```

A TRANSFER protostone first, then one stone per `.call()` / `.protostone()`
in chain order. The transfer stone leads because protorune hands every alkane
riding on the inputs to the first stone — so it is the one stone with
anything to route, and routing is all it does. Paying a call and paying a
person are the same move: an edict aimed at a shadow index or an address.

## Building

```ts
const tx = me
  .tx()
  .transfer(TOKEN, amount, 1)          // pay the first call — shadow vout 1
  .transfer(TOKEN, amount, "bc1p…")    // or pay a person
  .transfer("sats", 10_000n, addr)     // plain BTC rides the same builder
  .call(pool, "swap", args)            // typed by the contract's ABI document
  .call(pool, "getReserves");          // calls settle in order, same tx
```

### Shadow space

The only vout numbers the API accepts are **shadow indices**, counted over
the protostones: `0` is the transfer stone, `1` the first call, `2` the
second. Real vouts are never addressable — the builder decides the real
layout, which is exactly why a hand-written number for one could never be
right. On the wire, shadow index `n` is `real_outputs + 1 + n`; the builder
does that arithmetic so nothing else has to.

Per-call `StoneSettings` route results between stones:

```ts
.call(pool, "swap", args, { shadowPointer: 2 })  // aim this result at stone 2
```

`shadowPointer` is what lets one transaction do token0 → token1 → token0,
each leg paid by the previous leg's result. Backward references are refused
at build time — stones settle in order, so aiming at an earlier one would
strand the alkanes.

### Raw stones

`.protostone({ message: [...] })` writes an arbitrary protostone. The message
is a **whole cellpack** — target block, target tx, then inputs — not just an
opcode. `[77n]` is a call to alkane `77:0`, not opcode 77; prefer
`.call(contract, "method")`, which writes the target words for you.

## One promise, one chain

The promise ends wherever you stop chaining, and each step happens once no
matter how many handles you hold:

```ts
const built = await tx.build();                      // BuiltTx — bytes, txid, holds
const txid  = await tx.build().send();               // broadcast through espo
await tx.build().send().waitForConfirmation();       // mined AND indexed
```

`waitForConfirmation()` resolves only when espo has indexed the block too, so
any read afterwards sees what the transaction did.

## Simulation

```ts
const outcome = await tx.simulate();   // or just `await tx` — same thing
outcome.ok                             // every call succeeded
outcome.calls                          // one boxed result per .call(), decoded
outcome.result                         // the last call's result
outcome.trace                          // decoded traces (see traces.md)
outcome.outputs                        // what each real output ended up holding
```

What is simulated is the *transaction* — its real bytes — not a description
of one, so a `ViewAccount` can build and simulate flows it could never sign.

## Chaining transactions

`.spending(tx1)` lets a transaction consume outputs of an earlier, still
unbroadcast transaction — no lookup could find them, so naming the
transaction is what supplies them:

```ts
const tx1 = alice.tx().transfer(T0, amountIn, 1).call(pool, "swap", args);
const tx2 = alice.tx().spending(tx1).transfer(T1, out, bob);
const tx3 = bob.tx().spending(tx2).transfer(T1, out, 1).call(pool, "swap", back);

const [a, b, c] = await provider.simulateBlock([tx1, tx2, tx3]);
```

`simulateBlock` builds them in order — each told what the ones before it
spent and left — and runs them against one shared state, the way a block
would.

## Packages (CPFP)

`sendPackage` is the broadcast half of the same build: the identical
dependent chain, submitted through Bitcoin Core's `submitpackage` so it is
judged on its **combined** fee rate and mined together.

```ts
const wrap = me.tx().transfer("sats", sats, signer).call(frbtc, "wrap");
const swap = me.tx().spending(wrap).transfer(FRBTC, minted, 1).call(pool, "swap", args);

const sent = provider.sendPackage([wrap, swap]);
const [parentTxid, childTxid] = await sent;
await sent.waitForConfirmation();
```

Order matters — parents before the children that spend them. A parent paying
under the mempool minimum still relays when the child covers the deficit,
and the child may spend outputs no node has seen: that is what makes a
`.spending()` chain broadcastable at all.

Note that *relayed and mined* is not *succeeded*: a mined protostone can
still revert. Check balances or read the trace
([traces.md](./traces.md)) rather than trusting confirmation alone.
