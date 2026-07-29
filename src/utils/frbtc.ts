/*
  frBTC utilities — math and data reads for the synthetic BTC alkane.

  Deliberately NOT a contract: no id, no ABI, no opcodes. alkanesjs defines
  no contracts — bring your own ABI document and call the contract yourself.
  What lives here is only what an ABI cannot say:

    - the premium arithmetic (what a wrap actually mints)
    - the signer lookup (where the BTC has to be paid for a wrap to count)

  `import { … } from "alkanesjs/utils/frbtc"`
*/

import { address as baddress, initEccLib, type Network } from "bitcoinjs-lib";
import { ecc } from "@/crypto/ecc";

/*
  This entry bundles its own copy of bitcoinjs-lib, and rendering a P2TR
  script as an address needs that copy's ECC loaded — the root entry's
  `initEccLib` call reaches only the root bundle's copy, never this one.
*/
initEccLib(ecc);

import { BoxedError, BoxedSuccess, type BoxedResponse, isBoxedError } from "@/boxed";

/**
 * What the signer lookup actually needs from a provider: an espo that can
 * answer `subfrost.get_signer`. Structural on purpose — this entry has its
 * own type graph, and naming `Provider` here would make the two copies
 * nominally incompatible (their private members disagree). Any alkanesjs
 * `Provider` satisfies this shape.
 */
export interface FrbtcSignerSource {
  rpc: {
    espo: {
      getSubfrostSigner(): Promise<
        BoxedResponse<{ script_pubkey: string }, string>
      >;
    };
  };
}

/** frBTC carries the same 8 decimals as BTC (its base unit is the satoshi). */
export const FRBTC_DECIMALS = 8;

/** The premium returned by frBTC's opcode 104 is a fraction of 1e8. */
export const FRBTC_PREMIUM_DENOMINATOR = 100_000_000n;

/** 100000 / 1e8 == 0.1% — the premium every known deployment charges. */
export const DEFAULT_FRBTC_PREMIUM = 100_000n;

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

/**
 * The signer's `script_pubkey`, resolved LIVE from espo's `subfrost.get_signer`
 * (the indexed `/signer` storage slot of the frBTC alkane). A pure data read,
 * never a simulation, and never a hardcoded per-network constant: a stale
 * signer would silently burn every wrap (BTC paid to the old script mints 0),
 * so on any failure this errors rather than guessing.
 */
export async function getFrbtcSignerScript(
  provider: FrbtcSignerSource,
): Promise<BoxedResponse<Buffer, string>> {
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
  provider: FrbtcSignerSource,
  network: Network,
): Promise<BoxedResponse<string, string>> {
  const script = await getFrbtcSignerScript(provider);
  if (isBoxedError(script)) return script;

  try {
    return new BoxedSuccess(baddress.fromOutputScript(script.data, network));
  } catch (err) {
    return new BoxedError(`frBTC signer script is not encodable as an address on this network: ${(err as Error).message}`, "FrbtcSignerError");
  }
}
