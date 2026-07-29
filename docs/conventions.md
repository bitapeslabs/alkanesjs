# Conventions — the wire facts everything assumes

The short list of protocol facts the whole SDK is built on. Nothing here is
alkanesjs's invention; these are how alkanes itself works, collected so the
other pages can assume them.

## Ids

An alkane id is `{ block, tx }`, universally spelled `"block:tx"` — espo
keys, trace events, and wallet listings all use that spelling.
`AlkaneId.fromString` / `AlkaneId.toString` convert.

Contracts speak a narrower shape in borsh: **`SchemaAlkaneId`** is
`{ block: u32, tx: u64 }` — `block` a *number*-sized field, `tx` a bigint.
`AlkaneId.toSchema(id)` produces it. When a view answers with an id, it
arrives in schema shape; `AlkaneId.from` normalizes it back.

## Amounts

Token amounts are `bigint` base units, 8 decimals. espo reports amounts as
decimal strings of base units — the SDK parses them with `BigInt(value)`,
never through a float. `Amount` (core) converts for humans losslessly.

## Cellpacks

A protostone message is a **cellpack**: `[target.block, target.tx, opcode,
...inputs]` as u128 words. There is no "bare opcode" — a message of `[77]`
is a call to alkane `77:0`. `.call()` writes the target words for you; only
`.protostone()` leaves them to you.

Borsh-mode arguments ride after the opcode as 16-byte little-endian words,
the final word zero-padded. Decoders must tolerate the padding
(`deserialize_reader`, not `try_from_slice`) — both the SDK and the alkabi
Rust crate do.

## The transaction shape

`[transfer stone, call₀, call₁, …]` — the transfer stone leads because
protorune allocates every alkane riding on the inputs to the first stone.
This is also why a lone call-stone would swallow unrelated sibling tokens
sitting on the same UTXOs: the leading transfer stone's edicts route exactly
what each call should get, and its own pointer returns the rest to the
sender.

## Shadow vouts

Shadow index `n` is wire vout `real_outputs + 1 + n`. Index 0 is the
transfer stone; 1 is the first call. Traces file under the wire number
(`txid:shadowVout`); the builder API only ever speaks shadow indices.

## Confirmation ≠ success

A transaction whose protostone reverted still confirms — the BTC moved, the
alkanes did not. Ownership checks, balance deltas and traces are how you
learn what actually happened ([traces.md](./traces.md)).

## Revert reasons

Failure returndata carries the reason behind the `08c379a0` selector
(`Error(string)`). `extractAbiErrorMessage` (traces entry) peels it.
