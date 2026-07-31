import { ecc } from "./crypto/ecc";
import * as bitcoin from "bitcoinjs-lib";
bitcoin.initEccLib(ecc);

/*
  Entry: `alkanesjs` — the core.

  Everything a script that talks to alkanes needs: a Provider to speak
  through, an Account to sign with, a Contract to call, and the two value
  types ids and amounts travel as. The rest of the library lives in
  structured entries — see docs/README.md for the map:

    alkanesjs/boxed         result handling (consumeOrThrow, isBoxedError…)
    alkanesjs/traces        decoding what protostones did
    alkanesjs/abi           alkabi documents: overrides, wasm views
    alkanesjs/utils/amm     constant-product pool math
    alkanesjs/utils/frbtc   frBTC premium math + signer lookup
    alkanesjs/wallets       browser wallet connectors
    alkanesjs/debug         wire-level logging

  This entry deliberately re-exports whole core modules rather than curating
  names one by one: every type reachable from a core surface (a BuiltTx's
  fields, a deployment's package) has to be nameable by consumers, and the
  module boundary — not a hand-kept list — is what keeps that true.
*/

/*
  bitcoinjs, with the elliptic-curve library already loaded.

  Anything touching a taproot address — turning one into an output script,
  reading one back off a transaction — throws "No ECC Library provided" until
  `initEccLib` has been called, and calling it on your own copy does not help
  if the SDK is using its own. Re-exporting the copy the SDK initialised is
  the difference between that working and not.
*/
export { bitcoin };

/* the provider — endpoints, simulation, packages */
export * from "./provider";

/* predefined providers for the hosted infrastructure */
export { networks, type NetworkProvider } from "./networks";

/*
  Wire-level logging. These live on the ROOT and not in an entry of their own
  on purpose: the logger is one piece of module state wrapping one fetch, and
  a separate entry would bundle a SECOND copy of it — controls that quietly
  governed nothing. `provider.setDebug(n)` is the same switch.
*/
export {
  setFetchDebug,
  isFetchDebugEnabled,
  fetchDebugLevel,
} from "./debug";

/* accounts and the transaction builder */
export * from "./libs/alkanes/account";

/* contract deployment (commit/reveal packages) */
export * from "./libs/alkanes/deploy";

/* calling contracts through their ABI documents */
export * from "./libs/alkabi/contract";

/* the value types: ids and token amounts */
export { AlkaneId, type AlkaneIdLike } from "./apis/alkanes/types";
export { Amount, DECIMALS } from "./libs/alkanes/amount";

/* what simulations answer with */
export type {
  SimulatedTransaction,
  SimulatedBlock,
  SimulatedProtostone,
} from "./apis/alkanes/simtx";
