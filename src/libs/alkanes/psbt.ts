import {
  Psbt,
  Signer,
  Transaction,
  address,
  networks,
  payments,
  script,
  crypto,
} from "bitcoinjs-lib";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371";
import { ECPairFactory, ECPairInterface } from "ecpair";
import { LEAF_VERSION_TAPSCRIPT } from "bitcoinjs-lib/src/payments/bip341";
import { tapleafHash } from "bitcoinjs-lib/src/payments/bip341";
import { randomBytes } from "crypto";
import {
  formatInputsToSign,
  getVSize,
  toFormattedUtxo,
  witnessStackToScriptWitness,
} from "./utils";
import { extractWithDummySigs, toEsploraTx } from "./utils";

import type {
  FormattedUtxo,
  AlkanesUtxoEntry,
  AlkaneId,
  IEsploraTransaction,
  EspoSpendableOutpoint,
} from "@/apis";
import { borshSerialize } from "borsher";
import {
  BoxedError,
  type BoxedResponse,
  BoxedSuccess,
  isBoxedError,
} from "@/boxed";
import chalk, { colors } from "chalk";
import {
  addInputDynamic,
  buildPsbtInput,
  trimUndefined,
  tweakSigner,
} from "./utils";
import { Provider } from "@/provider";
import {
  encipher,
  encodeRunestoneProtostone,
  p2tr_ord_reveal,
  ProtoStone,
} from "alkanes";
import { ProtoruneRuneId } from "alkanes/lib/protorune/protoruneruneid";
import { consumeOrThrow } from "@/boxed";
import { u128, u32 } from "@magiceden-oss/runestone-lib/dist/src/integer";
import { BorshSchema } from "borsher";
import { EcPair } from "./utils";
import { Expand } from "@/utils";
import {
  MIN_RELAY_FEE_RATE,
  computeCpfpChildFee,
  type CpfpFeeInputs,
  type CpfpFeeResult,
} from "./cpfp-fee";

export type PsbtInputExtended = Expand<Parameters<Psbt["addInput"]>[0]>;

type LeafHashInputs = Expand<Parameters<typeof tapleafHash>[0]>;

type IncludeInputOption = {
  input_extended: PsbtInputExtended;
  input_formatted: FormattedUtxo;
};

type IEdict = NonNullable<ProtoStone["edicts"]>[number];

function isBTCTransfer(
  transfer: SingularTransfer,
): transfer is SingularBTCTransfer {
  return transfer.asset === "btc";
}

type IFeeOpts = {
  vsize: number;
  input_length: number;
};

type IAvailableUtxoTweakOptions = {
  remove: Set<string>;
  add: FormattedUtxo[];
};

/*
  Wallets like OYL and Xverse expose two addresses: a payment address that holds
  plain BTC and an asset (taproot/ordinals) address that holds alkanes. The
  builder pulls alkanes UTXOs from assetAddress and BTC UTXOs from
  paymentAddress. Passing a single string uses that address for both.
*/
export type TransactionAddresses = {
  paymentAddress: string;
  assetAddress: string;
};

export type TransactionAddressInput = string | TransactionAddresses;

export function normalizeTransactionAddresses(
  input: TransactionAddressInput,
): TransactionAddresses {
  if (typeof input === "string") {
    return { paymentAddress: input, assetAddress: input };
  }
  return input;
}

/*
  ────────────────────────────  MULTI-PROTOSTONE  ────────────────────────────

  Some alkanes operations need TWO OR MORE protostones in a single tx:

  - AMM swap ("shifter"): the runtime auto-allocates every alkane sitting on
    the spent utxos into the FIRST matching protostone, which would hand the
    AMM factory all of your unrelated sibling tokens. The fix is
    protostone[0] = an edict-only stone that moves exactly the sell amount
    into protostone[1]'s shadow vout, pointing its own leftovers at change;
    protostone[1] = the message (cellpack), pointing at the receive output.

  - frBTC unwrap: the contract REJECTS a protomessage carrying edicts
    ("message cannot contain edicts, only a pointer"), so the frBTC has to
    arrive from a preceding edict-only protostone aimed at the message's
    shadow vout.
*/

/**
 * Where a pointer / edict sends its alkanes.
 *
 * - `number` — a literal output index in the final transaction.
 * - `{ protostone: n }` — the SHADOW VOUT of protostone `n` in this same
 *   transaction. Alkanes routed here land in that protostone's incoming
 *   sheet instead of paying a real output. Per the protorune convention,
 *   protostone `i` occupies vout `tx.output.length + 1 + i`, where
 *   `tx.output.length` counts the OP_RETURN that carries the runestone.
 *   Use this sentinel rather than a raw number: outputs are built inside
 *   `build()`, so callers cannot know the output count up front.
 * - `{ output: "pointer" }` — the dust output the builder always creates on
 *   the asset address to collect alkanes (the "receive" output).
 * - `{ output: "change" }` — the BTC change output. Falls back to the dust
 *   pointer output when the transaction ends up with no change.
 */
export type ProtostoneOutputRef =
  | number
  | { protostone: number }
  | { output: "pointer" | "change" };

/** `{ protostone: index }` — routes into protostone `index`'s shadow vout. */
export const toProtostone = (index: number): ProtostoneOutputRef => ({
  protostone: index,
});

/** The dust output on the asset address that collects incoming alkanes. */
export const POINTER_OUTPUT: ProtostoneOutputRef = { output: "pointer" };

/** The BTC change output (falls back to POINTER_OUTPUT when there is none). */
export const CHANGE_OUTPUT: ProtostoneOutputRef = { output: "change" };

/**
 * Resolve protostone `protostoneIndex` to its shadow vout.
 * `outputCount` is `tx.output.length`, i.e. INCLUDING the OP_RETURN.
 */
export function shadowVout(
  outputCount: number,
  protostoneIndex: number,
): number {
  return outputCount + 1 + protostoneIndex;
}

export type ProtostoneEdictSpec = {
  id: { block: bigint; tx: bigint };
  amount: bigint;
  output: ProtostoneOutputRef;
};

/**
 * One protostone in an explicit `protostones` array. When `calldata` is
 * omitted or empty the stone carries no message tag (an edict-only stone);
 * it still emits its pointer/refund tags when those are supplied.
 */
export type ProtostoneSpec = {
  edicts?: ProtostoneEdictSpec[];
  pointer?: ProtostoneOutputRef;
  refundPointer?: ProtostoneOutputRef;
  calldata?: bigint[];
};

export class AlkanesInscription<T> {
  constructor(
    public readonly shape: T,
    public readonly borshSchema: BorshSchema<T>,
  ) {}
}

export class ProtostoneTransactionWithInscription<T> {
  private commitBuilder!: ProtostoneTransaction;
  private revealBuilder!: ProtostoneTransaction;
  private script!: Buffer;
  private commitPsbt?: Psbt;
  private tweakedDummySigner: Signer;
  private tweakedPublicKey: string;
  private revealPsbt?: Psbt;
  private inscriptionBytes: Uint8Array;
  private baseSigner: ECPairInterface;
  private signedCommitTx: Transaction | null = null;
  private signedCommitEsploraTx: IEsploraTransaction | null = null;
  private baseFeeRate: number;
  private utxoTweak: IAvailableUtxoTweakOptions = {
    remove: new Set(),
    add: [],
  };

  private readonly changeAddress: string;

  constructor(
    private readonly addressProvided: TransactionAddressInput,
    private readonly inscription: AlkanesInscription<T>,
    private readonly opts: ProtostoneTransactionOptions,
  ) {
    // one lookup for the whole commit/reveal pair — nothing is broadcast
    // between the passes, so nothing changes underneath them
    this.opts = {
      ...opts,
      spendableCache: opts.spendableCache ?? new Map(),
    };
    this.changeAddress =
      normalizeTransactionAddresses(addressProvided).paymentAddress;
    this.baseSigner = EcPair.makeRandom({
      network: this.opts.provider.network,
    });

    this.tweakedDummySigner = tweakSigner(this.baseSigner, {
      network: this.opts.provider.network,
    });

    this.tweakedPublicKey = this.tweakedDummySigner.publicKey.toString("hex");
    this.baseFeeRate = this.opts.feeRate ?? this.opts.provider.defaultFeeRate;
    this.inscriptionBytes = new Uint8Array(
      borshSerialize(this.inscription.borshSchema, this.inscription.shape),
    );
  }

  public async buildCommit(): Promise<Psbt> {
    if (this.commitPsbt) return this.commitPsbt;

    const commitTransfer: SingularBTCTransfer = {
      asset: "btc",
      amount:
        546 +
        getVSize(Buffer.from(this.inscriptionBytes!)) *
          (this.opts.feeRate ?? this.opts.provider.defaultFeeRate),
      address: this.taprootAddress(),
    };
    const guessBuilder = new ProtostoneTransaction(this.addressProvided, {
      ...this.opts,
      transfers: [commitTransfer],
      feeRate: this.baseFeeRate,
      excludeProtostone: false,
    });
    await guessBuilder.build();
    const dummyTx = await guessBuilder.finalizeWithDry();

    const feeOpts = {
      vsize: dummyTx.virtualSize(),
      input_length: 3,
    };

    this.commitBuilder = new ProtostoneTransaction(this.addressProvided, {
      ...this.opts,
      transfers: [commitTransfer],
      feeRate: this.baseFeeRate,
      feeOpts,
      excludeProtostone: false,
    });
    await this.commitBuilder.build();
    this.commitPsbt = this.commitBuilder.getPsbt();

    return this.commitPsbt;
  }

  public finalizeCommit(txHex: string) {
    const tx = Transaction.fromHex(txHex);
    this.signedCommitTx = tx;

    this.signedCommitEsploraTx = toEsploraTx(tx);

    //Make sure we arent using these utxos in the building of reveal
    this.signedCommitEsploraTx.vin.forEach((input, index) => {
      this.utxoTweak.remove!.add(`${input.txid}:${input.vout}`);
    });
    tx.outs.forEach((output, index) => {
      this.utxoTweak.add.push(
        toFormattedUtxo(
          this.signedCommitEsploraTx!,
          txHex,
          this.changeAddress,
          index,
        ),
      );
    });
  }

  public async buildReveal(): Promise<Psbt> {
    if (this.revealPsbt) return this.revealPsbt;

    const p2pk_redeem = { output: this.script };
    const expectedScriptPk = payments
      .p2tr({
        internalPubkey: toXOnly(Buffer.from(this.tweakedPublicKey, "hex")),
        scriptTree: { output: this.script },
        network: this.opts.provider.network,
      })
      .output!.toString("hex");

    const commitUtxo = this.utxoTweak.add.find(
      (u) =>
        u.txId === this.signedCommitTx!.getId() &&
        u.scriptPk === expectedScriptPk,
    );

    if (!commitUtxo) {
      throw new Error(
        `Commit UTXO not found in utxoTweak. Expected scriptPk: ${expectedScriptPk}`,
      );
    }

    const { output, witness } = payments.p2tr({
      internalPubkey: toXOnly(Buffer.from(this.tweakedPublicKey, "hex")),
      scriptTree: p2pk_redeem,
      redeem: p2pk_redeem,
      network: this.opts.provider.network,
    });

    let commitTxInput: PsbtInputExtended = {
      hash: commitUtxo.txId,
      index: commitUtxo.outputIndex,
      witnessUtxo: {
        value: commitUtxo.satoshis,
        script: output ?? Buffer.from(""),
      },
      tapLeafScript: [
        {
          leafVersion: LEAF_VERSION_TAPSCRIPT,
          script: p2pk_redeem.output,
          controlBlock: witness![witness!.length - 1],
        },
      ],
    };

    let commitTxInputOption = {
      input_extended: commitTxInput,
      input_formatted: toFormattedUtxo(
        this.signedCommitEsploraTx!,
        this.signedCommitTx!.toHex(),
        this.changeAddress,
        commitTxInput.index,
      ),
    };

    let dry = await getDummyProtostoneTransaction(this.addressProvided, {
      ...this.opts,
      includeInputs: [commitTxInputOption],
      availableUtxoTweak: this.utxoTweak,
      feeRate: this.baseFeeRate + 1,
    });
    if (isBoxedError(dry)) throw new Error(dry.message);

    const witnessWeight = this.script.length * 1; // 1 weight unit per byte
    dry.data.feeOpts.vsize += Math.ceil(witnessWeight / 4);

    this.revealBuilder = new ProtostoneTransaction(this.addressProvided, {
      ...this.opts,
      includeInputs: [commitTxInputOption],
      availableUtxoTweak: this.utxoTweak,
      feeOpts: dry.data.feeOpts,
      feeRate: this.baseFeeRate + 1,
    });
    await this.revealBuilder.build();
    this.revealPsbt = this.revealBuilder.getPsbt();

    const formattedPsbt = formatInputsToSign({
      _psbt: this.revealPsbt,
      senderPublicKey: this.baseSigner.publicKey.toString("hex"),
      network: this.opts.provider.network,
    });

    formattedPsbt.signInput(0, this.tweakedDummySigner);
    formattedPsbt.finalizeInput(0);
    return formattedPsbt;
  }

  public extractPsbts(): [string, string] {
    if (!this.commitPsbt || !this.revealPsbt)
      throw new Error("Build both PSBTs first");
    return [this.commitPsbt.toBase64(), this.revealPsbt.toBase64()];
  }

  private taprootAddress(): string {
    let xOnlyPubkey = toXOnly(Buffer.from(this.tweakedPublicKey, "hex"));

    const script = Buffer.from(
      p2tr_ord_reveal(xOnlyPubkey, [
        {
          body: this.inscriptionBytes,
          cursed: false,
          tags: { contentType: "" },
        },
      ]).script,
    );
    const inscriberInfo = payments.p2tr({
      internalPubkey: xOnlyPubkey,
      scriptTree: {
        output: script,
      },
      network: this.opts.provider.network,
    });

    this.script = script;

    return inscriberInfo.address!;
  }
}

export class ProtostoneTransaction {
  private MINIMUM_FEE = 500;
  private MINIMUM_PROTOCOL_DUST = 546;

  //These are used to calculate the fee and outputs that will be used in the transaction. These are not in the final transaction
  private availableUtxos: FormattedUtxo[] = [];

  //These are the utxos that will be used in the transaction
  private utxos: FormattedUtxo[] = [];

  //Keep track of the current PSBT
  private psbt: Psbt;

  //On the second run, the fee will be calculated based on the vsize of the first transaction
  public fee = 0;

  //transaction options
  private transactionOptions: {
    provider: Provider;

    callData?: bigint[]; // Call data to be included in the Protostone

    /*
      Explicit multi-protostone construction. When supplied this REPLACES the
      default single-protostone build entirely: `callData` and the edicts
      derived from `transfers` are no longer written into the runestone, so
      the caller owns every edict and pointer. `transfers` still drives BTC
      outputs and utxo selection. Leave undefined for the default behaviour.
    */
    protostones?: ProtostoneSpec[];

    /*
      Shared across every transaction of one block (and across a transaction's
      own measure/build passes): an address's spendable outpoints are fetched
      once rather than once per pass. Leave it undefined to fetch every time.
    */
    spendableCache?: Map<string, Promise<FormattedUtxo[]>>;

    ignoreAlkanesUtxoCheck?: boolean; // If true, it will not check if the alkanes UTXOs are sufficient

    //If etching or mint are included, a new output will be created to collect the alkanes
    transfers: SingularTransfer[];
    feeOpts?: IFeeOpts;
    feeRate?: number;

    /*
      Pin the fee to an exact absolute amount (sats), bypassing feeRate * vsize.
      Used by CPFP packages, where the child must pay a precise deficit so the
      PACKAGE hits the target rate.
    */
    absoluteFee?: number;

    /*
      Override the 500 sat fee floor. A CPFP parent deliberately pays close to
      the relay minimum, which is well under the default floor, so it must be
      lowered (or set to 0) for the package arithmetic to hold.
    */
    minimumFee?: number;
    //signPsbt: LaserEyesClient["signPsbt"]; transaction is unfinalized
    availableUtxoTweak?: IAvailableUtxoTweakOptions;

    //Dont try to include inputs when buyer is trying to transfer alkanes out of the psbts
    ignoreAlkanesRequirementCheck?: boolean;
    /*
    If included, outputs that bypass the TX factories transfer check will be forcefully added. Used when creating PSBT sell orders,
    where we dont know where the BTC in the pay vout will be from, but needs to be signed by the seller anyways.
    */
    psbtTransfers?: SingularBTCTransfer[];

    overrideInputs?: FormattedUtxo[] | null /* 
    If true, it will force these inputs to be present in the transaction and not include anything else.  This is useful for UTXO creation,
    where we want to determine the inputs that we need in a deterministic fashion, and override looking for inputs to fulfill the alkanes requirements
    */;

    /*
      useful for reveals on inscriptions
    */
    includeInputs?: IncludeInputOption[];

    includePsbts?: string[];
    /*
    Will forecully include these inputs in the transaction even if they arent needed. This is for PSBT buy orders that need to include
    the inputs they are trying to buy. This is different from overrideInputs, because these inputs are included alongside inputs the tx factory
    uses to satisfy 'transfers'.
  */
    excludeProtostone?: boolean; // If true, it will not include the Protostone in the transaction
  };

  private changeAddress: string;
  private assetAddress: string;
  //ids (txid:vout) of every available utxo that came from the payment address
  private paymentUtxoIds = new Set<string>();
  //set during fetchUtxos: true when any selected input came from the payment address
  private pulledFromPaymentAddress = false;
  private cumulativeSpendRequirementBtc = 0;
  private cumulativeSpendRequirementAlkanes: Record<string, bigint> = {};
  private cumulativeValueInPsbts: number = 0;

  constructor(
    addressProvided: TransactionAddressInput,
    private readonly options: ProtostoneTransactionOptions,
  ) {
    this.psbt = new Psbt({
      network: options.provider.network,
      maximumFeeRate: 1_000_000_000,
    });
    const addresses = normalizeTransactionAddresses(addressProvided);
    this.changeAddress = addresses.paymentAddress;
    this.assetAddress = addresses.assetAddress;

    this.transactionOptions = {
      provider: options.provider,
      feeOpts: options.feeOpts,
      feeRate: options.feeRate ?? options.provider.defaultFeeRate,
      psbtTransfers: options.psbtTransfers ?? [],
      overrideInputs: options.overrideInputs ?? null,
      includeInputs: options.includeInputs ?? [],
      includePsbts: options.includePsbts ?? [],
      availableUtxoTweak: options.availableUtxoTweak ?? {
        remove: new Set(),
        add: [],
      },
      ignoreAlkanesRequirementCheck:
        options.ignoreAlkanesRequirementCheck ?? false,
      ignoreAlkanesUtxoCheck: options.ignoreAlkanesUtxoCheck ?? false,
      spendableCache: options.spendableCache,
      transfers: options.transfers ?? [],
      callData: options.callData ?? [],
      excludeProtostone: options.excludeProtostone ?? false,
      //left undefined when absent so the default single-protostone path is
      //bit-for-bit what it always was
      protostones: options.protostones,
      absoluteFee: options.absoluteFee,
      minimumFee: options.minimumFee,
    };
  }

  //bindings to the provider's rpc methods
  private get espo_getAddressSpendableOutpoints() {
    return this.transactionOptions.provider.rpc.espo.getAddressSpendableOutpoints.bind(
      this.transactionOptions.provider.rpc.espo,
    );
  }

  private get esplora_getfee() {
    return this.transactionOptions.provider.rpc.electrum.esplora_getfee.bind(
      this.transactionOptions.provider.rpc.electrum,
    );
  }

  private addInputDynamic(utxo: FormattedUtxo): void {
    addInputDynamic(this.psbt, this.transactionOptions.provider.network, utxo);
  }

  private formatEspoSpendableOutpoint(
    address: string,
    spendable: EspoSpendableOutpoint,
  ): FormattedUtxo {
    const [txId, outputIndexRaw] = spendable.outpoint.split(":");
    const outputIndex = Number(outputIndexRaw);

    if (!txId || !Number.isInteger(outputIndex)) {
      throw new Error(`Invalid espo outpoint: ${spendable.outpoint}`);
    }

    if (!spendable.raw_tx_hex || spendable.raw_tx_hex === "0") {
      throw new Error(
        `Espo did not return raw tx hex for ${spendable.outpoint}`,
      );
    }

    const prevTx = Transaction.fromHex(spendable.raw_tx_hex);
    const status = {
      confirmed: spendable.confirmations > 0,
      ...(spendable.block_height != null
        ? { block_height: spendable.block_height }
        : {}),
    };
    const esploraTx = toEsploraTx(
      prevTx,
      status,
      this.transactionOptions.provider.network,
    );
    const prevOut = esploraTx.vout[outputIndex];

    if (!prevOut) {
      throw new Error(`Espo raw tx is missing vout for ${spendable.outpoint}`);
    }

    const alkanes = (spendable.alkanes ?? []).reduce(
      (acc, entry) => {
        const existing = acc[entry.alkane]?.value ?? "0";
        acc[entry.alkane] = {
          id: entry.alkane,
          name: "",
          symbol: "",
          value: (BigInt(existing) + BigInt(entry.amount)).toString(),
        };

        return acc;
      },
      {} as Record<string, AlkanesUtxoEntry>,
    );

    const runes = (spendable.runes ?? []).reduce(
      (acc, entry) => {
        acc[entry.rune] = {
          amount: Number(entry.amount),
          divisibility: 0,
        };

        return acc;
      },
      {} as FormattedUtxo["runes"],
    );

    return {
      txId,
      outputIndex,
      satoshis: spendable.value,
      address: prevOut.scriptpubkey_address || address,
      scriptPk: spendable.script_pubkey_hex,
      confirmations: spendable.confirmations,
      indexed: spendable.confirmations > 0,
      inscriptions: [],
      runes,
      alkanes,
      prevTx: esploraTx,
      prevTxHex: spendable.raw_tx_hex,
    };
  }

  private async loadSpendableUtxos(address: string): Promise<FormattedUtxo[]> {
    const spendableOutpoints = consumeOrThrow(
      await this.espo_getAddressSpendableOutpoints(address, {
        omitRawTx: false,
      }),
    );

    return spendableOutpoints.outpoints.map((outpoint) =>
      this.formatEspoSpendableOutpoint(spendableOutpoints.address, outpoint),
    );
  }

  /*
    What an address can spend doesn't change while a block is being assembled,
    but every transaction is built twice — once to measure it, once for real —
    and a block builds many. Left alone that is one identical round trip per
    pass per address. A caller that knows the answer is stable for the whole
    build hands in a cache; without one nothing is shared and the behaviour is
    exactly what it was.

    The cache holds the in-flight promise, not the result, so concurrent passes
    coalesce onto one request. Callers only ever read filtered copies of what
    comes back, so the shared array is never mutated.
  */
  private fetchSpendableUtxos(address: string): Promise<FormattedUtxo[]> {
    const cache = this.transactionOptions.spendableCache;
    const inFlight = cache?.get(address);
    if (inFlight) return inFlight;
    const pending = this.loadSpendableUtxos(address);
    cache?.set(address, pending);
    return pending;
  }

  private async fetchResources(): Promise<void> {
    const removed = this.transactionOptions.availableUtxoTweak!.remove!;
    const notRemoved = (utxo: FormattedUtxo) =>
      !removed.has(`${utxo.txId}:${utxo.outputIndex}`);

    //BTC utxos come from the payment address
    const paymentUtxos = (
      await this.fetchSpendableUtxos(this.changeAddress)
    ).filter(notRemoved);
    this.paymentUtxoIds = new Set(
      paymentUtxos.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    );

    //alkanes utxos come from the asset address
    const assetUtxos =
      this.assetAddress === this.changeAddress
        ? []
        : (await this.fetchSpendableUtxos(this.assetAddress)).filter(
            notRemoved,
          );

    this.availableUtxos = [...paymentUtxos];
    assetUtxos.forEach((utxo) => {
      const utxoId = `${utxo.txId}:${utxo.outputIndex}`;
      if (!this.paymentUtxoIds.has(utxoId)) {
        this.availableUtxos.push(utxo);
      }
    });

    this.transactionOptions.availableUtxoTweak!.add!.forEach((utxo) => {
      const utxoId = `${utxo.txId}:${utxo.outputIndex}`;

      if (
        this.availableUtxos.some((u) => `${u.txId}:${u.outputIndex}` === utxoId)
      ) {
        return; // already in available UTXOs
      }
      /*
        Tweak-added utxos (eg commit change, or a CPFP parent's outputs) are
        spendable as BTC — UNLESS they carry alkanes. An alkane-bearing utxo is
        never eligible for BTC coin selection anyway, and tagging it as a
        payment utxo would make `isAssetUtxo` reject it in two-address mode,
        hiding the alkanes a still-unbroadcast parent just produced.
      */
      if (Object.keys(utxo.alkanes ?? {}).length === 0) {
        this.paymentUtxoIds.add(utxoId);
      }
      this.availableUtxos.push(utxo);
    });

    /*
      On the first "dry" run, there will be no vsize, so the fee will be 500 * minimumRate - which is the minimum for the network
    */
    await this.calculateFee();

    return;
  }

  private async calculateFee(): Promise<void> {
    // A caller-supplied floor wins over the built-in one; 0 is a valid floor
    // (a CPFP parent pays near the relay minimum, far below the 500 default).
    const minimumFee =
      this.transactionOptions.minimumFee ?? this.MINIMUM_FEE;

    // An explicit absolute fee skips rate * vsize entirely.
    if (this.transactionOptions.absoluteFee !== undefined) {
      this.fee = Math.max(
        Math.ceil(this.transactionOptions.absoluteFee),
        minimumFee,
      );
      return;
    }

    let feeRate = this.transactionOptions.feeRate;
    if (!feeRate) {
      const feeResp = this.transactionOptions.feeOpts
        ? await this.esplora_getfee()
        : new BoxedSuccess(1);
      feeRate = isBoxedError(feeResp) ? 1 : feeResp.data;
    }
    //Seee suggestion @ https://github.com/bitcoinjs/bitcoinjs-lib/issues/1566
    const baseFee =
      Math.ceil(
        (this.transactionOptions.feeOpts?.vsize ?? 0) +
          (this.transactionOptions.feeOpts?.input_length ?? 0) * 2,
      ) * feeRate;

    this.fee = Math.max(Math.ceil(baseFee), minimumFee);
  }

  private calcCumulativeSpendRequirements() {
    this.cumulativeSpendRequirementBtc =
      this.fee +
      this.MINIMUM_PROTOCOL_DUST *
        (this.transactionOptions.transfers?.length ?? 0) +
      this.MINIMUM_PROTOCOL_DUST;


    this.cumulativeSpendRequirementAlkanes =
      this.transactionOptions.transfers.reduce(
        (acc, transfer) => {
          if (isBTCTransfer(transfer)) {
            this.cumulativeSpendRequirementBtc += transfer.amount;
            return acc;
          }

          const alkanesId = this.mappableAlkaneId(transfer.asset);
          acc[alkanesId] = (acc[alkanesId] || 0n) + transfer.amount;

          return acc;
        },
        {} as Record<string, bigint>,
      );

    return;
  }

  private mappableAlkaneId(alkaneId: AlkaneId): string {
    return `${Number(alkaneId.block)}:${Number(alkaneId.tx)}`;
  }

  private utxoId(utxo: FormattedUtxo): string {
    return `${utxo.txId}:${utxo.outputIndex}`;
  }

  private isPaymentUtxo(utxo: FormattedUtxo): boolean {
    return this.paymentUtxoIds.has(this.utxoId(utxo));
  }

  //In single-address mode every utxo is eligible to carry alkanes
  private isAssetUtxo(utxo: FormattedUtxo): boolean {
    if (this.assetAddress === this.changeAddress) {
      return true;
    }
    return !this.isPaymentUtxo(utxo);
  }

  private isUnlockedUtxo(utxo: FormattedUtxo): boolean {
    let isUnlocked =
      utxo.inscriptions.length === 0 && Object.keys(utxo.runes).length === 0;
    if (!isUnlocked) {
      console.warn(
        chalk.yellow(
          `UTXO ${utxo.txId}:${utxo.outputIndex} is locked due to inscriptions or runes. Skipping...`,
        ),
      );
    }
    //dont allow the spending of any utxos that have any ordinals or runes
    return isUnlocked;
  }

  //This function gets the txids of all the utxos that are needed to meet the alkanes requirement
  private getAlkanesUtxosToMeetAlkanesRequirement(): Set<FormattedUtxo> {
    const alkanesUtxos: Set<FormattedUtxo> = new Set();
    if (
      this.transactionOptions.overrideInputs ||
      this.transactionOptions.ignoreAlkanesRequirementCheck
    ) {
      return alkanesUtxos;
    }

    for (const alkanes of Object.keys(this.cumulativeSpendRequirementAlkanes)) {
      /*
              .sort((a, b) =>
          a.balance < b.balance ? -1 : a.balance > b.balance ? 1 : 0
        );
        First we sort the utxo balances by their "balance" in ascending order. The cli does
        automatic utxo management, so we use "dust" values first so that the address has as
        few UTXOs as possible, even if it means using more UTXOs to meet the requirement.
      */
      const alkanesUtxoBalances = this.availableUtxos.filter(
        (utxo) =>
          //alkanes are only ever pulled from the asset address
          this.isAssetUtxo(utxo) &&
          `${utxo.alkanes?.[alkanes]?.id}` === alkanes &&
          //Check for ordinal inscriptions, runes and mezcals
          this.isUnlockedUtxo(utxo),
      ) as Omit<FormattedUtxo[], "alkanes"> & {
        alkanes: Record<string, AlkanesUtxoEntry>;
      };

      //console.dir(this.availableUtxos, { depth: null, colors: true });
      //console.dir(alkanesUtxoBalances, { depth: null, colors: true });
      /*console.dir(this.cumulativeSpendRequirementAlkanes, {
        depth: null,
        colors: true,
      });
      */
      const sortedAlkanesUtxoBalances = alkanesUtxoBalances.sort((a, b) =>
        a.satoshis < b.satoshis ? -1 : a.satoshis > b.satoshis ? 1 : 0,
      );

      /*
        Forced inputs (includeInputs, e.g. a pinned CPFP parent output) already
        deliver their alkanes, so selection only needs to cover the remainder —
        and must not re-select the forced outpoints.
      */
      const forcedInputs = this.transactionOptions.includeInputs ?? [];
      const forcedIds = new Set(
        forcedInputs.map((i) => this.utxoId(i.input_formatted)),
      );
      let accumulated = forcedInputs.reduce(
        (acc, i) =>
          acc + BigInt(i.input_formatted.alkanes?.[alkanes]?.value ?? 0),
        0n,
      );
      for (const utxo of sortedAlkanesUtxoBalances) {
        if (accumulated >= this.cumulativeSpendRequirementAlkanes[alkanes]) {
          break;
        }
        if (forcedIds.has(this.utxoId(utxo))) {
          continue;
        }

        accumulated += BigInt(utxo.alkanes[alkanes].value);
        alkanesUtxos.add(utxo);
      }

      if (accumulated < this.cumulativeSpendRequirementAlkanes[alkanes]) {
        throw new Error(
          `Insufficient Alkanes UTXOs to meet the requirement for ${alkanes}.`,
        );
      }
    }
    return alkanesUtxos;
  }

  private getEsploraUtxosToMeetAllRequirements(): FormattedUtxo[] {
    if (this.transactionOptions.overrideInputs) {
      return this.transactionOptions.overrideInputs;
    }

    const alkanesUtxos = !this.transactionOptions.ignoreAlkanesUtxoCheck
      ? this.getAlkanesUtxosToMeetAlkanesRequirement()
      : new Set<FormattedUtxo>();

    let utxosToMeetRequirementsSet = new Map<string, FormattedUtxo>();

    let availableUtxosMap = this.availableUtxos.reduce((acc, utxo) => {
      acc.set(`${utxo.txId}:${utxo.outputIndex}`, utxo);
      return acc;
    }, new Map<string, FormattedUtxo>());

    const sortedUtxos = [...this.availableUtxos].sort(
      (a, b) => b.satoshis - a.satoshis,
    );

    //Add all alkanes utxos to the utxosToMeetRequirements
    let accumulated = 0;

    for (const input of this.transactionOptions.includeInputs ?? []) {
      const utxoId = `${input.input_formatted.txId}:${input.input_formatted.outputIndex}`;
      utxosToMeetRequirementsSet.set(
        utxoId,

        //This doesnt matter because the adddynamicinput function will never read this as a check before it handles and removes it from the set
        input.input_formatted,
      );
      accumulated += input.input_formatted.satoshis;
    }

    for (const alkanesUtxo of alkanesUtxos) {
      const utxoId = `${alkanesUtxo.txId}:${alkanesUtxo.outputIndex}`;
      if (alkanesUtxo.prevTx === null) {
        throw new Error(`Alkanes UTXO ${utxoId} does not have a transaction.`);
      }
      const esploraUtxo = availableUtxosMap.get(utxoId);

      if (!esploraUtxo) {
        continue;
      }

      accumulated += Number(alkanesUtxo.satoshis);
      utxosToMeetRequirementsSet.set(utxoId, esploraUtxo);
    }

    for (const utxo of sortedUtxos) {
      const utxoId = `${utxo.txId}:${utxo.outputIndex}`;
      //BTC is only ever pulled from the payment address
      if (!this.isPaymentUtxo(utxo)) {
        continue;
      }
      if (!this.isUnlockedUtxo(utxo)) {
        continue;
      }
      if (accumulated >= this.cumulativeSpendRequirementBtc) {
        break;
      }

      if (utxosToMeetRequirementsSet.has(utxoId)) {
        continue;
      }

      if (Object.keys(utxo.alkanes).length > 0) {
        continue;
      }

      if (utxo.satoshis < 1000) {
        continue;
      }

      utxosToMeetRequirementsSet.set(utxoId, utxo);
      accumulated += utxo.satoshis;
    }
    if (accumulated < this.cumulativeSpendRequirementBtc) {
      throw new Error(
        `Insufficient ${this.transactionOptions.provider.btcTicker} UTXOs to meet the requirement for ${this.transactionOptions.provider.btcTicker}.`,
      );
    }

    return [...Array.from(utxosToMeetRequirementsSet.values())];
  }

  private fetchUtxos(): void {
    if (!this.availableUtxos) {
      throw new Error("Must call fetchResources before fetchUtxos");
    }
    this.calcCumulativeSpendRequirements();
    this.utxos = this.getEsploraUtxosToMeetAllRequirements();
    this.pulledFromPaymentAddress = this.utxos.some((utxo) =>
      this.isPaymentUtxo(utxo),
    );
  }

  /*
    A protostone (and its dust pointer output) is only needed when the tx
    actually carries alkane data: either alkanes ride on the selected inputs
    (a pointer must capture them instead of letting them burn), or we're
    writing a message (a contract call). A pure BTC transfer with neither is a
    plain payment and gets no protostone and no dust output.
  */
  private shouldIncludeProtostone(): boolean {
    if (this.transactionOptions.excludeProtostone) {
      return false;
    }
    return (
      this.hasCustomProtostones() ||
      this.hasAlkanesInInputs() ||
      this.hasProtostoneMessage()
    );
  }

  /** True when the caller supplied an explicit `protostones` array. */
  private hasCustomProtostones(): boolean {
    return (this.transactionOptions.protostones?.length ?? 0) > 0;
  }

  /** True when any selected input utxo carries an alkane balance. */
  private hasAlkanesInInputs(): boolean {
    return this.utxos.some(
      (utxo) => Object.keys(utxo.alkanes ?? {}).length > 0,
    );
  }

  /** True when we're writing a message (a contract call) into the protostone. */
  private hasProtostoneMessage(): boolean {
    return (this.transactionOptions.callData?.length ?? 0) > 0;
  }

  private async initialize(): Promise<void> {
    await this.calculateFee();
    await this.fetchResources();
    this.fetchUtxos();
  }

  private getBtcOutputs(): Record<string, number> {
    const cumulativeBtcRequirementsPerAddress: Record<string, number> = {};

    for (const transfer of this.transactionOptions.transfers) {
      if (isBTCTransfer(transfer) && transfer.ignorePush) {
        continue;
      }
      const current =
        cumulativeBtcRequirementsPerAddress[transfer.address] || 0;

      if (isBTCTransfer(transfer)) {
        cumulativeBtcRequirementsPerAddress[transfer.address] =
          current + transfer.amount;
      } else {
        // Ensure we don't lower an existing value below dust
        cumulativeBtcRequirementsPerAddress[transfer.address] = current;
      }
    }

    for (const address in cumulativeBtcRequirementsPerAddress) {
      const amount = cumulativeBtcRequirementsPerAddress[address];
      cumulativeBtcRequirementsPerAddress[address] = Math.max(
        amount,
        this.MINIMUM_PROTOCOL_DUST,
      );
    }

    return cumulativeBtcRequirementsPerAddress;
  }

  private addOutputs(btcOutputs: Record<string, number>): boolean {
    let hasChange = false;
    const includeAlkanesPointerOutput = this.shouldIncludeProtostone();

    const totalOutputValue = Object.values(btcOutputs).reduce(
      (acc, amount) => acc + amount,
      0,
    );

    const totalInputValue = this.utxos.reduce(
      (acc, utxo) => acc + utxo.satoshis,
      0,
    );

    const changeValue = Math.round(
      totalInputValue -
        totalOutputValue -
        this.fee -
        this.cumulativeValueInPsbts -
        (includeAlkanesPointerOutput ? this.MINIMUM_PROTOCOL_DUST : 0),
    );

    //Dust output on the asset address to catch all incoming alkanes via the
    //protostone pointer/refund pointer
    if (includeAlkanesPointerOutput) {
      this.psbt.addOutput({
        address: this.assetAddress,
        value: this.MINIMUM_PROTOCOL_DUST,
      });
    }

    //Outputs for edicts and transfers
    for (const [address, amount] of Object.entries(btcOutputs)) {
      this.psbt.addOutput({
        address,
        value: amount,
      });
    }
    //final change output
    try {
      if (changeValue < 546) {
        return false;
      }
      hasChange = true;
      this.psbt.addOutput({
        address: this.changeAddress,
        value: changeValue,
      });
    } catch (e) {
      throw new Error("Insufficient funds for change output. ");
    }

    return hasChange;
  }

  private addInputs(): void {
    const addedInputs = new Set<string>();
    for (const input of this.transactionOptions.includeInputs ?? []) {
      this.psbt.addInput(input.input_extended);
      addedInputs.add(
        `${input.input_formatted.txId}:${input.input_formatted.outputIndex}`,
      );
    }

    for (const utxo of this.utxos) {
      if (addedInputs.has(`${utxo.txId}:${utxo.outputIndex}`)) {
        continue; // Skip if already added
      }

      this.addInputDynamic(utxo);
    }
  }

  private createEdicts(
    btcOutputs: Record<string, number>,
    hasChange: boolean,
  ): IEdict[] {
    //Mapped by address, and then alkanesID. Everything is flattened in the end
    const alkanesEdicts: Record<string, Record<string, IEdict>> = {};
    const outputIds: Record<string, number> = {};

    let outputIndex = this.transactionOptions.includePsbts!.length;
    for (const [address, amount] of Object.entries(btcOutputs)) {
      outputIds[address] = outputIndex;
      outputIndex++;
    }

    for (const transfer of this.transactionOptions.transfers) {
      if (transfer.asset === "btc") {
        continue;
      }
      const alkanesId = this.mappableAlkaneId(transfer.asset);
      const address = transfer.address;

      const alkanesEdict = {
        id: new ProtoruneRuneId(
          u128(transfer.asset.block),
          u128(transfer.asset.tx),
        ),
        // Convert bigint to string for JSON compatibility
        amount: u128(transfer.amount),
        output: u32(outputIds[address] + 1),
      };
      if (!alkanesEdicts[address]) {
        alkanesEdicts[address] = {};
      }

      if (!alkanesEdicts[address][alkanesId]) {
        alkanesEdicts[address][alkanesId] = alkanesEdict;
      } else {
        alkanesEdicts[address][alkanesId].amount = u128(
          BigInt(alkanesEdicts[address][alkanesId].amount) +
            BigInt(alkanesEdict.amount),
        );
      }
    }

    const transactionEdicts = Object.values(alkanesEdicts).flatMap(
      (addressEdicts) =>
        Object.values(addressEdicts).map((edict) => ({
          id: edict.id,
          amount: edict.amount,
          output: edict.output,
        })),
    );


    return transactionEdicts;
  }

  private resolveOutputRef(
    ref: ProtostoneOutputRef,
    ctx: {
      realOutputCount: number;
      pointerOutputIndex: number;
      changeOutputIndex: number;
    },
  ): number {
    if (typeof ref === "number") {
      return ref;
    }
    if ("protostone" in ref) {
      /*
        The OP_RETURN has not been appended yet, so the FINAL output count is
        the current one plus one. Protostone i then sits at
        tx.output.length + 1 + i.
      */
      return shadowVout(ctx.realOutputCount + 1, ref.protostone);
    }
    return ref.output === "change"
      ? ctx.changeOutputIndex
      : ctx.pointerOutputIndex;
  }

  private buildCustomProtostones(hasChange: boolean): ProtoStone[] {
    const specs = this.transactionOptions.protostones!;

    //outputs currently on the psbt, i.e. everything except the OP_RETURN
    const realOutputCount = this.psbt.txOutputs.length;
    //the alkanes dust output sits right after any appended psbt outputs
    const pointerOutputIndex = this.transactionOptions.includePsbts!.length;
    //change, when present, is always the last output added before the OP_RETURN
    const changeOutputIndex = hasChange
      ? realOutputCount - 1
      : pointerOutputIndex;

    const ctx = { realOutputCount, pointerOutputIndex, changeOutputIndex };

    return specs.map((spec) => {
      const edicts: IEdict[] = (spec.edicts ?? []).map((edict) => ({
        id: new ProtoruneRuneId(u128(edict.id.block), u128(edict.id.tx)),
        amount: u128(edict.amount),
        output: u32(this.resolveOutputRef(edict.output, ctx)),
      }));

      const hasCalldata = (spec.calldata?.length ?? 0) > 0;
      const hasPointer =
        spec.pointer !== undefined || spec.refundPointer !== undefined;

      //no message and no pointer at all: a bare edict-only stone
      if (!hasCalldata && !hasPointer) {
        return ProtoStone.edicts({ protocolTag: 1n, edicts });
      }

      const pointer = this.resolveOutputRef(spec.pointer ?? POINTER_OUTPUT, ctx);
      const refundPointer = this.resolveOutputRef(
        spec.refundPointer ?? spec.pointer ?? POINTER_OUTPUT,
        ctx,
      );

      /*
        An empty calldata emits the POINTER/REFUND tags but NO message tag, so
        this is still an edict-only stone as far as the runtime is concerned.
        That is exactly what a shifter's protostone[0] wants (edicts plus a
        pointer at change) and what a contract rejecting "message with edicts"
        requires of the stone feeding it.
      */
      return ProtoStone.message({
        protocolTag: 1n,
        edicts,
        pointer,
        refundPointer,
        calldata: encipher(spec.calldata ?? []),
      });
    });
  }

  private addProtostoneData(
    edicts?: IEdict[],
    hasChange: boolean = false,
  ): Buffer | undefined {
    if (!this.shouldIncludeProtostone()) {
      return undefined;
    }

    //The alkanes dust output sits right after any appended psbt outputs
    const alkanesPointerOutputIndex =
      this.transactionOptions.includePsbts!.length;

    const protostones = this.hasCustomProtostones()
      ? this.buildCustomProtostones(hasChange)
      : [
          ProtoStone.message({
            protocolTag: 1n,
            edicts: edicts,
            pointer: alkanesPointerOutputIndex,
            refundPointer: alkanesPointerOutputIndex,
            calldata: encipher(this.transactionOptions.callData ?? []),
          }),
        ];

    const protostoneBuffer = encodeRunestoneProtostone({
      protostones,
    }).encodedRunestone;

    this.psbt.addOutput({ script: protostoneBuffer, value: 0 });

    return protostoneBuffer;
  }

  private appendSinglePsbtToTx(psbtBase64: string): void {
    if (/^[0-9a-fA-F]+$/.test(psbtBase64)) {
      psbtBase64 = Buffer.from(psbtBase64, "hex").toString("base64");
    }
    const sellerPsbt = Psbt.fromBase64(psbtBase64, {
      network: this.transactionOptions.provider.network,
    });

    const sellerInput = sellerPsbt.data.inputs[0];
    const sellerOutpt = sellerPsbt.txOutputs[0];
    const txInput = sellerPsbt.txInputs[0]; // outpoint + sequence

    if (!sellerInput.finalScriptWitness && !sellerInput.finalScriptSig) {
      throw new Error("Seller PSBT is not finalized / missing signatures");
    }

    this.psbt.addInput(
      trimUndefined({
        hash: txInput.hash,
        index: txInput.index,
        sequence: txInput.sequence,
        witnessUtxo: sellerInput.witnessUtxo,
        tapInternalKey: sellerInput.tapInternalKey,
        witnessScript: sellerInput.witnessScript,
        nonWitnessUtxo: sellerInput.nonWitnessUtxo,
        redeemScript: sellerInput.redeemScript,
        finalScriptSig: sellerInput.finalScriptSig,
        finalScriptWitness: sellerInput.finalScriptWitness,
      }),
    );

    this.psbt.addOutput({
      script: sellerOutpt.script,
      value: sellerOutpt.value,
    });

    this.cumulativeValueInPsbts += sellerOutpt.value;
  }

  private appendPsbtsToTx(): void {
    if (this.transactionOptions.includePsbts!.length === 0) return;

    for (const sellerBase64 of this.transactionOptions.includePsbts!) {
      try {
        this.appendSinglePsbtToTx(sellerBase64);
      } catch (error) {
        console.error(
          chalk.red("Failed to append PSBT to transaction:"),
          error,
        );
        throw new Error("Failed to append PSBT to transaction");
      }
    }
  }

  public async build(): Promise<[number, Buffer | undefined]> {
    await this.initialize();

    this.appendPsbtsToTx();

    this.addInputs();
    const btcOutputs = this.getBtcOutputs();

    const hasChange = this.addOutputs(btcOutputs);

    const edicts = this.createEdicts(btcOutputs, hasChange);
    let protostone = this.addProtostoneData(edicts, hasChange);

    //If we have a alkanestone, we need to add a second output for the opreturn. Otherwise just one for the change
    return [this.utxos.length + (protostone ? 2 : 1), protostone];
  }

  public async finalizeWithDry(): Promise<Transaction> {
    return extractWithDummySigs(this.psbt);
  }

  public extractPsbtBase64(): string {
    return this.psbt.toBase64();
  }

  public getPsbt(): Psbt {
    return this.psbt;
  }
}

export type SingularBTCTransfer = {
  asset: "btc";
  amount: number;
  address: string;
  ignorePush?: boolean; //If true, the transfer will not be pushed to the alkanestone
};

export type SingularAlkanesTransfer = {
  asset: AlkaneId; // Alkanes protocol ID (eg: 2:1231231)
  amount: bigint;
  address: string;
};

export type SingularTransfer = SingularBTCTransfer | SingularAlkanesTransfer;

export type ProtostoneTransactionOptions =
  (typeof ProtostoneTransaction)["prototype"]["transactionOptions"];

type IProtostoneTransactionDryRunResponse = {
  dummyTx: Transaction;
  dummyInputLength: number;
  useMaraPool: boolean;
  feeOpts: IFeeOpts;
};

export async function getDummyProtostoneTransaction(
  addressProvided: TransactionAddressInput,
  options: ProtostoneTransactionOptions,
): Promise<BoxedResponse<IProtostoneTransactionDryRunResponse, string>> {
  try {
    const dummyAlkanessTx = new ProtostoneTransaction(addressProvided, options);
    const [dummyInputLength, dummyProtostone] = await dummyAlkanessTx.build();
    let useMaraPool = false;

    if (dummyProtostone) {
      if (dummyProtostone.byteLength > 80) {
        useMaraPool = true;
        console.log(
          chalk.yellow(
            `\nWARNING: Protostone exceeds 80 bytes.\n` +
              `Only MARA pool currently supports OP_RETURNs over 80 bytes.\n` +
              `This transaction may take hours or even a day to confirm.\n` +
              `Proposal to increase the limit: https://github.com/bitcoin/bitcoin/pull/32359\n`,
          ),
        );
      }
    }
    const dummyTx = await dummyAlkanessTx.finalizeWithDry();

    const feeOpts = {
      vsize: dummyTx.virtualSize(),
      input_length: dummyInputLength,
    };

    return new BoxedSuccess({
      dummyTx,
      dummyInputLength,
      useMaraPool,
      feeOpts,
    });
  } catch (e) {
    console.log("Error creating dummy transaction", e);
    return new BoxedError("Failed to create dummy transaction: " +
        (e instanceof Error ? e.message : "Unknown error"), "TransactionError");
  }
}

//[transaction, useMaraPool] = getProtostoneTransaction(address, options)
export async function getProtostoneUnsignedPsbtBase64(
  addressProvided: TransactionAddressInput,
  options: Omit<ProtostoneTransactionOptions, "psbtTransfers">,
): Promise<
  BoxedResponse<
    {
      fee: number;
      psbtBase64: string;
      vsize: number;
      useMaraPool: boolean;
    },
    string
  >
> {
  /*
    The measure pass and the build pass see the same chain state — nothing is
    broadcast between them — so the address's spendable outpoints are fetched
    once and shared, not asked for twice.
  */
  options = {
    ...options,
    spendableCache: options.spendableCache ?? new Map(),
  };
  const response = await getDummyProtostoneTransaction(
    addressProvided,
    options,
  );
  if (isBoxedError(response)) {
    return response;
  }

  const { dummyTx, dummyInputLength, useMaraPool } = response.data;

  const vsize = dummyTx.virtualSize();

  const alkanestoneTx = new ProtostoneTransaction(addressProvided, {
    ...options,
    feeOpts: {
      vsize,
      input_length: dummyInputLength,
    },
  });
  await alkanestoneTx.build();
  const psbtBase64 = await alkanestoneTx.extractPsbtBase64();

  return new BoxedSuccess({
    psbtBase64,
    useMaraPool,
    vsize,
    fee: alkanestoneTx.fee,
  });
}

/*
  ──────────────────────────────────  CPFP  ──────────────────────────────────
*/

export {
  MIN_RELAY_FEE_RATE,
  computeCpfpChildFee,
  type CpfpFeeInputs,
  type CpfpFeeResult,
};

/** Sum the input values of an unsigned psbt (witness or legacy). */
function sumPsbtInputValues(psbt: Psbt): number {
  return psbt.data.inputs.reduce((acc, input, index) => {
    if (input.witnessUtxo) {
      return acc + input.witnessUtxo.value;
    }
    if (input.nonWitnessUtxo) {
      const prev = Transaction.fromBuffer(input.nonWitnessUtxo);
      return acc + prev.outs[psbt.txInputs[index].index].value;
    }
    throw new Error(`PSBT input ${index} carries no utxo information`);
  }, 0);
}

const sumTxOutputValues = (tx: Transaction): number =>
  tx.outs.reduce((acc, out) => acc + out.value, 0);

export type CpfpPackageResult = {
  parentHex: string;
  childHex: string;
  parentTxid: string;
  childTxid: string;
  parentFee: number;
  childFee: number;
  parentVsize: number;
  childVsize: number;
  /** the rate the package actually achieves, sat/vB */
  packageFeeRate: number;
};

export type CpfpPackageParams = {
  provider: Provider;
  /** built first, pays ~the relay floor */
  parent: Omit<ProtostoneTransactionOptions, "provider" | "psbtTransfers">;
  /** built second, spends a parent output and pays the package deficit */
  child: Omit<ProtostoneTransactionOptions, "provider" | "psbtTransfers">;
  /** the rate the whole package should achieve (sat/vB) */
  packageFeeRate: number;
  /** parent rate; defaults to MIN_RELAY_FEE_RATE */
  parentFeeRate?: number;
  /*
    Alkane balances the PARENT's outputs will carry once it is indexed. The
    parent is not broadcast yet, so espo cannot know about them and
    `toFormattedUtxo` would hand the child a bare BTC utxo — leaving the child
    unable to select the alkanes the parent just produced (a wrap's minted
    frBTC, a swap's bought token, …). Keyed by parent output index; the inner
    record is keyed "block:tx", matching `FormattedUtxo["alkanes"]`.
  */
  parentOutputAlkanes?: Record<number, Record<string, AlkanesUtxoEntry>>;
};

/**
 * Build and sign a 2-transaction CPFP package. The child spends an output of
 * the still-unbroadcast parent, and pays enough that the PACKAGE hits
 * `packageFeeRate`. Broadcast parent first, then child (or submit as a
 * package).
 */
export async function getCpfpPackageTransactions(
  addressProvided: TransactionAddressInput,
  params: CpfpPackageParams,
  signPsbt: (unsignedPsbtBase64: string) => Promise<string>,
): Promise<BoxedResponse<CpfpPackageResult, string>> {
  try {
    const { provider, packageFeeRate } = params;
    const parentFeeRate = params.parentFeeRate ?? MIN_RELAY_FEE_RATE;
    const changeAddress =
      normalizeTransactionAddresses(addressProvided).paymentAddress;

    /*
      One spendable-outpoints lookup for the whole package. The parent and
      the child spend against the same chain state — the child's view of the
      still-unbroadcast parent is expressed through utxoTweak, not through a
      refetch — so every measure and build pass of both shares this cache.
    */
    const spendableCache =
      params.parent.spendableCache ??
      params.child.spendableCache ??
      new Map<string, Promise<FormattedUtxo[]>>();

    /* 1. parent, at the relay floor, with the 500 sat floor disabled */
    const parentOptions: ProtostoneTransactionOptions = {
      ...params.parent,
      provider,
      feeRate: parentFeeRate,
      minimumFee: params.parent.minimumFee ?? 0,
      spendableCache,
    };

    const parentBuild = await getProtostoneUnsignedPsbtBase64(
      addressProvided,
      parentOptions,
    );
    if (isBoxedError(parentBuild)) {
      return parentBuild;
    }

    const parentInputValue = sumPsbtInputValues(
      Psbt.fromBase64(parentBuild.data.psbtBase64, {
        network: provider.network,
      }),
    );

    const parentHex = await signPsbt(parentBuild.data.psbtBase64);
    const parentTx = Transaction.fromHex(parentHex);
    const parentTxid = parentTx.getId();
    const parentVsize = parentTx.virtualSize();
    const parentFee = parentInputValue - sumTxOutputValues(parentTx);

    if (parentFee <= 0) {
      return new BoxedError(`CPFP parent has a non-positive fee (${parentFee} sats)`, "TransactionError");
    }

    /*
      2. chain the child onto the unconfirmed parent, exactly like
      ProtostoneTransactionWithInscription.finalizeCommit: drop every outpoint
      the parent spends (espo still reports them as spendable, the parent is
      not broadcast yet) and offer the parent's own outputs as available utxos.
    */
    const parentEsploraTx = toEsploraTx(
      parentTx,
      { confirmed: false },
      provider.network,
    );

    const utxoTweak: IAvailableUtxoTweakOptions = {
      remove: new Set(params.child.availableUtxoTweak?.remove ?? []),
      add: [...(params.child.availableUtxoTweak?.add ?? [])],
    };

    parentEsploraTx.vin.forEach((input) => {
      utxoTweak.remove.add(`${input.txid}:${input.vout}`);
    });

    /*
      Only outputs paying a script THIS wallet controls may enter the child's
      spendable set. A parent can pay third parties — a wrap pays `amountIn`
      sats to the frBTC signer — and blanket-adding those would let BTC coin
      selection (largest-first) pick an unsignable input and sink the build.
    */
    const assetAddress =
      normalizeTransactionAddresses(addressProvided).assetAddress;
    const ownedScripts = new Map<string, string>();
    for (const owned of new Set([changeAddress, assetAddress])) {
      ownedScripts.set(
        address.toOutputScript(owned, provider.network).toString("hex"),
        owned,
      );
    }

    /*
      The alkane-carrying parent output (a wrap's minted frBTC, a swap's bought
      token) is PINNED as a forced child input: it both guarantees the child
      actually spends the parent (a package that isn't linked isn't a package)
      and delivers the parent's alkanes without racing pre-existing wallet
      utxos in selection. A parent with no alkane outputs pins its largest
      owned output instead, for the linkage alone.
    */
    const pinnedInputs: IncludeInputOption[] = [
      ...(params.child.includeInputs ?? []),
    ];
    const pinnedIds = new Set(
      pinnedInputs.map(
        (i) => `${i.input_formatted.txId}:${i.input_formatted.outputIndex}`,
      ),
    );
    let pinnedAlkaneOutput = false;
    let largestOwned: FormattedUtxo | undefined;

    parentTx.outs.forEach((out, index) => {
      //skip the 0-value OP_RETURN, it is not spendable
      if (out.value <= 0) return;
      const ownerAddress = ownedScripts.get(
        Buffer.from(out.script).toString("hex"),
      );
      if (!ownerAddress) return;
      const utxo = toFormattedUtxo(
        parentEsploraTx,
        parentHex,
        ownerAddress,
        index,
      );
      const alkanes = params.parentOutputAlkanes?.[index];
      if (alkanes) {
        utxo.alkanes = { ...alkanes };
      }
      utxoTweak.add.push(utxo);

      const utxoId = `${utxo.txId}:${utxo.outputIndex}`;
      if (alkanes && !pinnedIds.has(utxoId)) {
        pinnedInputs.push({
          input_extended: buildPsbtInput(provider.network, utxo),
          input_formatted: utxo,
        });
        pinnedIds.add(utxoId);
        pinnedAlkaneOutput = true;
      }
      if (
        !alkanes &&
        (!largestOwned || utxo.satoshis > largestOwned.satoshis)
      ) {
        largestOwned = utxo;
      }
    });

    if (!pinnedAlkaneOutput) {
      if (largestOwned) {
        const utxoId = `${largestOwned.txId}:${largestOwned.outputIndex}`;
        if (!pinnedIds.has(utxoId)) {
          pinnedInputs.push({
            input_extended: buildPsbtInput(provider.network, largestOwned),
            input_formatted: largestOwned,
          });
        }
      } else {
        return new BoxedError("No CPFP parent output is spendable by this wallet; the child cannot be linked to the parent", "TransactionError");
      }
    }

    const childOptions: ProtostoneTransactionOptions = {
      ...params.child,
      provider,
      availableUtxoTweak: utxoTweak,
      includeInputs: pinnedInputs,
      feeRate: params.child.feeRate ?? packageFeeRate,
      spendableCache,
    };

    /*
      3. size the child at its REAL fee. The dry vsize depends on coin
      selection, and selection depends on the fee (a larger fee can pull in
      inputs the first dry never saw, growing the vsize and the fee again), so
      iterate dummy builds to a fixed point: selection is deterministic, so
      once a build AT the target fee needs no more than that fee, the real
      build selects the same inputs and its signed vsize is bounded by the
      dummy's (dummy sigs are worst-case sized).
    */
    const dry = await getDummyProtostoneTransaction(
      addressProvided,
      childOptions,
    );
    if (isBoxedError(dry)) {
      return dry;
    }

    let feeOpts = dry.data.feeOpts;
    let targetChildFee = computeCpfpChildFee({
      parentFee,
      parentVsize,
      childVsize: feeOpts.vsize,
      packageFeeRate,
    }).childFee;

    for (let attempt = 0; attempt < 5; attempt++) {
      const redry = await getDummyProtostoneTransaction(addressProvided, {
        ...childOptions,
        feeOpts,
        absoluteFee: targetChildFee,
        minimumFee: params.child.minimumFee ?? 0,
      });
      if (isBoxedError(redry)) {
        return redry;
      }
      feeOpts = redry.data.feeOpts;
      const nextFee = computeCpfpChildFee({
        parentFee,
        parentVsize,
        childVsize: feeOpts.vsize,
        packageFeeRate,
      }).childFee;
      if (nextFee <= targetChildFee) {
        //the selection at targetChildFee needs no more than targetChildFee;
        //keep the larger figure so the package can only overshoot the target
        break;
      }
      targetChildFee = nextFee;
    }

    /* 4. rebuild the child pinned to that exact fee, then sign it */
    const childBuilder = new ProtostoneTransaction(addressProvided, {
      ...childOptions,
      feeOpts,
      absoluteFee: targetChildFee,
      minimumFee: params.child.minimumFee ?? 0,
    });
    await childBuilder.build();

    const childPsbtBase64 = childBuilder.extractPsbtBase64();
    const childInputValue = sumPsbtInputValues(
      Psbt.fromBase64(childPsbtBase64, { network: provider.network }),
    );

    const childHex = await signPsbt(childPsbtBase64);
    const childTx = Transaction.fromHex(childHex);
    const childVsize = childTx.virtualSize();
    const childFee = childInputValue - sumTxOutputValues(childTx);

    /*
      A child that did not actually spend the parent is not a package at all,
      it is just two independent transactions. The pinned includeInputs above
      make this structurally impossible; the guard stays as a tripwire.
    */
    const spendsParent = childTx.ins.some(
      (input) =>
        Buffer.from(input.hash).reverse().toString("hex") === parentTxid,
    );
    if (!spendsParent) {
      return new BoxedError("CPFP child does not spend any output of the parent; the package would not be a package", "TransactionError");
    }

    /*
      Safety net for the fixed-point loop above: a package under the requested
      rate may never confirm in exactly the congestion the user paid to beat,
      so refuse to return one (the epsilon absorbs float noise).
    */
    const achievedRate = (parentFee + childFee) / (parentVsize + childVsize);
    if (achievedRate + 1e-6 < packageFeeRate) {
      return new BoxedError(`CPFP package underpays the target rate (${achievedRate.toFixed(3)} < ${packageFeeRate} sat/vB) after fee sizing`, "TransactionError");
    }

    return new BoxedSuccess({
      parentHex,
      childHex,
      parentTxid,
      childTxid: childTx.getId(),
      parentFee,
      childFee,
      parentVsize,
      childVsize,
      packageFeeRate:
        (parentFee + childFee) / (parentVsize + childVsize),
    });
  } catch (error) {
    console.error("Error creating CPFP package:", error);
    return new BoxedError("Failed to create CPFP package: " +
        (error instanceof Error ? error.message : "Unknown error"), "TransactionError");
  }
}

export async function getProtostoneTransactionsWithInscription<T>(
  addressProvided: TransactionAddressInput,
  inscription: AlkanesInscription<T>,
  signPsbt: (unisignedPsbtBase64: string) => Promise<string>,
  options: Omit<ProtostoneTransactionOptions, "psbtTransfers">,
): Promise<BoxedResponse<[string, string], string>> {
  try {
    const wrapper = new ProtostoneTransactionWithInscription(
      addressProvided,
      inscription,
      options,
    );
    const commitPsbt = await wrapper.buildCommit();
    const signedTx = await signPsbt(commitPsbt.toBase64());
    wrapper.finalizeCommit(signedTx);
    const revealPsbt = await wrapper.buildReveal();
    const revealSignedTx = await signPsbt(revealPsbt.toBase64());
    return new BoxedSuccess([signedTx, revealSignedTx]);
  } catch (error) {
    console.error(
      "Error creating Protostone transactions with inscription:",
      error,
    );
    return new BoxedError("Failed to create Protostone transactions with inscription: " +
        (error instanceof Error ? error.message : "Unknown error"), "TransactionError");
  }
}
