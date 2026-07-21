/*
  ─────────────────────────  SWAP / WRAP / UNWRAP BUILDERS  ────────────────────

  Five scenarios, one entry point (`buildSwapTransactions`):

    BTC   -> token   CPFP package: parent wrap (BTC -> frBTC), child swap
    token -> BTC     CPFP package: parent swap (token -> frBTC), child unwrap
    token -> token   ONE tx (swap)
    BTC   -> frBTC   ONE tx (wrap)
    frBTC -> BTC     ONE tx (unwrap)

  ── the "shifter" ──────────────────────────────────────────────────────────
  The alkanes runtime auto-allocates EVERY alkane sitting on the spent utxos
  into the FIRST matching protostone. A single-protostone swap would therefore
  hand the AMM factory every unrelated sibling token on those inputs. So a swap
  is always two protostones:

    [0] edict-only: moves exactly `sellAmount` of the sell token into [1]'s
        SHADOW VOUT, and points its own leftovers at the change output, which
        is what returns the siblings (and any unsold remainder) to the user.
    [1] the message (cellpack), pointing at the alkanes dust output.

  The same shape is mandatory for `unwrap`, whose contract rejects a
  protomessage that carries edicts ("message cannot contain edicts, only a
  pointer").

  ── output layout ──────────────────────────────────────────────────────────
  `ProtostoneTransaction.addOutputs` lays a tx out as:

    [0]          the alkanes dust pointer output on the ASSET address
                 (present whenever a protostone is written; `includePsbts` is
                 always empty here, so it really is index 0)
    [1..n]       one output per DISTINCT `transfers[].address`, in first
                 appearance order, each at least 546 sats
    [n+1]        the BTC change output, when there is change
    last         the OP_RETURN carrying the runestone

  `planProtostoneOutputIndices` replicates that ordering so `unwrap`'s `vout`
  argument can point at the signer anchor output without hardcoding an index.

  ── why the alkane legs appear in `transfers` ──────────────────────────────
  When an explicit `protostones` array is supplied the builder stops deriving
  edicts from `transfers`, but `transfers` STILL drives utxo selection. An
  alkane entry is therefore how we tell the builder "pull utxos holding this
  much of this token"; its `address` only influences which BTC outputs exist.
*/

import { Transaction, type Network } from "bitcoinjs-lib";

import {
  BoxedError,
  BoxedSuccess,
  type BoxedResponse,
  consumeOrThrow,
  isBoxedError,
} from "@/boxed";
import type { AlkaneId, AlkanesUtxoEntry } from "@/apis";
import type { Provider } from "@/provider";
import {
  CHANGE_OUTPUT,
  MIN_RELAY_FEE_RATE,
  POINTER_OUTPUT,
  getCpfpPackageTransactions,
  getProtostoneUnsignedPsbtBase64,
  normalizeTransactionAddresses,
  toProtostone,
  type CpfpPackageResult,
  type ProtostoneSpec,
  type ProtostoneTransactionOptions,
  type SingularTransfer,
  type TransactionAddressInput,
} from "../alkanes/psbt";
import { alkaneIdKey, alkaneIdsEqual } from "./alkane-id";
import {
  buildSwapCallData,
  buildSwapExactInCallData,
  buildSwapExactOutCallData,
} from "./amm";
import {
  FRBTC_ALKANE_ID,
  FRBTC_MIN_UNWRAP,
  FRBTC_OPCODES,
  applyFrbtcPremium,
  getFrbtcPremium,
  getFrbtcSignerAddress,
} from "./frbtc";

/** The dust an output must carry to be relayable / to anchor the signer. */
const DUST = 546;

/** `"btc"` is native BTC. frBTC is not special here: it is just AlkaneId 32:0. */
export type SwapAssetRef = "btc" | AlkaneId;

export type SwapTxLabel = "wrap" | "swap" | "unwrap";

export interface SwapTransaction {
  hex: string;
  txid: string;
  label: SwapTxLabel;
  vsize: number;
  fee: number;
}

export interface BuildSwapResult {
  /** Broadcast in order. A 2-entry list is a CPFP package (parent first). */
  txs: SwapTransaction[];
  /** Only set for a CPFP package: the rate the pair actually achieves. */
  packageFeeRate?: number;
}

/**
 * Which side of the trade the user pinned.
 *
 *   `"exactIn"`  (default) the user typed what they PAY — factory opcode 29,
 *                `amountIn` is spent exactly, `minAmountOut` is a floor.
 *   `"exactOut"` the user typed what they RECEIVE — factory opcode 14,
 *                `minAmountOut` is delivered exactly and `amountIn` becomes a
 *                CEILING on what may be spent.
 */
export type SwapMode = "exactIn" | "exactOut";

export interface BuildSwapParams {
  provider: Provider;
  network: Network;
  from: SwapAssetRef;
  to: SwapAssetRef;
  /**
   * base units: sats for `"btc"`, raw 8-decimal for alkanes.
   *
   * `mode: "exactIn"`  — the exact amount spent (the AMM's `amount_in`).
   * `mode: "exactOut"` — the MAXIMUM that may be spent (`amount_in_max`); the
   *                     unspent remainder comes back to the wallet. For a
   *                     BTC-funded swap this is still the raw sats wrapped, so
   *                     the caller must have grossed it up through the frBTC
   *                     wrap premium already.
   */
  amountIn: bigint;
  /**
   * base units of `to`.
   *
   * `mode: "exactIn"`  — the AMM's `amount_out_min`, a slippage floor.
   * `mode: "exactOut"` — the EXACT output requested (the AMM's `amount_out`).
   */
  minAmountOut: bigint;
  /** defaults to `"exactIn"`, which is the pre-existing behaviour verbatim */
  mode?: SwapMode;
  /** sat/vB the PACKAGE should achieve */
  feeRate: number;
  /** the AMM router, network-configurable */
  factoryId: AlkaneId;
  /** BLOCK HEIGHT; 0 (the default) means no deadline */
  deadline?: bigint;
  /**
   * Feerate for the CPFP parent (sat/vB). Defaults to MIN_RELAY_FEE_RATE.
   * Raise it when broadcasting through nodes that reject sub-1 sat/vB txs
   * (pre-v30 defaults, or a congested mempool with a raised dynamic floor).
   */
  parentFeeRate?: number;
  /** override frBTC's id; defaults to 32:0 */
  frbtcId?: AlkaneId;
  /**
   * The FULL token path of the AMM leg (e.g. espo's find_best_swap_path),
   * with any BTC endpoint already mapped to frBTC: it must start at the
   * effective sell token and end at the effective buy token. Defaults to the
   * direct pair.
   */
  path?: AlkaneId[];
}

export const isBtcRef = (ref: SwapAssetRef): ref is "btc" => ref === "btc";

const asAlkaneId = (ref: SwapAssetRef): AlkaneId => {
  if (isBtcRef(ref)) {
    throw new Error("Expected an alkane id, got native BTC");
  }
  return ref;
};

/*──────────────────────────── output index planning ─────────────────────────*/

export interface PlannedOutputIndices {
  /** the alkanes dust output; also what POINTER_OUTPUT resolves to */
  pointerOutputIndex: number;
  /** first-appearance address -> output index */
  addressOutputIndex: Record<string, number>;
}

/**
 * PURE. Replicate `ProtostoneTransaction`'s output ordering so a cellpack can
 * name an output index it does not physically build.
 *
 * Assumes a protostone IS written (so the dust pointer output exists) and that
 * `includePsbts` is empty — both hold for every builder in this file.
 */
export function planProtostoneOutputIndices(
  transfers: SingularTransfer[],
): PlannedOutputIndices {
  const addresses: string[] = [];
  for (const transfer of transfers) {
    if (transfer.asset === "btc" && transfer.ignorePush) continue;
    if (!addresses.includes(transfer.address)) addresses.push(transfer.address);
  }

  const pointerOutputIndex = 0;
  const addressOutputIndex: Record<string, number> = {};
  addresses.forEach((address, i) => {
    addressOutputIndex[address] = pointerOutputIndex + 1 + i;
  });

  return { pointerOutputIndex, addressOutputIndex };
}

/*──────────────────────────── option constructors ───────────────────────────*/

type BuilderOptions = Omit<
  ProtostoneTransactionOptions,
  "provider" | "psbtTransfers"
>;

export interface WrapOptionsParams {
  /** where the wrapped BTC must be paid, from `getFrbtcSignerAddress` */
  signerAddress: string;
  /** sats to wrap */
  amountSats: bigint;
  feeRate?: number;
  frbtcId?: AlkaneId;
}

/**
 * A wrap: pay `amountSats` to the frBTC signer script and point a bare `[77]`
 * cellpack at the alkanes dust output, which is where the minted frBTC lands.
 *
 * The cellpack takes NO arguments — the contract derives the minted amount by
 * summing every output whose script_pubkey byte-equals the signer script, so
 * the BTC transfer below IS the argument.
 */
export function buildWrapOptions({
  signerAddress,
  amountSats,
  feeRate,
  frbtcId = FRBTC_ALKANE_ID,
}: WrapOptionsParams): BuilderOptions {
  if (amountSats < BigInt(DUST)) {
    throw new Error(`A wrap must move at least ${DUST} sats`);
  }

  const transfers: SingularTransfer[] = [
    { asset: "btc", amount: Number(amountSats), address: signerAddress },
  ];

  const protostones: ProtostoneSpec[] = [
    {
      calldata: [frbtcId.block, frbtcId.tx, FRBTC_OPCODES.wrap],
      pointer: POINTER_OUTPUT,
      refundPointer: POINTER_OUTPUT,
    },
  ];

  return { transfers, protostones, feeRate };
}

export interface UnwrapOptionsParams {
  signerAddress: string;
  /** frBTC to attach, base units */
  attachAmount: bigint;
  /** frBTC to burn, base units. Any excess attached is refunded as frBTC. */
  requestAmount: bigint;
  feeRate?: number;
  frbtcId?: AlkaneId;
}

/**
 * An unwrap. Three contract rules shape this tx:
 *
 *   1. the protomessage may carry NO edicts, only a pointer — so the frBTC
 *      arrives from a PRECEDING edict-only protostone aimed at the message's
 *      shadow vout;
 *   2. `vout` (the cellpack's first argument) must index an output paying the
 *      SIGNER script — a dust anchor the custodian later spends — and must
 *      differ from `pointer`;
 *   3. `tx.output[pointer]` is where the BTC is paid out, so the pointer names
 *      a user output (here the alkanes dust output, which also collects the
 *      frBTC refunded when `requestAmount < attachAmount`).
 *
 * The frBTC selection leg and the signer anchor deliberately share an address
 * so they collapse into ONE 546-sat output: the alkane leg contributes no BTC
 * of its own, it only tells the builder which utxos to pull.
 */
export function buildUnwrapOptions({
  signerAddress,
  attachAmount,
  requestAmount,
  feeRate,
  frbtcId = FRBTC_ALKANE_ID,
}: UnwrapOptionsParams): BuilderOptions {
  if (requestAmount < FRBTC_MIN_UNWRAP) {
    throw new Error(`An unwrap must burn at least ${FRBTC_MIN_UNWRAP} sats of frBTC`);
  }
  if (attachAmount < requestAmount) {
    throw new Error("An unwrap cannot request more frBTC than it attaches");
  }

  const transfers: SingularTransfer[] = [
    //drives frBTC utxo selection; merges into the signer anchor output below
    { asset: frbtcId, amount: attachAmount, address: signerAddress },
    { asset: "btc", amount: DUST, address: signerAddress },
  ];

  const plan = planProtostoneOutputIndices(transfers);
  const signerVout = plan.addressOutputIndex[signerAddress];

  if (signerVout === undefined || signerVout === plan.pointerOutputIndex) {
    throw new Error(
      "Could not place the frBTC signer anchor output at a vout distinct from the pointer",
    );
  }

  const protostones: ProtostoneSpec[] = [
    {
      //shifter: hand exactly `attachAmount` to the message, siblings to change
      edicts: [
        { id: frbtcId, amount: attachAmount, output: toProtostone(1) },
      ],
      pointer: CHANGE_OUTPUT,
      refundPointer: CHANGE_OUTPUT,
    },
    {
      //no edicts, only a pointer — the contract rejects anything else
      calldata: [
        frbtcId.block,
        frbtcId.tx,
        FRBTC_OPCODES.unwrap,
        BigInt(signerVout),
        requestAmount,
      ],
      pointer: POINTER_OUTPUT,
      refundPointer: POINTER_OUTPUT,
    },
  ];

  return { transfers, protostones, feeRate };
}

export interface SwapOptionsParams {
  factoryId: AlkaneId;
  sellId: AlkaneId;
  /**
   * What the shifter ATTACHES. Under `mode: "exactOut"` this is the ceiling
   * (`amount_in_max`) rather than the amount actually consumed — the contract's
   * `_return_leftovers` sends the remainder back through the message pointer.
   */
  sellAmount: bigint;
  buyId: AlkaneId;
  /** `amount_out_min` under `"exactIn"`, the exact `amount_out` under `"exactOut"` */
  minAmountOut: bigint;
  deadline: bigint;
  /** where the sell token is pulled from */
  assetAddress: string;
  feeRate?: number;
  /** defaults to `"exactIn"` (opcode 29); `"exactOut"` uses opcode 14 */
  mode?: SwapMode;
  /**
   * The FULL token path for a multi-hop route (sellId first, buyId last),
   * e.g. espo's find_best_swap_path. Defaults to the direct pair.
   */
  path?: AlkaneId[];
  /**
   * Exact-in only: use opcode 29 (input amount inferred from the attached
   * alkane) instead of opcode 13. The wrap->swap CPFP child sets this: its
   * input is the parent's mint, whose exact size depends on the premium at
   * execution time, so a calldata amount could drift out of sync.
   */
  implicitInput?: boolean;
}

/** An AMM swap (single or multi-hop) with the shifter in front of the message. */
export function buildSwapOptions({
  factoryId,
  sellId,
  sellAmount,
  buyId,
  minAmountOut,
  deadline,
  assetAddress,
  feeRate,
  mode = "exactIn",
  path,
  implicitInput = false,
}: SwapOptionsParams): BuilderOptions {
  if (sellAmount <= 0n) {
    throw new Error("A swap must sell a positive amount");
  }
  if (alkaneIdsEqual(sellId, buyId)) {
    throw new Error("A swap cannot have the same token on both sides");
  }
  if (mode === "exactOut" && minAmountOut <= 0n) {
    throw new Error("An exact-output swap must request a positive amount out");
  }
  const fullPath = path && path.length >= 2 ? path : [sellId, buyId];
  if (
    !alkaneIdsEqual(fullPath[0], sellId) ||
    !alkaneIdsEqual(fullPath[fullPath.length - 1], buyId)
  ) {
    throw new Error(
      "The swap path must start at the sell token and end at the buy token",
    );
  }

  /*
    Either way the shifter attaches `sellAmount`: for an exact-in swap that is
    what gets spent, for an exact-out swap it is the `amount_in_max` ceiling the
    factory may draw from before returning the rest.
  */
  const transfers: SingularTransfer[] = [
    { asset: sellId, amount: sellAmount, address: assetAddress },
  ];

  const calldata =
    mode === "exactOut"
      ? buildSwapExactOutCallData(factoryId, {
          //opcodes 13/14 read the input token out of path[0]: FULL path
          path: fullPath,
          amountOut: minAmountOut,
          amountInMax: sellAmount,
          deadline,
        })
      : implicitInput
      ? buildSwapCallData(factoryId, {
          //opcode 29 prepends the incoming id, so only the REMAINING hops
          path: fullPath.slice(1),
          amountOutMin: minAmountOut,
          deadline,
        })
      : buildSwapExactInCallData(factoryId, {
          //opcode 13: explicit input amount, FULL path
          path: fullPath,
          amountIn: sellAmount,
          amountOutMin: minAmountOut,
          deadline,
        });

  const protostones: ProtostoneSpec[] = [
    {
      edicts: [{ id: sellId, amount: sellAmount, output: toProtostone(1) }],
      pointer: CHANGE_OUTPUT,
      refundPointer: CHANGE_OUTPUT,
    },
    {
      calldata,
      pointer: POINTER_OUTPUT,
      refundPointer: POINTER_OUTPUT,
    },
  ];

  return { transfers, protostones, feeRate };
}

/*───────────────────────────── single tx helper ─────────────────────────────*/

async function buildSingleTransaction(
  addressProvided: TransactionAddressInput,
  provider: Provider,
  options: BuilderOptions,
  label: SwapTxLabel,
  signPsbt: (unsignedPsbtBase64: string) => Promise<string>,
): Promise<SwapTransaction> {
  const built = consumeOrThrow(
    await getProtostoneUnsignedPsbtBase64(addressProvided, {
      ...options,
      provider,
    }),
  );

  const hex = await signPsbt(built.psbtBase64);
  const tx = Transaction.fromHex(hex);

  return {
    hex,
    txid: tx.getId(),
    label,
    vsize: tx.virtualSize(),
    fee: built.fee,
  };
}

/** The `parentOutputAlkanes` annotation for a parent whose output 0 holds `amount`. */
function pointerOutputAlkanes(
  id: AlkaneId,
  amount: bigint,
): Record<number, Record<string, AlkanesUtxoEntry>> {
  const key = alkaneIdKey(id);
  return {
    0: {
      [key]: { id: key, name: "", symbol: "", value: amount.toString() },
    },
  };
}

/*──────────────────────────────── entry point ───────────────────────────────*/

/**
 * Build (and sign) the 1 or 2 transactions a swap needs. Nothing is broadcast:
 * the caller broadcasts `txs` IN ORDER (for a package, parent then child).
 *
 * Scenario mapping:
 *   BTC   -> token   CPFP: wrap at MIN_RELAY_FEE_RATE, swap pays the package
 *   token -> BTC     CPFP: swap at MIN_RELAY_FEE_RATE, unwrap pays the package
 *   token -> token   one swap tx
 *   BTC   -> frBTC   one wrap tx
 *   frBTC -> BTC     one unwrap tx
 *
 * `params.mode` picks which side is pinned. It only reaches the AMM leg, so a
 * bare wrap and a bare unwrap ignore it entirely. See `BuildSwapParams` for how
 * `"exactOut"` reinterprets `amountIn` (a ceiling) and `minAmountOut` (exact).
 */
export async function buildSwapTransactions(
  addressProvided: TransactionAddressInput,
  params: BuildSwapParams,
  signPsbt: (unsignedPsbtBase64: string) => Promise<string>,
): Promise<BoxedResponse<BuildSwapResult, string>> {
  try {
    const {
      provider,
      network,
      from,
      to,
      amountIn,
      minAmountOut,
      feeRate,
      factoryId,
    } = params;

    const deadline = params.deadline ?? 0n;
    const frbtcId = params.frbtcId ?? FRBTC_ALKANE_ID;
    const mode: SwapMode = params.mode ?? "exactIn";
    const { assetAddress } = normalizeTransactionAddresses(addressProvided);

    if (amountIn <= 0n) {
      return new BoxedError("SwapError", "amountIn must be positive");
    }
    if (mode === "exactOut" && minAmountOut <= 0n) {
      return new BoxedError(
        "SwapError",
        "An exact-output swap needs a positive minAmountOut (it IS the requested output)",
      );
    }
    if (isBtcRef(from) && isBtcRef(to)) {
      return new BoxedError("SwapError", "BTC to BTC is not a swap");
    }
    if (!isBtcRef(from) && !isBtcRef(to) && alkaneIdsEqual(from, to)) {
      return new BoxedError("SwapError", "The two sides of a swap must differ");
    }

    const fromIsFrbtc = !isBtcRef(from) && alkaneIdsEqual(from, frbtcId);
    const toIsFrbtc = !isBtcRef(to) && alkaneIdsEqual(to, frbtcId);

    const needsSigner = isBtcRef(from) || isBtcRef(to);
    let signerAddress = "";
    if (needsSigner) {
      const resolved = await getFrbtcSignerAddress(provider, network, frbtcId);
      if (isBoxedError(resolved)) return resolved;
      signerAddress = resolved.data;
    }

    /*───────────── BTC -> frBTC: a bare wrap ─────────────*/
    if (isBtcRef(from) && toIsFrbtc) {
      const tx = await buildSingleTransaction(
        addressProvided,
        provider,
        buildWrapOptions({
          signerAddress,
          amountSats: amountIn,
          feeRate,
          frbtcId,
        }),
        "wrap",
        signPsbt,
      );
      return new BoxedSuccess({ txs: [tx] });
    }

    /*───────────── frBTC -> BTC: a bare unwrap ─────────────*/
    if (fromIsFrbtc && isBtcRef(to)) {
      const tx = await buildSingleTransaction(
        addressProvided,
        provider,
        buildUnwrapOptions({
          signerAddress,
          attachAmount: amountIn,
          requestAmount: amountIn,
          feeRate,
          frbtcId,
        }),
        "unwrap",
        signPsbt,
      );
      return new BoxedSuccess({ txs: [tx] });
    }

    /*───────────── token -> token: one swap ─────────────*/
    if (!isBtcRef(from) && !isBtcRef(to)) {
      const tx = await buildSingleTransaction(
        addressProvided,
        provider,
        buildSwapOptions({
          factoryId,
          sellId: from,
          sellAmount: amountIn,
          buyId: to,
          minAmountOut,
          deadline,
          assetAddress,
          feeRate,
          mode,
          path: params.path,
        }),
        "swap",
        signPsbt,
      );
      return new BoxedSuccess({ txs: [tx] });
    }

    /*───────────── BTC -> token: wrap, then swap ─────────────*/
    if (isBtcRef(from)) {
      const buyId = asAlkaneId(to);

      /*
        `amountIn` is what the parent wraps in BOTH modes. Under "exactOut" it
        is the sats ceiling the caller already grossed up (via the quote) so the
        minted frBTC clears the swap's `amount_in_max`; anything the AMM does
        not consume returns as frBTC rather than BTC.
      */
      const premium = consumeOrThrow(await getFrbtcPremium(provider, frbtcId));
      const minted = applyFrbtcPremium(amountIn, premium);
      if (minted <= 0n) {
        return new BoxedError(
          "SwapError",
          "The wrap premium consumes the whole amount; wrap more BTC",
        );
      }

      const packaged = await getCpfpPackageTransactions(
        addressProvided,
        {
          provider,
          parent: buildWrapOptions({
            signerAddress,
            amountSats: amountIn,
            frbtcId,
          }),
          child: buildSwapOptions({
            factoryId,
            sellId: frbtcId,
            //the whole mint is attached: exactly spent, or the op-14 ceiling
            sellAmount: minted,
            buyId,
            minAmountOut,
            deadline,
            assetAddress,
            mode,
            path: params.path,
            //the mint's exact size depends on the premium at execution time,
            //so the input amount must come from the attached parcel (op 29)
            implicitInput: mode === "exactIn",
          }),
          packageFeeRate: feeRate,
          parentFeeRate: params.parentFeeRate ?? MIN_RELAY_FEE_RATE,
          //the wrap's minted frBTC sits on parent output 0, unindexed
          parentOutputAlkanes: pointerOutputAlkanes(frbtcId, minted),
        },
        signPsbt,
      );
      if (isBoxedError(packaged)) return packaged;

      return new BoxedSuccess(toPackageResult(packaged.data, "wrap", "swap"));
    }

    /*───────────── token -> BTC: swap, then unwrap ─────────────*/
    const sellId = asAlkaneId(from);

    if (minAmountOut < FRBTC_MIN_UNWRAP) {
      return new BoxedError(
        "SwapError",
        `An unwrap must burn at least ${FRBTC_MIN_UNWRAP} sats; raise minAmountOut`,
      );
    }

    const packaged = await getCpfpPackageTransactions(
      addressProvided,
      {
        provider,
        parent: buildSwapOptions({
          factoryId,
          sellId,
          //exact-in: the amount sold. exact-out: the `amount_in_max` ceiling.
          sellAmount: amountIn,
          //exact-out makes this the frBTC the swap must deliver, and the child burns
          minAmountOut,
          buyId: frbtcId,
          deadline,
          assetAddress,
          mode,
          path: params.path,
        }),
        /*
          Under "exactIn" the parent's output is only bounded BELOW by
          minAmountOut (the AMM prices at execution), so the child burns exactly
          that guaranteed floor and any surplus frBTC simply stays in the wallet
          rather than risking a revert on an over-request. Under "exactOut" the
          parent delivers minAmountOut precisely, so the same number is the whole
          output and nothing is left behind.
        */
        child: buildUnwrapOptions({
          signerAddress,
          attachAmount: minAmountOut,
          requestAmount: minAmountOut,
          frbtcId,
        }),
        packageFeeRate: feeRate,
        parentFeeRate: params.parentFeeRate ?? MIN_RELAY_FEE_RATE,
        //the swap's bought frBTC sits on parent output 0, unindexed
        parentOutputAlkanes: pointerOutputAlkanes(frbtcId, minAmountOut),
      },
      signPsbt,
    );
    if (isBoxedError(packaged)) return packaged;

    return new BoxedSuccess(toPackageResult(packaged.data, "swap", "unwrap"));
  } catch (err) {
    return new BoxedError(
      "SwapError",
      `Failed to build the swap transactions: ${(err as Error).message}`,
    );
  }
}

function toPackageResult(
  packaged: CpfpPackageResult,
  parentLabel: SwapTxLabel,
  childLabel: SwapTxLabel,
): BuildSwapResult {
  return {
    txs: [
      {
        hex: packaged.parentHex,
        txid: packaged.parentTxid,
        label: parentLabel,
        vsize: packaged.parentVsize,
        fee: packaged.parentFee,
      },
      {
        hex: packaged.childHex,
        txid: packaged.childTxid,
        label: childLabel,
        vsize: packaged.childVsize,
        fee: packaged.childFee,
      },
    ],
    packageFeeRate: packaged.packageFeeRate,
  };
}
