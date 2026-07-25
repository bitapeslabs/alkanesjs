/*───────────────────────────────────────────────────────────────
  ACCOUNTS, TRANSACTIONS, BLOCKS
  ---------------------------------------------------------------
  A contract knows how to encode a call. It does not know who is
  making it, what they hold, or which outputs their alkanes should
  land on — that belongs to whoever is spending, so it lives here.

    const alice = new AlkanesAccount({ provider, address });

    const tx = alice.tx()
      .call(pool).swap(args, send => send(TOKEN_0, amountIn))
      .transfer(TOKEN_1, amount, bob);

  Each transaction really is a Bitcoin transaction: inputs chosen
  from what the account can spend, outputs, and an OP_RETURN
  carrying the protostones. Chaining them with `.and()` makes a
  block, which goes to `kirby_simulateblock` as raw transaction
  hex — the same bytes a node would see.

  An account holding a key finalizes its transactions with real
  signatures. One that doesn't finalizes with placeholder witnesses
  instead, which is enough: nothing in a simulated block verifies a
  signature, so you can ask what an address you don't control would
  get. The bytes are a well-formed transaction either way.
──────────────────────────────────────────────────────────────*/

import * as bitcoin from "bitcoinjs-lib";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371";
import { AlkaneId, FormattedUtxo } from "@/apis";
import type { Provider } from "@/provider";
import { BoxedError, BoxedResponse, BoxedSuccess, isBoxedError } from "@/boxed";
import { AlkanesSimulationError } from "../interfaces/base";
import type {
  AlkanesTraceEncodedResult,
  AlkanesTraceResult,
} from "@/apis/alkanes/types";
import { decodeTrace } from "@/apis/alkanes/utils";
import type { AlkabiDocument } from "../alkabi/types";
import type { InferAlkabiIo } from "../alkabi/infer";
import {
  CHANGE_OUTPUT,
  POINTER_OUTPUT,
  ProtostoneSpec,
  ProtostoneTransaction,
  TransactionAddressInput,
  TransactionAddresses,
  normalizeTransactionAddresses,
  toProtostone,
  type SingularTransfer,
} from "./psbt";
import {
  EcPair,
  extractWithDummySigs,
  toEsploraTx,
  tweakSigner,
} from "./utils";

/*------------------------------------------------------------*
 | What a contract has to expose to be callable from a tx      |
 *------------------------------------------------------------*/

/**
 * The part of a contract a transaction builder uses. `D` is a phantom: the
 * alkabi document the contract was built from, which is what lets `.call(pool)`
 * offer that contract's own methods with their own argument types.
 */
export interface CallableContract<D = unknown> {
  readonly alkaneId: AlkaneId;
  /** Phantom — never read at runtime. */
  readonly __alkabi?: D;
  /** Encode `method`'s argument into the words a protostone message carries. */
  encodeCall(
    method: string,
    arg?: unknown,
  ): { alkaneId: AlkaneId; calldata: bigint[]; outShape: unknown };
  /** Turn returndata into this method's declared output type. */
  decodeReturn(bytes: Uint8Array, outShape: unknown): unknown;
}

/*------------------------------------------------------------*
 | Account                                                     |
 *------------------------------------------------------------*/

export interface AlkanesAccountOptions {
  provider: Provider;
  /**
   * The address(es) this account spends from. Pass a single string to use one
   * address for both BTC and alkanes, or `{ paymentAddress, assetAddress }` to
   * hold assets somewhere other than where the sats come from.
   *
   * Omit it when `wif` is given — the taproot address is derived from the key.
   */
  address?: TransactionAddressInput;
  /** A private key, in WIF. Its transactions come out signed. */
  wif?: string;
  /**
   * An external signer (a browser wallet). Takes an unsigned psbt in base64 and
   * returns a signed one. Supersedes `wif` when both are given.
   */
  signPsbt?: (unsigned: string) => Promise<string>;
  /** Overrides the provider's default for every transaction this account makes. */
  feeRate?: number;
}

/**
 * Someone who can spend. Holds the addresses transactions are built from and,
 * when it has a key, the ability to sign them.
 */
export class AlkanesAccount {
  readonly provider: Provider;
  readonly addresses: TransactionAddresses;
  readonly feeRate?: number;

  private readonly keypair?: ReturnType<typeof EcPair.fromWIF>;
  private readonly externalSigner?: (unsigned: string) => Promise<string>;

  constructor(options: AlkanesAccountOptions) {
    this.provider = options.provider;
    this.feeRate = options.feeRate;
    this.externalSigner = options.signPsbt;

    if (options.wif) {
      this.keypair = EcPair.fromWIF(options.wif, options.provider.network);
    }

    const derived = this.keypair
      ? bitcoin.payments.p2tr({
          internalPubkey: toXOnly(Buffer.from(this.keypair.publicKey)),
          network: options.provider.network,
        }).address
      : undefined;

    const given = options.address ?? derived;
    if (!given) {
      throw new Error("AlkanesAccount: needs an address or a wif");
    }
    this.addresses = normalizeTransactionAddresses(given);
  }

  /** Where this account's sats come from — and where change goes back to. */
  get address(): string {
    return this.addresses.paymentAddress;
  }

  /** Where this account's alkanes live. */
  get assetAddress(): string {
    return this.addresses.assetAddress;
  }

  /** Whether transactions from this account come out with real signatures. */
  get canSign(): boolean {
    return Boolean(this.keypair || this.externalSigner);
  }

  /** Sign an unsigned psbt. Throws for an account with no key. */
  async sign(unsignedBase64: string): Promise<string> {
    if (this.externalSigner) {
      return this.externalSigner(unsignedBase64);
    }
    if (!this.keypair) {
      throw new Error(
        `AlkanesAccount(${this.address}): view-only — it holds no key to sign with`,
      );
    }
    const psbt = bitcoin.Psbt.fromBase64(unsignedBase64, {
      network: this.provider.network,
    });
    const tweaked = tweakSigner(this.keypair, {
      network: this.provider.network,
    });
    psbt.data.inputs.forEach((input, index) => {
      // taproot key-path spends sign with the tweaked key; anything else with
      // the plain one
      psbt.signInput(index, input.tapInternalKey ? tweaked : this.keypair!);
    });
    psbt.finalizeAllInputs();
    return psbt.toBase64();
  }

  /** Start a transaction spending from this account. */
  tx(): AlkaneTx {
    return new AlkaneTx(this);
  }
}

/*------------------------------------------------------------*
 | Transaction                                                 |
 *------------------------------------------------------------*/

/** An amount of one alkane. */
export interface AlkaneAmount {
  id: AlkaneId;
  amount: bigint;
}

/** What a call is paid with — one alkane, or several. */
export type Pays = AlkaneAmount | readonly AlkaneAmount[];

const isAmount = (value: unknown): value is AlkaneAmount =>
  value !== null &&
  typeof value === "object" &&
  "id" in value &&
  "amount" in value;

/**
 * Whether a first argument is really the payment. A method taking no argument
 * can still be paid, so `.forwardIncoming({ id, amount })` has to be told apart
 * from a method whose own argument sits in that slot.
 */
function isPays(value: unknown): value is Pays {
  return Array.isArray(value) ? value.every(isAmount) : isAmount(value);
}

const toSends = (pays?: Pays): AlkaneAmount[] =>
  !pays ? [] : Array.isArray(pays) ? [...pays] : [pays as AlkaneAmount];

/*
  The methods `.call(contract)` offers: the contract's own, each taking its
  declared argument and, optionally, what to pay it with.
*/
type ArgOf<M, T extends AlkabiDocument["types"]> = M extends { input: infer I }
  ? [arg: InferAlkabiIo<I, T>]
  : [];

type OutOf<M, T extends AlkabiDocument["types"]> = M extends { output: infer O }
  ? InferAlkabiIo<O, T>
  : Uint8Array;

export type TxCalls<D> = D extends AlkabiDocument
  ? {
      [M in D["methods"][number] as M["name"] & string]: (
        ...args: [...ArgOf<M, D["types"]>, pays?: Pays]
      ) => AlkaneTx<OutOf<M, D["types"]>>;
    }
  : Record<string, (arg?: unknown, pays?: Pays) => AlkaneTx<unknown>>;

/** How a transaction's slot in a block resolves. */
type SlotMode =
  | { kind: "outcome" }
  | { kind: "unwrap" }
  | { kind: "expect"; message: string }
  | { kind: "unwrapOr"; fallback: unknown }
  | { kind: "toNullable" };

interface PlannedCall {
  contract: CallableContract;
  method: string;
  arg?: unknown;
  sends: AlkaneAmount[];
  /** Which output this call's result lands on. Defaults to the alkanes output. */
  pointer?: number;
  /** Where its incoming goes if it reverts. Defaults to change. */
  refund?: number;
  /** Hand what this call returned to the next call instead of to an output. */
  carry?: boolean;
}

/** An alkane handed to someone, as a plain move. */
interface Handoff {
  id: AlkaneId;
  amount: bigint;
  address: string;
}

/** An outpoint this transaction spends that is not on chain yet. */
interface PendingInput {
  /** The transaction itself, or its position in the block being simulated. */
  from: AlkaneTx<any, any> | number;
  vout: number;
  /** What it holds, when the transaction producing it can't say by itself. */
  holds?: readonly AlkaneAmount[];
}

/** A transaction after it has been built: real bytes, with a real txid. */
export interface BuiltTx {
  hex: string;
  txid: string;
  /**
   * What this transaction's own edicts put on each real output. Known because
   * we wrote them — a call's result is not, since only the simulation knows
   * how much it returned; say that with `.spending(tx, vout, holds)`.
   */
  holds: Map<number, AlkaneAmount[]>;
  /** False when the account had no key and the witnesses are placeholders. */
  signed: boolean;
  psbtBase64: string;
  transaction: bitcoin.Transaction;
}

/** What a simulated block reports back about one transaction. */
export interface TxOutcome {
  txid: string;
  hex: string;
  signed: boolean;
  /** One entry per `.call()`, in the order they were added. */
  calls: BoxedResponse<unknown, AlkanesSimulationError>[];
  /** What each real output ended up holding. */
  outputs: { vout: number; alkanes: { id: string; value: string }[] }[];
  /**
   * What the indexer would have recorded, ready to read: ids, amounts and
   * inputs already `bigint`, one entry per protostone that ran a message,
   * filed under the outpoint the indexer would have filed it under
   * (`txid:shadowVout`).
   *
   *     for (const { outpoint, events } of tx.trace) …
   */
  trace: { outpoint: string; events: AlkanesTraceResult }[];
  /**
   * The same traces exactly as they came off the wire — espo's own JSON, with
   * every value still a `0x` hex string. Hand this to espo verbatim; read
   * `trace` instead if you want to use the values.
   */
  traces: { outpoint: string; events: AlkanesTraceEncodedResult }[];
  /** The last call's result — the transaction's answer. */
  result: BoxedResponse<unknown, AlkanesSimulationError>;
  /** True when every call in this transaction succeeded. */
  ok: boolean;
}

/**
 * One Bitcoin transaction under construction.
 *
 * Steps run in the order they were chained. Each call becomes its own
 * protostone, and the runtime settles protostones in order, so `.swap()` really
 * does happen before the `.unwrap()` chained after it. Transfers come last and
 * a call cannot follow one — they settle from what the transaction is left
 * holding, so putting a call after one would be a lie about the order.
 *
 * The alkanes flow through those stones:
 *
 *   inputs → stone 0 (the router) → each call's shadow vout → … → outputs
 *
 * Everything riding on the inputs is auto-allocated to the first stone, which
 * is the only place from which anything can be aimed. The router pays each call
 * exactly what `.swap(args, pays)` named — nothing else reaches it. A call's
 * result then lands on the alkanes output, or, with `.carry()`, in the next
 * call's shadow vout, which is how one call pays for the next.
 */
export class AlkaneTx<Out = Uint8Array, Slot = TxOutcome> {
  private readonly calls: PlannedCall[] = [];  // read by the `.call()` proxy
  private readonly handoffs: Handoff[] = [];
  private readonly payments: { address: string; sats: number }[] = [];
  private readonly pending: PendingInput[] = [];
  private mode: SlotMode = { kind: "outcome" };
  private built?: BuiltTx;

  constructor(readonly account: AlkanesAccount) {}

  /* ── how this transaction's slot in a block resolves ───────────
     Left alone a slot is the whole `TxOutcome`. These say "just give
     me the answer", so a block can be destructured straight into
     values instead of unwrapping five of them afterwards. */

  /** Resolve to the last call's value; a revert rejects the whole block. */
  unwrap(): AlkaneTx<Out, Out> {
    this.mode = { kind: "unwrap" };
    return this as unknown as AlkaneTx<Out, Out>;
  }

  /** `unwrap` with your own message on failure. */
  expect(message: string): AlkaneTx<Out, Out> {
    this.mode = { kind: "expect", message };
    return this as unknown as AlkaneTx<Out, Out>;
  }

  /** Resolve to the value, or `fallback` if this transaction reverted. */
  unwrapOr(fallback: Out): AlkaneTx<Out, Out> {
    this.mode = { kind: "unwrapOr", fallback };
    return this as unknown as AlkaneTx<Out, Out>;
  }

  /** Resolve to the value, or `null` if this transaction reverted. */
  toNullable(): AlkaneTx<Out, Out | null> {
    this.mode = { kind: "toNullable" };
    return this as unknown as AlkaneTx<Out, Out | null>;
  }

  /** Apply the chosen mode to what the block reported. */
  resolve(outcome: TxOutcome): Slot {
    const { result } = outcome;
    switch (this.mode.kind) {
      case "outcome":
        return outcome as Slot;
      case "unwrap":
        return result.unwrap() as Slot;
      case "expect":
        return result.expect(this.mode.message) as Slot;
      case "unwrapOr":
        return (isBoxedError(result) ? this.mode.fallback : result.data) as Slot;
      case "toNullable":
        return result.toNullable() as Slot;
    }
  }

  /**
   * Aim at a contract, then name the method — the methods are the contract's
   * own, so this is where its ABI shows up:
   *
   *     .call(pool).swap(args, { id: TOKEN_0, amount: amountIn })
   *
   * The second argument says what the call is paid with — one alkane or a list
   * of them. Those alkanes reach the call and nothing else does.
   */
  call<D>(contract: CallableContract<D>): TxCalls<D> {
    if (this.handoffs.length > 0 || this.payments.length > 0) {
      throw new Error(
        "tx: a call cannot follow a transfer — transfers settle from what the " +
          "transaction is left holding, so they always come last",
      );
    }
    const tx = this;
    return new Proxy(Object.create(null), {
      get(_target, method) {
        if (typeof method !== "string") return undefined;
        return (arg?: unknown, pays?: Pays) => {
          // a method taking no argument is still allowed to be paid
          const [realArg, realPays] =
            arg !== undefined && isPays(arg)
              ? [undefined, arg as Pays]
              : [arg, pays];
          tx.calls.push({
            contract: contract as CallableContract,
            method,
            arg: realArg,
            sends: toSends(realPays),
          });
          return tx;
        };
      },
    }) as TxCalls<D>;
  }

  /** Where the last call's result is allocated (default: the alkanes output). */
  pointer(vout: number): this {
    this.requireCall("pointer").pointer = vout;
    return this;
  }

  /**
   * Hand what the last call returned to the next one instead of to an output:
   *
   *     .call(pool).swap(args, pays).carry().call(frbtc).unwrap(args)
   *
   * The swap's output becomes what the unwrap is paid with, without ever
   * touching a real output. Under the hood the call points at the next stone's
   * shadow vout, which is where a protostone's incoming comes from.
   */
  carry(): this {
    this.requireCall("carry").carry = true;
    return this;
  }

  /** Where the last call's incoming goes if it reverts (default: change). */
  refund(vout: number): this {
    this.requireCall("refund").refund = vout;
    return this;
  }

  /**
   * Hand something to someone. No contract runs — an alkane simply moves to an
   * output that recipient controls, which is how one holder pays another.
   *
   *     .transfer(TOKEN_1, amount, bob)   // alkanes
   *     .transfer(10_000, bob)            // sats
   */
  transfer(sats: number, to: AlkanesAccount | string): this;
  transfer(asset: AlkaneId, amount: bigint, to: AlkanesAccount | string): this;
  transfer(
    assetOrSats: AlkaneId | number,
    amountOrTo: bigint | AlkanesAccount | string,
    maybeTo?: AlkanesAccount | string,
  ): this {
    if (typeof assetOrSats === "number") {
      this.payments.push({
        sats: assetOrSats,
        address: addressOf(amountOrTo as AlkanesAccount | string),
      });
      return this;
    }
    this.handoffs.push({
      id: assetOrSats,
      amount: amountOrTo as bigint,
      address: addressOf(maybeTo!),
    });
    return this;
  }

  /**
   * Spend an output of an earlier transaction in the same block. That output
   * does not exist on chain, so no lookup can find it — naming it here is what
   * lets a transaction be paid by the one before it.
   *
   * Name it either by the transaction itself, or by its position in the block,
   * which is what lets a whole block be written as one array:
   *
   *     .spending(1, KEPT)          // output KEPT of the block's second tx
   *     .spending(bought, KEPT)     // the same, by name
   *
   * If that transaction put the alkanes there with an edict, this already
   * knows what the outpoint carries and coin selection can account for it. A
   * call's result is different — nothing knows how much came back until the
   * block runs — so say what you are spending:
   *
   *     .spending(3, KEPT, [{ id: TOKEN_0, amount: backOut }])
   */
  spending(
    from: AlkaneTx<any, any> | number,
    vout: number,
    holds?: readonly AlkaneAmount[],
  ): this {
    this.pending.push({ from, vout, holds });
    return this;
  }

  /**
   * Build the transaction and return its bytes. `context` is what the rest of
   * the block has already done — see `BlockContext`.
   */
  async build(context?: BlockContext): Promise<BuiltTx> {
    if (this.built) return this.built;

    const dangling = this.calls.findIndex(
      (call, i) => call.carry && i + 1 === this.calls.length,
    );
    if (dangling >= 0) {
      throw new Error(
        `tx: .carry() after ${this.calls[dangling].method} has nothing to carry to`,
      );
    }

    for (const pending of this.pending) {
      // an input can only be described once the transaction producing it exists
      await this.source(pending, context).build(context);
    }

    // even on its own a transaction is built twice — measured, then built —
    // so it shares one lookup with itself when no block supplies the cache
    const { options, holds } = this.buildOptions(
      context ?? {
        spent: new Set(),
        available: [],
        spendable: new Map(),
        txs: [this],
      },
    );

    // Two passes: the first only exists to measure the transaction, since the
    // fee depends on its size and the size depends on the fee.
    const dry = new ProtostoneTransaction(this.account.addresses, options);
    const [inputCount] = await dry.build();
    const vsize = (await dry.finalizeWithDry()).virtualSize();

    const real = new ProtostoneTransaction(this.account.addresses, {
      ...options,
      feeOpts: { vsize, input_length: inputCount },
    });
    await real.build();

    const unsigned = real.extractPsbtBase64();
    let transaction: bitcoin.Transaction;
    let signed = false;

    if (this.account.canSign) {
      const signedPsbt = await this.account.sign(unsigned);
      transaction = bitcoin.Psbt.fromBase64(signedPsbt, {
        network: this.account.provider.network,
      }).extractTransaction();
      signed = true;
    } else {
      // no key: placeholder witnesses. The bytes are still a transaction, and
      // a simulated block never looks at a signature.
      transaction = extractWithDummySigs(real.getPsbt());
    }

    this.built = {
      hex: transaction.toHex(),
      txid: transaction.getId(),
      holds,
      signed,
      psbtBase64: unsigned,
      transaction,
    };
    return this.built;
  }

  /** Simulate this transaction on its own, as a one-transaction block. */
  send(): Promise<Slot> {
    return runSimulatedBlock(this.account.provider, [this]).then(
      ([only]) => only as Slot,
    );
  }

  then<R1 = Slot, R2 = never>(
    onFulfilled?: ((value: Slot) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.send().then(onFulfilled, onRejected);
  }

  /* ── internals ─────────────────────────────────────────────── */

  /** The transaction an input comes from, by object or by block position. */
  private source(
    pending: PendingInput,
    context?: BlockContext,
  ): AlkaneTx<any, any> {
    const { from } = pending;
    if (typeof from !== "number") return from;
    const at = context?.txs?.[from];
    if (!at) {
      throw new Error(
        `tx: .spending(${from}, …) names position ${from} of the block, but ` +
          "this transaction is not being simulated as part of one",
      );
    }
    if (at === this) {
      throw new Error(`tx: .spending(${from}, …) names itself`);
    }
    return at;
  }

  private requireCall(what: string): PlannedCall {
    const last = this.calls[this.calls.length - 1];
    if (!last) throw new Error(`tx: .${what}() before any call`);
    return last;
  }

  /** The contracts and output shapes each call's result decodes with. */
  decoders(): { contract: CallableContract; outShape: unknown }[] {
    return this.calls.map((c) => ({
      contract: c.contract,
      outShape: c.contract.encodeCall(c.method, c.arg).outShape,
    }));
  }

  private buildOptions(context: BlockContext) {
    /*
      Outputs come out in a fixed order: the alkanes dust output first, then one
      per address anything is destined for, then change. Knowing that order up
      front is what lets an edict name the output a handoff lands on.
    */
    const transfers: SingularTransfer[] = [];
    const outputIndexOf = new Map<string, number>();
    const noteAddress = (address: string) => {
      if (!outputIndexOf.has(address)) {
        outputIndexOf.set(address, outputIndexOf.size + 1);
      }
    };

    for (const handoff of this.handoffs) {
      transfers.push({
        asset: handoff.id,
        amount: handoff.amount,
        address: handoff.address,
      });
      noteAddress(handoff.address);
    }
    for (const payment of this.payments) {
      transfers.push({
        asset: "btc",
        amount: payment.sats,
        address: payment.address,
      });
      noteAddress(payment.address);
    }
    /*
      What a call is paid with has to be *selected* as well as routed: the
      builder only reaches for alkane-bearing utxos when a transfer asks for
      that alkane. Aiming it at our own asset address keeps it ours — the edicts
      below are what actually hand it to the call.
    */
    for (const call of this.calls) {
      for (const send of call.sends) {
        transfers.push({
          asset: send.id,
          amount: send.amount,
          address: this.account.assetAddress,
        });
        noteAddress(this.account.assetAddress);
      }
    }

    /*
      Protostone 0 is the router. Every alkane riding on the inputs is
      auto-allocated to the FIRST stone, so that is the only place from which
      anything can be aimed: each call's payment goes to that call's shadow
      vout, each handoff to the output its recipient controls, and whatever is
      left over goes back as change. The message stones follow, one per call, so
      call `i` always sits at stone `1 + i`.
    */
    /*
      Stone 0 is the router, stones 1..n are the calls in the order they were
      chained, and a trailing stone settles the transfers. Only the router is
      reachable from the inputs — the runtime auto-allocates everything riding
      on them to the first stone — so it is the router that pays each call, and
      each call then points at whatever comes next in the chain.
    */
    const protostones: ProtostoneSpec[] = [];
    const transferring = this.handoffs.length > 0;
    if (this.calls.length > 0 || transferring) {
      // where a call's result goes when it isn't carried: the transfer stone if
      // there is one, so a transfer can hand on what a call just produced
      const transferStone = 1 + this.calls.length;
      const settles = transferring
        ? toProtostone(transferStone)
        : POINTER_OUTPUT;

      protostones.push({
        edicts: this.calls.flatMap((call, i) =>
          call.sends.map((send) => ({
            id: { block: BigInt(send.id.block), tx: BigInt(send.id.tx) },
            amount: send.amount,
            output: toProtostone(1 + i),
          })),
        ),
        // leftovers follow the same path a call's result would
        pointer: transferring ? toProtostone(transferStone) : CHANGE_OUTPUT,
      });

      this.calls.forEach((call, i) => {
        const { calldata } = call.contract.encodeCall(call.method, call.arg);
        const carried =
          call.carry && i + 1 < this.calls.length
            ? toProtostone(2 + i)
            : undefined;
        protostones.push({
          calldata,
          pointer: call.pointer ?? carried ?? settles,
          refundPointer: call.refund ?? CHANGE_OUTPUT,
        });
      });

      if (transferring) {
        protostones.push({
          edicts: this.handoffs.map((handoff) => ({
            id: { block: BigInt(handoff.id.block), tx: BigInt(handoff.id.tx) },
            amount: handoff.amount,
            output: outputIndexOf.get(handoff.address)!,
          })),
          pointer: CHANGE_OUTPUT,
        });
      }
    }

    /*
      What this transaction's own edicts leave on each output. A later
      transaction spending one of them can then account for the alkanes without
      anyone looking them up, because nothing on chain knows about them yet.
    */
    const holds = new Map<number, AlkaneAmount[]>();
    for (const handoff of this.handoffs) {
      const vout = outputIndexOf.get(handoff.address)!;
      const at = holds.get(vout) ?? [];
      at.push({ id: handoff.id, amount: handoff.amount });
      holds.set(vout, at);
    }

    const sources = this.pending.map((pending) => ({
      built: this.source(pending, context).built!,
      vout: pending.vout,
      stated: pending.holds,
    }));
    const includeInputs = sources.map(({ built, vout, stated }) =>
      chainedInput(
        built,
        vout,
        this.account.provider.network,
        stated ?? built.holds.get(vout) ?? [],
      ),
    );
    // Only a chained input nobody can account for needs the checks relaxed.
    const blind = sources.some(
      ({ built, vout, stated }) => !stated && !built.holds.has(vout),
    );

    const options = {
      provider: this.account.provider,
      transfers,
      feeRate: this.account.feeRate ?? this.account.provider.defaultFeeRate,
      includeInputs,
      spendableCache: context.spendable,
      availableUtxoTweak: {
        remove: new Set(context.spent),
        /*
          `remove` only filters what the builder fetches, so carried change has
          to be filtered here — otherwise an output one transaction already
          spent stays on offer to every transaction after it.
        */
        /*
          Carried change is offered only to the account that owns it. The pool
          is block-wide because any transaction may need to spend forward, but
          an address's change is not everybody's to spend — without this filter
          a second trader funds itself from the first one's leftovers.
        */
        add: context.available.filter(
          (utxo) =>
            utxo.address === this.account.address &&
            !context.spent.has(`${utxo.txId}:${utxo.outputIndex}`),
        ),
      },
      // a chained input whose contents nobody stated can't be accounted for,
      // so for that case alone the alkane checks have to stand down
      ignoreAlkanesUtxoCheck: blind,
      ignoreAlkanesRequirementCheck: blind,
      ...(protostones.length > 0 ? { protostones } : {}),
    } as ConstructorParameters<typeof ProtostoneTransaction>[1];

    return { options, holds };
  }
}

/** The address someone receives at. */
function addressOf(who: AlkanesAccount | string): string {
  return typeof who === "string" ? who : who.assetAddress;
}

/**
 * An input spending an output of a transaction that only exists in this block.
 * Everything needed is already in hand — we built the transaction it comes from.
 */
function syntheticUtxo(
  source: BuiltTx,
  vout: number,
  network: bitcoin.Network,
  holds: readonly AlkaneAmount[] = [],
): FormattedUtxo {
  const output = source.transaction.outs[vout];
  if (!output) {
    throw new Error(`tx: ${source.txid} has no output ${vout}`);
  }
  const prevTx = toEsploraTx(source.transaction, { confirmed: false }, network);
  return {
    txId: source.txid,
    outputIndex: vout,
    satoshis: output.value,
    scriptPk: output.script.toString("hex"),
    address: prevTx.vout[vout].scriptpubkey_address,
    inscriptions: [],
    runes: {},
    alkanes: Object.fromEntries(
      holds.map(({ id, amount }) => {
        const key = `${id.block}:${id.tx}`;
        return [key, { value: amount.toString(), name: "", symbol: "", id: key }];
      }),
    ),
    confirmations: 0,
    indexed: false,
    prevTx,
    prevTxHex: source.hex,
  };
}

function chainedInput(
  source: BuiltTx,
  vout: number,
  network: bitcoin.Network,
  holds: readonly AlkaneAmount[],
): { input_extended: any; input_formatted: FormattedUtxo } {
  const output = source.transaction.outs[vout]!;
  return {
    input_extended: {
      hash: source.txid,
      index: vout,
      witnessUtxo: { script: output.script, value: output.value },
      ...(output.script.length === 34
        ? { tapInternalKey: output.script.subarray(2, 34) }
        : {}),
    },
    input_formatted: syntheticUtxo(source, vout, network, holds),
  };
}

/*------------------------------------------------------------*
 | Block                                                       |
 *------------------------------------------------------------*/

/** What each transaction in a block resolves to — see `AlkaneTx.unwrap`. */
export type BlockResults<T extends readonly AlkaneTx<any, any>[]> = {
  -readonly [K in keyof T]: T[K] extends AlkaneTx<any, infer S> ? S : never;
};

/** What the transactions already built in a block leave for the next one. */
export interface BlockContext {
  /** Outpoints already consumed — never offered again. */
  spent: Set<string>;
  /** Change they produced, spendable by whatever comes after. */
  available: FormattedUtxo[];
  /** One lookup per address for the whole block, not one per build pass. */
  spendable: Map<string, Promise<FormattedUtxo[]>>;
  /** The block itself, so `.spending(index, …)` can find what it names. */
  txs: readonly AlkaneTx<any, any>[];
}

/**
 * The change a built transaction leaves behind. Only change: the dust outputs
 * carry alkanes whose amounts nothing knows until the block is simulated, and
 * guessing at those would be worse than leaving them alone. A later transaction
 * reaches them with `.spending()` instead.
 */
function changeOutputs(
  built: BuiltTx,
  account: AlkanesAccount,
  network: bitcoin.Network,
): FormattedUtxo[] {
  const change = bitcoin.address.toOutputScript(account.address, network);
  const out: FormattedUtxo[] = [];
  built.transaction.outs.forEach((output, vout) => {
    if (output.value <= 546 || !output.script.equals(change)) return;
    out.push(syntheticUtxo(built, vout, network));
  });
  return out;
}

/**
 * Transactions simulated in order against one shared state, the way they would
 * land in a block: each sees the storage the ones before it wrote and the
 * alkanes they moved. Goes out as raw transaction hex — kirby decodes the
 * runestones itself, so what's simulated is the transaction, not a description
 * of one.
 *
 * Requires kirby (`kirby_simulateblock`); a bare metashrew has no notion of a
 * chunk.
 */
/**
 * Simulate a chunk of transactions in order against one shared state, the way
 * they would land in a block: each sees the storage the ones before it wrote
 * and the alkanes they moved. Goes out as raw transaction hex — kirby decodes
 * the runestones itself, so what is simulated is the transaction, not a
 * description of one.
 *
 *     const [a, handed, b] = await provider.simulateBlock([tx1, tx2, tx3]);
 *
 * A transaction left alone resolves to its whole `TxOutcome`; one marked with
 * `.unwrap()` (or `.unwrapOr`, `.toNullable`) resolves to its answer directly,
 * so a block can be destructured straight into values.
 *
 * Requires kirby (`kirby_simulateblock`); a bare metashrew has no notion of a
 * chunk. Nothing is unwrapped and nothing throws on a revert: each transaction
 * comes back with its own results.
 */
export async function runSimulatedBlock<
  T extends readonly AlkaneTx<any, any>[],
>(provider: Provider, txs: readonly [...T]): Promise<BlockResults<T>> {
  if (txs.length === 0) return [] as unknown as BlockResults<T>;
  // A transaction is built once and remembers its bytes, so the same AlkaneTx
  // listed twice is the same transaction twice — a double-spend rather than a
  // repeat. Two identical transactions have to be built separately.
  if (new Set(txs).size !== txs.length) {
    throw new Error(
      "simulateBlock: the same transaction appears twice — build a second one " +
        "instead of listing the same object again",
    );
  }

  /*
    Built in order, each transaction told what the ones before it did: which
    outpoints they consumed, so nothing is spent twice, and what change they
    produced, so a block can outspend the confirmed utxos an address happens to
    hold. That is what a wallet does — the second transaction is paid for by the
    first one's change.
  */
  const built: BuiltTx[] = [];
  const context: BlockContext = {
    spent: new Set(),
    available: [],
    spendable: new Map(),
    txs,
  };
  for (const tx of txs) {
    const one = await tx.build(context);
    for (const input of one.transaction.ins) {
      const txid = Buffer.from(input.hash).reverse().toString("hex");
      context.spent.add(`${txid}:${input.index}`);
    }
    context.available.push(...changeOutputs(one, tx.account, provider.network));
    built.push(one);
  }

  const res = await fetch(provider.sandshrewUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "kirby_simulateblock",
      params: [{ height: "0", txs: built.map((b) => b.hex) }],
    }),
  });
  const json: any = await res.json();
  if (json?.error) {
    throw new Error(json.error.message ?? "simulateblock failed");
  }
  const list = json?.result?.results;
  if (!Array.isArray(list) || list.length !== built.length) {
    throw new Error("simulateblock: unexpected response shape");
  }

  return txs.map((tx, i) =>
    tx.resolve(readOutcome(tx, built[i], list[i])),
  ) as BlockResults<T>;
}

/** espo and kirby report value bytes as "0x…" hex. */
function bytesFromHex(value: string | undefined): Uint8Array {
  const clean = (value ?? "0x").replace(/^0x/, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Read one transaction's slot out of a simulated block. kirby answers per
 * protostone, and only the stones carrying a message have anything to say —
 * the edict-only ones report null — so the answers line up with the calls.
 */
function readOutcome(
  tx: AlkaneTx<any, any>,
  built: BuiltTx,
  entry: any,
): TxOutcome {
  const traces: { outpoint: string; events: AlkanesTraceEncodedResult }[] =
    Array.isArray(entry?.traces) ? entry.traces : [];
  const decoders = tx.decoders();
  const spoken: any[] = Array.isArray(entry?.executions)
    ? entry.executions.filter((s: unknown) => s !== null)
    : entry?.execution
      ? [entry]
      : [];

  const calls = decoders.map((decoder, i) => {
    const stone = spoken[i];
    if (!stone?.execution) {
      return new BoxedError(
        "no result for this call in the simulated block",
        AlkanesSimulationError.UnknownError,
      ) as BoxedResponse<unknown, AlkanesSimulationError>;
    }
    if (stone.execution.error) {
      return new BoxedError(
        String(stone.execution.error),
        AlkanesSimulationError.TransactionReverted,
      ) as BoxedResponse<unknown, AlkanesSimulationError>;
    }
    try {
      return new BoxedSuccess(
        decoder.contract.decodeReturn(
          bytesFromHex(stone.execution.data),
          decoder.outShape,
        ),
      ) as BoxedResponse<unknown, AlkanesSimulationError>;
    } catch (error) {
      return new BoxedError(
        `decode failed: ${(error as Error).message}`,
        AlkanesSimulationError.UnknownError,
      ) as BoxedResponse<unknown, AlkanesSimulationError>;
    }
  });

  // a transfer-only transaction makes no call; its answer is where things landed
  const result =
    calls[calls.length - 1] ??
    (entry?.execution?.error
      ? (new BoxedError(
          String(entry.execution.error),
          AlkanesSimulationError.TransactionReverted,
        ) as BoxedResponse<unknown, AlkanesSimulationError>)
      : (new BoxedSuccess(new Uint8Array()) as BoxedResponse<
          unknown,
          AlkanesSimulationError
        >));

  return {
    txid: entry?.txid ?? built.txid,
    hex: built.hex,
    signed: built.signed,
    calls,
    outputs: Array.isArray(entry?.outputs) ? entry.outputs : [],
    traces,
    trace: traces.map(({ outpoint, events }) => ({
      outpoint,
      events: decodeTrace(events),
    })),
    result,
    ok: calls.every((c) => !isBoxedError(c)) && !entry?.execution?.error,
  };
}
