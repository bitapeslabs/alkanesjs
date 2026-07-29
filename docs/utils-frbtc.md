# `alkanesjs/utils/frbtc` — frBTC helpers

```ts
import {
  applyFrbtcPremium,
  getFrbtcSignerAddress,
  DEFAULT_FRBTC_PREMIUM,
} from "alkanesjs/utils/frbtc";
```

frBTC is the synthetic-BTC alkane. This entry is deliberately **not** a
contract binding — no id, no ABI, no opcodes (bring your own document and
`Contract` for those). What lives here is only what an ABI cannot carry:

## The premium arithmetic

A wrap mints the BTC paid **minus the premium** (a fraction of 1e8; the
default everywhere is 100 000 = 0.1%):

```ts
const minted = applyFrbtcPremium(satsPaid, premium);
// minted = sats - floor(sats * premium / 1e8)
```

Knowing `minted` exactly is what lets a CPFP child spend a wrap's mint
before the wrap is even broadcast — see
[transactions.md](./transactions.md#packages-cpfp). Read the live premium
from the contract (`getPremium`, opcode 104) when you can; `DEFAULT_FRBTC_PREMIUM`
is the fallback.

## The signer lookup

A wrap only counts if its transaction pays the BTC to the **signer script**
frBTC currently trusts. That script is state, not a constant — a stale
signer silently burns every wrap (BTC paid to the old script mints nothing) —
so it is always read live, from espo's indexed `/signer` storage slot:

```ts
const signer = consumeOrThrow(
  await getFrbtcSignerAddress(provider, provider.network),
);

const wrap = me
  .tx()
  .transfer("sats", WRAP_SATS, signer)  // the shape an ABI cannot express…
  .call(frbtc, "wrap");                 // …beside the call it CAN
```

`getFrbtcSignerScript(provider)` returns the raw script when you need it
un-rendered. Both error rather than guess on any failure, and both accept
anything provider-shaped (`FrbtcSignerSource` — an espo that answers
`subfrost.get_signer`), so they never bind to the core `Provider` class.
