import { ecc } from "./crypto/ecc";
import * as bitcoin from "bitcoinjs-lib";
bitcoin.initEccLib(ecc);

/*
  bitcoinjs, with the elliptic-curve library already loaded.

  Anything touching a taproot address — turning one into an output script,
  reading one back off a transaction — throws "No ECC Library provided" until
  `initEccLib` has been called, and calling it on your own copy does not help
  if the SDK is using its own. Re-exporting the copy the SDK initialised is
  the difference between that working and not.
*/
export { bitcoin };

export * from "./libs";
export * from "./apis";
export * from "./provider";
export * from "./debug";
export * from "./utils";
export * from "./browser-wallets";
export * from "./boxed";
