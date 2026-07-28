/*
  frBTC — the synthetic BTC alkane (id 32:0 on both networks, 8 decimals).

  Opcodes:
    0   initialize
    1   set-signer
    4   set-premium
    77  wrap             cellpack is a BARE [77]; the minted amount is derived
                         from the tx shape (see below)
    78  unwrap           cellpack is [78, vout, amount_requested]
    99  get-name
    100 get-symbol
    101 get-pending-payments
    102 get-decimals
    103 get-signer
    104 get-premium
    105 get-total-supply

  wrap and unwrap are NOT exposed as ABI execute() methods on purpose: both
  impose tx-shape requirements the generic builder cannot express (wrap must
  pay BTC to the signer script, unwrap needs a two-protostone shape with a
  signer-script anchor output). Build them with `buildSwapTransactions` /
  `buildWrapOptions` / `buildUnwrapOptions` in ./swap.
*/

import { address as baddress, type Network } from "bitcoinjs-lib";

import {
  BoxedError,
  BoxedSuccess,
  type BoxedResponse,
  isBoxedError,
} from "@/boxed";
import type { AlkaneId } from "@/apis";
import type { Provider } from "@/provider";
import { abi } from "../interfaces/builder";
import { AlkanesBaseContract } from "../interfaces/base";

/** frBTC's alkane id. Identical on mainnet and regtest. */
export const FRBTC_ALKANE_ID: AlkaneId = { block: 32n, tx: 0n };

/** frBTC carries the same 8 decimals as BTC (its base unit is the satoshi). */
export const FRBTC_DECIMALS = 8;

export const FRBTC_OPCODES = {
  initialize: 0n,
  setSigner: 1n,
  setPremium: 4n,
  wrap: 77n,
  unwrap: 78n,
  getName: 99n,
  getSymbol: 100n,
  getPendingPayments: 101n,
  getDecimals: 102n,
  getSigner: 103n,
  getPremium: 104n,
  getTotalSupply: 105n,
} as const;

/** The premium returned by opcode 104 is a fraction of 1e8. */
export const FRBTC_PREMIUM_DENOMINATOR = 100_000_000n;

/** 100000 / 1e8 == 0.1%. The static premium the builders always use. */
export const DEFAULT_FRBTC_PREMIUM = 100_000n;

/** The contract refuses to burn less than this on an unwrap. */
export const FRBTC_MIN_UNWRAP = 546n;

export const FrBtcABI = abi.contract({
  getName: abi.opcode(FRBTC_OPCODES.getName).view().returns("string"),
  getSymbol: abi.opcode(FRBTC_OPCODES.getSymbol).view().returns("string"),
  getPendingPayments: abi
    .opcode(FRBTC_OPCODES.getPendingPayments)
    .view()
    .returns("uint8Array"),
  getDecimals: abi.opcode(FRBTC_OPCODES.getDecimals).view().returns("bigint"),
  /** raw signer bytes: either a 34-byte P2TR script_pubkey or a 32-byte x-only key */
  getSigner: abi.opcode(FRBTC_OPCODES.getSigner).view().returns("uint8Array"),
  getPremium: abi.opcode(FRBTC_OPCODES.getPremium).view().returns("bigint"),
  getTotalSupply: abi
    .opcode(FRBTC_OPCODES.getTotalSupply)
    .view()
    .returns("bigint"),
});

export class FrBtcContract extends abi.attach(AlkanesBaseContract, FrBtcABI) {}

const cannotSign = async (): Promise<string> => {
  throw new Error("frBTC contract handle is read-only and cannot sign a psbt");
};

/** A read-only FrBtcContract bound to `provider`. */
export const frbtcContract = (
  provider: Provider,
  frbtcId: AlkaneId = FRBTC_ALKANE_ID,
): FrBtcContract => new FrBtcContract({ provider, sign: cannotSign }, frbtcId);

/**
 * The signer's `script_pubkey`, resolved LIVE from espo's `subfrost.get_signer`
 * (the indexed `/signer` storage slot of the frBTC alkane). A pure data read,
 * never a simulation, and never a hardcoded per-network constant: a stale
 * signer would silently burn every wrap (BTC paid to the old script mints 0),
 * so on any failure this errors rather than guessing.
 */
export async function getFrbtcSignerScript(
  provider: Provider,
  frbtcId: AlkaneId = FRBTC_ALKANE_ID,
): Promise<BoxedResponse<Buffer, string>> {
  void frbtcId;
  try {
    const signer = await provider.rpc.espo.getSubfrostSigner();
    if (signer.isErr()) {
      return new BoxedError(`subfrost.get_signer failed: ${signer.message ?? String(signer.errorType)}`, "FrbtcSignerError");
    }

    const hex = signer.data.script_pubkey.replace(/^0x/, "");
    const script = Buffer.from(hex, "hex");
    if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) {
      return new BoxedError(`subfrost.get_signer returned a non-P2TR script: ${hex}`, "FrbtcSignerError");
    }
    return new BoxedSuccess(script);
  } catch (err) {
    return new BoxedError(`Failed to resolve the frBTC signer: ${(err as Error).message}`, "FrbtcSignerError");
  }
}

/** The signer script rendered as an address on `network`. */
export async function getFrbtcSignerAddress(
  provider: Provider,
  network: Network,
  frbtcId: AlkaneId = FRBTC_ALKANE_ID,
): Promise<BoxedResponse<string, string>> {
  const script = await getFrbtcSignerScript(provider, frbtcId);
  if (isBoxedError(script)) return script;

  try {
    return new BoxedSuccess(baddress.fromOutputScript(script.data, network));
  } catch (err) {
    return new BoxedError(`frBTC signer script is not encodable as an address on this network: ${(err as Error).message}`, "FrbtcSignerError");
  }
}

/**
 * The wrap premium: the static 0.1% default, never simulated (deliberate, no
 * espo data read exposes it). Safe for the builders: the premium only sizes the
 * CHILD's shifter edict in a wrap -> swap package, and an edict is capped at
 * the balance actually present. The (provider, frbtcId) shape is kept so call
 * sites are unchanged.
 */
export async function getFrbtcPremium(
  provider: Provider,
  frbtcId: AlkaneId = FRBTC_ALKANE_ID,
): Promise<BoxedResponse<bigint, string>> {
  void provider;
  void frbtcId;
  return new BoxedSuccess(DEFAULT_FRBTC_PREMIUM);
}

/**
 * The frBTC actually minted by wrapping `amountSats`, after the premium.
 * PURE: `minted = amount - floor(amount * premium / 1e8)`.
 */
export function applyFrbtcPremium(amountSats: bigint, premium: bigint): bigint {
  if (amountSats <= 0n) return 0n;
  if (premium <= 0n) return amountSats;

  const fee = (amountSats * premium) / FRBTC_PREMIUM_DENOMINATOR;
  return amountSats > fee ? amountSats - fee : 0n;
}
