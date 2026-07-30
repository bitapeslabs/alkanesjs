/*───────────────────────────────────────────────────────────────
  ACCOUNTS, TRANSACTIONS, BLOCKS
  ---------------------------------------------------------------
  A contract knows how to encode a call. It does not know who is
  making it, what they hold, or which outputs their alkanes should
  land on — that belongs to whoever is spending, so it lives here.

    const alice = new AlkanesAccount({ provider, address });

    const tx = alice.tx()
      .transfer(TOKEN_0, amountIn, 1)        // pay the swap — shadow vout 1
      .call(pool, "swap", args)              // typed off the ABI
      .transfer(TOKEN_1, amount, bob);       // pay a person

  The only numbers here are SHADOW indices — 0 is the transfer
  stone itself, 1 the first call, never a real vout. Real outputs
  are reached by address,
  and the builder decides the real layout. A call's result and its
  refund come home to the sender unless `shadowPointer` aims them at
  a later stone, which is how one call pays for the next.

  Each transaction really is a Bitcoin transaction: inputs chosen
  from what the account can spend, outputs, and an OP_RETURN
  carrying the protostones. A list of them goes to
  `alkanes_simulateblock` wrapped in a block — the same bytes a node
  would see.

  An account holding a key finalizes its transactions with real
  signatures. One that doesn't finalizes with placeholder witnesses
  instead, which is enough: nothing in a simulated block verifies a
  signature, so you can ask what an address you don't control would
  get. The bytes are a well-formed transaction either way.
──────────────────────────────────────────────────────────────*/

import * as bitcoin from "bitcoinjs-lib";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371";
import { AlkaneId, type AlkaneIdData, type AlkaneIdLike, FormattedUtxo } from "@/apis";
import type { Provider } from "@/provider";
import {
  BoxedError,
  BoxedResponse,
  BoxedSuccess,
  consumeOrThrow,
  isBoxedError,
} from "@/boxed";
import { AlkanesSimulationError } from "../interfaces/base";
import type {
  AlkanesTraceEncodedResult,
  AlkanesTraceResult,
} from "@/apis/alkanes/types";
import { decodeTrace, extractAbiErrorMessage } from "@/apis/alkanes/utils";
import { blockOf, type SimulatedTransaction } from "@/apis/alkanes/simtx";
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
import { sleep } from "@/utils";
import * as bip39 from "bip39";
import { BIP32Factory } from "bip32";
import { ecc } from "@/crypto/ecc";
import { AlkaneDeployment, type DeployOptions } from "./deploy";
import { Amount, type AmountLike } from "./amount";

/*------------------------------------------------------------*
 | What a contract has to expose to be callable from a tx      |
 *------------------------------------------------------------*/

/**
 * The part of a contract a transaction builder uses. `D` is a phantom: the
 * alkabi document the contract was built from, which is what lets `.call(pool)`
 * offer that contract's own methods with their own argument types.
 */
export interface CallableContract<D = unknown> {
  readonly alkaneId: AlkaneIdData;
  /** Phantom — never read at runtime. */
  readonly __alkabi?: D;
  /** Encode `method`'s argument into the words a protostone message carries. */
  encodeCall(
    method: string,
    arg?: unknown,
  ): { alkaneId: AlkaneIdData; calldata: bigint[]; outShape: unknown };
  /** Turn returndata into this method's declared output type. */
  decodeReturn(bytes: Uint8Array, outShape: unknown): unknown;
}

/*------------------------------------------------------------*
 | Account                                                     |
 *------------------------------------------------------------*/

/** Options shared by every account: whose provider, and what fee it pays. */
export interface AccountOptions {
  /** Overrides the provider's default for every transaction this account makes. */
  feeRate?: number;
  /**
   * Which address the key presents as. Defaults to taproot. Nested segwit
   * addresses derive and receive fine, but the transaction builder cannot yet
   * spend them (it lacks the pubkey to rebuild the redeem script).
   */
  addressType?: AccountAddressType;
}

export type AccountAddressType =
  | "taproot"
  | "nativeSegwit"
  | "nestedSegwit"
  | "legacy";

/** The BIP-derivation purpose each address type conventionally lives under. */
const BIP_PURPOSE: Record<AccountAddressType, number> = {
  taproot: 86,
  nativeSegwit: 84,
  nestedSegwit: 49,
  legacy: 44,
};

/** The address a keypair presents as, in the chosen encoding. */
function addressOfKey(
  keypair: ReturnType<typeof EcPair.fromWIF>,
  type: AccountAddressType,
  network: bitcoin.Network,
): string {
  const pubkey = Buffer.from(keypair.publicKey);
  switch (type) {
    case "taproot":
      return bitcoin.payments.p2tr({
        internalPubkey: toXOnly(pubkey),
        network,
      }).address!;
    case "nativeSegwit":
      return bitcoin.payments.p2wpkh({ pubkey, network }).address!;
    case "nestedSegwit":
      return bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey, network }),
        network,
      }).address!;
    case "legacy":
      return bitcoin.payments.p2pkh({ pubkey, network }).address!;
  }
}

/**
 * Someone who can spend — or at least ask. Holds the addresses transactions
 * are built from, and the provider they are asked through. This is the base
 * both kinds share; you never construct one directly:
 *
 *   `Account`  — holds signing authority (a key, or an external signer),
 *                     so its transactions come out with real signatures.
 *   `ViewAccount`   — an address you watch. It builds and simulates the same
 *                     transactions with placeholder witnesses — nothing in a
 *                     simulation checks a signature — but it cannot sign.
 */
export abstract class AlkanesAccount {
  readonly addresses: TransactionAddresses;

  protected constructor(
    readonly provider: Provider,
    addresses: TransactionAddressInput,
    readonly feeRate?: number,
  ) {
    this.addresses = normalizeTransactionAddresses(addresses);
  }

  /** Where this account's sats come from — and where change goes back to. */
  address(): string {
    return this.addresses.paymentAddress;
  }

  /** Where this account's alkanes live. */
  assetAddress(): string {
    return this.addresses.assetAddress;
  }

  /** Whether transactions from this account come out with real signatures. */
  abstract get canSign(): boolean;

  /** Sign an unsigned psbt. Throws for an account with no signing authority. */
  abstract sign(unsignedBase64: string): Promise<string>;

  /** Start a transaction spending from this account. */
  tx(): AlkaneTx {
    return new AlkaneTx(this);
  }

  /**
   * What this account holds, by alkane — espo's own aggregate, in raw units:
   *
   *     const held = await alice.getBalances();
   *     held.amountOf("2:0")                   // 100000000n
   *     Amount.fromBigint(held.amountOf(TOKEN)).string  // "1"
   *
   * Reads the asset address, since that is where an account's alkanes live.
   */
  async getBalances(): Promise<Balances> {
    const { balances } = consumeOrThrow(
      await this.provider.rpc.espo.getAddressBalances(this.assetAddress()),
    );
    return new Balances(Object.entries(balances));
  }
}

/**
 * Amounts by alkane, keyed the way espo keys them — `"block:tx"` — so a
 * lookup is a string compare rather than object identity. `amountOf` takes an
 * id in any spelling and answers `0n` for one that isn't held, which is what
 * "how much do I have" should say about nothing.
 */
export class Balances extends Map<string, bigint> {
  amountOf(id: AlkaneIdLike): bigint {
    return this.get(AlkaneId.toString(id)) ?? 0n;
  }

  /** The alkanes held, as ids. */
  alkanes(): AlkaneId[] {
    return [...this.keys()].map((key) => AlkaneId.fromString(key));
  }
}

/**
 * An address you can watch but not spend from. Everything except signing
 * works: simulation never verifies a witness, so a ViewAccount can build a
 * transaction, ask what it would do, even hand its outputs to another
 * transaction in a simulated block — it just can't put the result on chain.
 */
export class ViewAccount extends AlkanesAccount {
  static fromAddress(
    address: TransactionAddressInput,
    provider: Provider,
    options: AccountOptions = {},
  ): ViewAccount {
    return new ViewAccount(provider, address, options.feeRate);
  }

  get canSign(): boolean {
    return false;
  }

  async sign(): Promise<string> {
    throw new Error(
      `ViewAccount(${this.address()}): view-only — it holds no key to sign with`,
    );
  }
}

/**
 * An account with signing authority: a key it holds, or an external signer
 * (a browser wallet) it defers to. Its transactions are finalized with real
 * signatures, which is what makes them broadcastable.
 */
export class Account extends AlkanesAccount {
  private constructor(
    provider: Provider,
    addresses: TransactionAddressInput,
    private readonly keypair?: ReturnType<typeof EcPair.fromWIF>,
    private readonly externalSigner?: (unsigned: string) => Promise<string>,
    feeRate?: number,
  ) {
    super(provider, addresses, feeRate);
  }

  /**
   * From a private key in WIF. The address is derived from it — taproot by
   * default, or whatever `addressType` names:
   *
   *     Account.fromWIF(wif, provider, { addressType: "nativeSegwit" })
   */
  static fromWIF(
    wif: string,
    provider: Provider,
    options: AccountOptions = {},
  ): Account {
    const keypair = EcPair.fromWIF(wif, provider.network);
    const address = addressOfKey(
      keypair,
      options.addressType ?? "taproot",
      provider.network,
    );
    return new Account(provider, address, keypair, undefined, options.feeRate);
  }

  /**
   * From a BIP39 mnemonic. The wallet is picked by `addressType` and `index`:
   * each type lives under its conventional BIP purpose (86 taproot, 84 native
   * segwit, 49 nested, 44 legacy), and `index` walks the HD wallet within it —
   * `m/{purpose}'/0'/0'/0/{index}`, the first taproot key by default.
   *
   *     Account.fromMnemonic(words, provider, { addressType: "nativeSegwit", index: 3 })
   *
   * An explicit `path` overrides all of that and is taken verbatim.
   */
  static fromMnemonic(
    mnemonic: string,
    provider: Provider,
    options: AccountOptions & { path?: string; index?: number } = {},
  ): Account {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error("Account.fromMnemonic: not a valid BIP39 mnemonic");
    }
    const addressType = options.addressType ?? "taproot";
    const index = options.index ?? 0;
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(
        `Account.fromMnemonic: index ${index} is not a valid HD wallet index`,
      );
    }
    const path =
      options.path ?? `m/${BIP_PURPOSE[addressType]}'/0'/0'/0/${index}`;
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const node = BIP32Factory(ecc)
      .fromSeed(seed, provider.network)
      .derivePath(path);
    const keypair = EcPair.fromPrivateKey(Buffer.from(node.privateKey!), {
      network: provider.network,
    });
    const address = addressOfKey(keypair, addressType, provider.network);
    return new Account(provider, address, keypair, undefined, options.feeRate);
  }

  /**
   * From an external signer — a browser wallet. The wallet holds the key, so
   * the address cannot be derived and has to be given.
   */
  static fromSignPsbt(
    signPsbt: (unsigned: string) => Promise<string>,
    address: TransactionAddressInput,
    provider: Provider,
    options: AccountOptions = {},
  ): Account {
    return new Account(provider, address, undefined, signPsbt, options.feeRate);
  }

  get canSign(): boolean {
    return true;
  }

  /**
   * Deploy a contract: `wasm` is the compiled bytes, and the pair of
   * transactions that carries them on chain comes back built and signed.
   *
   *     const deployment = await account
   *       .deploy(wasm)
   *       .call(MyContractAbi, "initialize", initArgs)
   *       .build();
   *     const alkaneId = await deployment.send().waitForDeployment();
   *
   * See `AlkaneDeployment` for what building entails (commit/reveal, priced
   * as a CPFP package, submitted through espo's `btc.submit_package`).
   */
  deploy(wasm: Uint8Array, options: DeployOptions = {}): AlkaneDeployment {
    return new AlkaneDeployment(this, wasm, options);
  }

  async sign(unsignedBase64: string): Promise<string> {
    if (this.externalSigner) {
      return this.externalSigner(unsignedBase64);
    }
    const psbt = bitcoin.Psbt.fromBase64(unsignedBase64, {
      network: this.provider.network,
    });
    const tweaked = tweakSigner(this.keypair!, {
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
}

/*
  The two chain links. Each wraps a promise that is created ONCE, so however
  far down the chain you await — the built transaction, its txid, its
  confirmation — the same build and the same broadcast are behind all of it.

  The inner value is boxed (`{ sent }`) on the way through `.then` because a
  SentTx is itself a thenable: returned bare, the promise machinery would
  flatten it to a txid and the `waitForConfirmation` handle would be lost.
*/
function sentTx(inFlight: Promise<Sent>): SentTx {
  const txid = inFlight.then((s) => s.txid);
  return Object.assign(txid, {
    waitForConfirmation: () => inFlight.then((s) => s.waitForConfirmation()),
  });
}

function building(inFlight: Promise<BuiltTx>): BuildingTx {
  return Object.assign(inFlight, {
    send: (): SentTx => {
      const boxed = inFlight.then((built) => ({ sent: built.send() }));
      const txid = boxed.then((b) => b.sent);
      return Object.assign(txid, {
        waitForConfirmation: () => boxed.then((b) => b.sent.waitForConfirmation()),
      });
    },
  });
}

/*------------------------------------------------------------*
 | Transaction                                                 |
 *------------------------------------------------------------*/

/**
 * Per-build overrides, for saying at `.build()` time what this one
 * transaction should pay — the most specific word wins: these, then the
 * account's `feeRate`, then the provider's default.
 */
export interface TxBuildOptions {
  /**
   * sats/vB. For a `.tx()` this is the transaction's own rate; for a
   * `.deploy()` it is the NORMALIZED rate of the whole commit/reveal pair —
   * the commit stays at the relay floor and the reveal pays the rest, so the
   * package as a whole lands on this number.
   */
  feeRate?: number;
}

/** An amount of one alkane. */
export interface AlkaneAmount {
  id: AlkaneIdData;
  amount: bigint;
}

/**
 * BTC as the sats it is. Bitcoin has no unit below a sat, so an amount that
 * does not land on one is a mistake worth hearing about rather than rounding
 * away — `0.000000005` is either a typo or a misunderstanding, and silently
 * sending 1 sat helps with neither.
 *
 * The comparison allows a little slack because `0.0001 * 1e8` is not exactly
 * `10000` in binary floating point, and refusing that would be absurd.
 */
const satsOf = (btc: number): number => {
  const raw = btc * 1e8;
  const sats = Math.round(raw);
  if (Math.abs(raw - sats) > 1e-3) {
    throw new Error(
      `tx: ${btc} BTC is ${raw} sats, which is not a whole number of them`,
    );
  }
  return sats;
};

/*------------------------------------------------------------*
 | Shadow space — how a transaction talks about itself         |
 *------------------------------------------------------------*/

/*
  The only vout numbers this API accepts are SHADOW indices, counted over the
  protostones themselves: `0` is the transfer stone — the first shadow vout —
  `1` the first `.call()` or `.protostone()`, `2` the second, and so on. Real
  vouts are never addressable by number — an address is how you reach a real
  output, and the builder decides the real layout (dust output, recipient
  outputs, change), which is exactly why a hand-written number for one could
  never be right.

  On the wire, shadow index `n` is `real_outputs + 1 + n`. The builder does
  that arithmetic; nothing here ever needs to. Index 0 is addressable in
  principle but never a useful target: the transfer stone is the thing doing
  the aiming, and it has already settled by the time anything else runs.
*/

/** An alkane aimed at a shadow vout. */
export interface ShadowEdict {
  id: AlkaneIdData;
  amount: bigint;
  /** The shadow index that receives it — `1` is the first call. */
  to: number;
}

/**
 * Per-stone overrides. Everything is shadow-indexed; left alone, a stone's
 * result and its refund both go back to the sender's alkanes output.
 */
export interface StoneSettings {
  /** Moves made when this stone settles, into later stones' shadow vouts. */
  shadowEdicts?: readonly ShadowEdict[];
  /** Where this stone's result goes: a later stone's shadow index. */
  shadowPointer?: number;
  /** Where its incoming goes on revert: a later stone's shadow index. */
  shadowRefund?: number;
}

/** A raw protostone: `StoneSettings` plus an arbitrary message. */
export interface RawStoneSettings extends StoneSettings {
  /** The message words, as they ride the runestone. Empty means no message. */
  message?: readonly bigint[];
}

const SETTING_KEYS = ["shadowEdicts", "shadowPointer", "shadowRefund"];

/**
 * Whether a `.call()` argument slot holds the settings. A method taking no
 * argument can still carry settings, so `{ shadowPointer: 1 }` has to be told
 * apart from a method whose own argument sits in that slot — no alkabi input
 * is an object made only of these keys.
 */
function isSettings(value: unknown): value is StoneSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => SETTING_KEYS.includes(k));
}

/*
  What `.call(contract, method, …)` knows about the contract: its alkabi
  document, which is where the method-name union and each method's argument
  type come from.
*/
type ArgOf<M, T extends AlkabiDocument["types"]> = M extends { input: infer I }
  ? [arg: InferAlkabiIo<I, T>]
  : [];

type OutOf<M, T extends AlkabiDocument["types"]> = M extends { output: infer O }
  ? InferAlkabiIo<O, T>
  : Uint8Array;

type DocMethods<D> = D extends AlkabiDocument ? D["methods"][number] : never;

/** The names `.call()` accepts for a contract — its own methods. */
export type MethodNameOf<D> = D extends AlkabiDocument
  ? DocMethods<D>["name"] & string
  : string;

type MethodByName<D, N> = Extract<DocMethods<D>, { name: N }>;

type CallRest<D, N> = D extends AlkabiDocument
  ? [...ArgOf<MethodByName<D, N>, D["types"]>, settings?: StoneSettings]
  : [arg?: unknown, settings?: StoneSettings];

type CallOut<D, N> = D extends AlkabiDocument
  ? OutOf<MethodByName<D, N>, D["types"]>
  : Uint8Array;

/** How a transaction's slot in a block resolves. */
type SlotMode =
  | { kind: "outcome" }
  | { kind: "unwrap" }
  | { kind: "expect"; message: string }
  | { kind: "unwrapOr"; fallback: unknown }
  | { kind: "toNullable" };

/** One protostone of the chain: a contract call, or a raw stone. */
type ChainStone =
  | {
      kind: "call";
      contract: CallableContract;
      method: string;
      arg?: unknown;
      settings: StoneSettings;
    }
  | { kind: "raw"; message: bigint[]; settings: StoneSettings };

/** An alkane moved by the transfer stone: to a person, or into a chain stone. */
interface Handoff {
  id: AlkaneIdData;
  amount: bigint;
  /** Exactly one of these: a recipient's address, or a shadow index. */
  address?: string;
  shadow?: number;
}

/** Outputs of an unmined transaction that this one spends. */
interface PendingInput {
  /** The transaction whose outputs are spent. */
  from: AlkaneTx<any, any>;
  /**
   * Which of the spender's outputs of that transaction: the default sweeps
   * every alkane-bearing one, a number picks the n-th output that belongs to
   * the spender, in vout order.
   */
  selector: number | "all";
}

/** What a broadcast answers internally: the txid, and how to wait it out. */
interface Sent {
  txid: string;
  waitForConfirmation: () => Promise<void>;
}

/**
 * A broadcast in flight. Await it for the txid, or keep chaining:
 *
 *     const txid = await tx.build().send();
 *     await tx.build().send().waitForConfirmation();
 *
 * One send either way — the chain just decides how far you wait.
 */
export type SentTx = Promise<string> & {
  waitForConfirmation: () => Promise<void>;
};

/**
 * A build in flight. The chain ends wherever you stop awaiting it: the built
 * transaction, its txid once sent, or nothing at all once it has confirmed.
 */
export type BuildingTx = Promise<BuiltTx> & {
  send: () => SentTx;
};

/** A transaction after it has been built: real bytes, with a real txid. */
export interface BuiltTx {
  hex: string;
  txid: string;
  /**
   * Broadcast this transaction — through espo, whose broadcaster hands it to
   * electrum with a Bitcoin Core fallback.
   *
   *     const { txid } = await tx.send();          // just send it
   *     await tx.send().waitForConfirmation();     // send and wait it out
   *
   * The waiting form is the same send — the broadcast happens once either
   * way — and resolves once the transaction is mined AND espo has indexed
   * its block, so anything read afterwards sees what it did.
   *
   * Refuses a transaction carrying placeholder witnesses: a `ViewAccount`
   * builds bytes a simulation accepts, not bytes a node will.
   */
  send(): SentTx;
  /**
   * What this transaction's own edicts put on each real output. Known because
   * we wrote them — a call's result is not, since only the simulation knows
   * how much it returned.
   */
  holds: Map<number, AlkaneAmount[]>;
  /**
   * The alkanes output the builder keeps for the sender — where results,
   * refunds and leftovers land by default. `null` for a transaction that
   * carried no protostones and so never made one.
   */
  home: number | null;
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
 * Every transaction has the same shape: a TRANSFER protostone first, then one
 * stone per `.call()` / `.protostone()` in chain order.
 *
 *   inputs → transfer stone —edicts→ calls' shadow vouts → … → outputs
 *
 * The transfer stone leads because protorune hands everything riding on the
 * inputs to the first stone — so it is the one stone that has anything to
 * route, and routing is all it does. Its edicts are the `.transfer()`s:
 * paying a call and paying a person are the same move, aimed at a shadow
 * index or an address. Its own pointer and refund are the sender's alkanes
 * output, so whatever nothing claims comes home.
 *
 * Calls settle in chain order after it. A call's result and its refund also
 * default home to the sender; `shadowPointer` aims a result at a later stone
 * instead — which is how one call pays for the next.
 */
export class AlkaneTx<Out = Uint8Array, Slot = TxOutcome> {
  private readonly chain: ChainStone[] = [];
  private readonly handoffs: Handoff[] = [];
  private readonly payments: { address: string; sats: number }[] = [];
  private readonly pending: PendingInput[] = [];
  private mode: SlotMode = { kind: "outcome" };
  private built?: BuiltTx;
  /** A `.build({ feeRate })` override; unset, the account's rate rules. */
  private buildFeeRate?: number;

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
   * Call a contract method — its own protostone, settling in chain order:
   *
   *     .call(pool, "swap", swapArgs)
   *     .call(pool, "getReserves")
   *
   * The method name is the contract's to offer: it autocompletes off the ABI,
   * and the argument is typed per method. Paying a call is not done here —
   * `.transfer(asset, amount, shadowIndex)` aims what the transaction brought
   * in at this call's shadow vout.
   *
   * The trailing settings override the stone's raw fields:
   *
   *     .call(pool, "swap", args, { shadowPointer: 2 })   // result feeds stone 2
   */
  call<D, N extends MethodNameOf<D>>(
    contract: CallableContract<D>,
    method: N,
    ...rest: CallRest<D, N>
  ): AlkaneTx<CallOut<D, N>, Slot extends TxOutcome ? TxOutcome : Slot> {
    const [first, second] = rest as [unknown?, StoneSettings?];
    const [arg, settings] =
      second === undefined && isSettings(first)
        ? [undefined, first]
        : [first, second];
    this.chain.push({
      kind: "call",
      contract: contract as CallableContract,
      method,
      arg,
      settings: settings ?? {},
    });
    return this as unknown as AlkaneTx<
      CallOut<D, N>,
      Slot extends TxOutcome ? TxOutcome : Slot
    >;
  }

  /**
   * A raw protostone, for saying something no verb here says: an arbitrary
   * message, edicts, a pointer — all shadow-indexed, all optional.
   *
   *     .protostone({ message: [2n, 0n, 77n] })
   */
  protostone(settings: RawStoneSettings = {}): this {
    const { message, ...rest } = settings;
    this.chain.push({ kind: "raw", message: [...(message ?? [])], settings: rest });
    return this;
  }

  /**
   * Move an alkane. The recipient is an address — a person — or a shadow
   * index — one of this transaction's own calls. Paying a person and paying a
   * contract are the same move:
   *
   *     .transfer(TOKEN_0, 100_000n, 1)     // pay the first call — shadow vout 1
   *     .transfer(TOKEN_1, amount, bob)     // pay bob — an edict to his output
   *     .transfer("sats", 10_000n, bob)     // 10,000 sats
   *     .transfer("btc", 0.0001, bob)       // the same, said the other way
   *
   * Every transfer is an edict on the transaction's first protostone — the
   * transfer stone — which is where everything riding on the inputs lands,
   * and therefore the one place anything can be aimed from. That is also why
   * a transfer cannot move a call's result: the routing has already happened
   * by the time any call runs.
   *
   * Bitcoin comes in two spellings because both get used and neither reads as
   * the other: sats are whole, so they are a bigint like an alkane amount, and
   * BTC is decimal, so it is a number. Sats go to people, not to shadow vouts
   * — a shadow vout is not an output and cannot hold them.
   */
  transfer(asset: AlkaneIdData, amount: AmountLike, to: AlkanesAccount | string | number): this;
  transfer(asset: "sats", amount: AmountLike, to: AlkanesAccount | string): this;
  transfer(asset: "btc", amount: number, to: AlkanesAccount | string): this;
  transfer(
    asset: AlkaneIdData | "sats" | "btc",
    amount: AmountLike | number,
    to: AlkanesAccount | string | number,
  ): this {
    if (asset === "sats" || asset === "btc") {
      if (typeof to === "number") {
        throw new Error(
          "tx: sats go to an address — a shadow vout is not an output and cannot hold them",
        );
      }
      this.payments.push({
        sats:
          asset === "sats"
            ? Number(Amount.toBigint(amount as AmountLike))
            : satsOf(amount as number),
        address: addressOf(to),
      });
      return this;
    }
    this.handoffs.push({
      id: asset,
      amount: Amount.toBigint(amount as AmountLike),
      ...(typeof to === "number" ? { shadow: to } : { address: addressOf(to) }),
    });
    return this;
  }

  /**
   * All the transfers at once, and nothing after them — the array closes the
   * transaction. Entries are `[asset, amount, to]`, exactly the arguments
   * `.transfer()` takes.
   */
  transfers(
    list: readonly (readonly [AlkaneId, bigint, AlkanesAccount | string | number])[],
  ): Omit<this, "call" | "protostone" | "transfer" | "transfers" | "spending"> {
    for (const [asset, amount, to] of list) {
      this.transfer(asset, amount, to as never);
    }
    return this;
  }

  /**
   * Spend what an earlier transaction in the same block left you. Those
   * outputs do not exist on chain, so no lookup can find them — naming the
   * transaction here is what lets this one be paid by it.
   *
   *     .spending(tx1)         // every alkane-bearing output tx1 left me
   *     .spending(tx1, 0)      // precisely my first output of tx1
   *
   * Which outputs are "yours" is decided by script: the built transaction's
   * outputs are matched against this account's addresses, so the numbers
   * count YOUR outputs — never the builder's layout. The default (and `"all"`)
   * takes the alkane-bearing ones: outputs its edicts loaded, plus its home
   * output, where call results land. A plain number reaches any of your
   * outputs, plain-BTC change included.
   *
   * Nothing states amounts. Whatever actually sits on those outputs rides
   * into this transaction and the runtime allocates it — which also means an
   * underfunded spend surfaces as a revert in the simulation, not at build:
   * the amounts a call returned exist nowhere else.
   */
  spending(from: AlkaneTx<any, any>, selector: number | "all" = "all"): this {
    if ((from as unknown) === this) {
      throw new Error("tx: .spending() names itself");
    }
    this.pending.push({ from, selector });
    return this;
  }

  /**
   * Build the transaction and return its bytes.
   *
   *     .build()                    // account's rate, or the provider's
   *     .build({ feeRate: 3 })      // this transaction pays 3 sat/vB
   *
   * `context` is what the rest of the block has already done — see
   * `BlockContext`; callers inside a block pass it, people don't.
   */
  build(options?: TxBuildOptions, context?: BlockContext): BuildingTx {
    return building(this.buildTx(options, context));
  }

  private async buildTx(
    options?: TxBuildOptions,
    context?: BlockContext,
  ): Promise<BuiltTx> {
    if (this.built) return this.built;
    if (options?.feeRate !== undefined) this.buildFeeRate = options.feeRate;

    /*
      Every shadow reference has to name a stone that exists, and stones
      settle in order, so aiming anything at an earlier (or the same) stone
      would arrive after it ran — the alkanes would sit on a shadow vout
      nothing will ever read. Both are said no to here, while the line that
      wrote them is still on the stack. Indices are absolute: 0 is the
      transfer stone, so every useful target is at least 1.
    */
    const stones = 1 + this.chain.length;
    const checkTarget = (what: string, n: number, after: number) => {
      if (!Number.isInteger(n) || n < 0 || n >= stones) {
        throw new Error(
          `tx: ${what} aims at shadow vout ${n}, but the last stone is ${stones - 1}`,
        );
      }
      if (n <= after) {
        throw new Error(
          `tx: ${what} aims at shadow vout ${n}, which settles before stone ${after} does`,
        );
      }
    };
    for (const handoff of this.handoffs) {
      if (handoff.shadow !== undefined) {
        // the transfer stone is stone 0: it cannot aim at itself
        checkTarget(".transfer()", handoff.shadow, 0);
      }
    }
    this.chain.forEach((stone, i) => {
      const s = stone.settings;
      const at = 1 + i; // this stone's own shadow index
      if (s.shadowPointer !== undefined) checkTarget("shadowPointer", s.shadowPointer, at);
      if (s.shadowRefund !== undefined) checkTarget("shadowRefund", s.shadowRefund, at);
      for (const e of s.shadowEdicts ?? []) checkTarget("a shadowEdict", e.to, at);
    });

    for (const pending of this.pending) {
      // an input can only be described once the transaction producing it exists
      await pending.from.build(undefined, context);
    }

    // even on its own a transaction is built twice — measured, then built —
    // so it shares one lookup with itself when no block supplies the cache
    const { options: factoryOptions, holds, home } = this.buildOptions(
      context ?? { spent: new Set(), available: [], spendable: new Map() },
    );

    // Two passes: the first only exists to measure the transaction, since the
    // fee depends on its size and the size depends on the fee.
    const dry = new ProtostoneTransaction(this.account.addresses, factoryOptions);
    const [inputCount] = await dry.build();
    const vsize = (await dry.finalizeWithDry()).virtualSize();

    const real = new ProtostoneTransaction(this.account.addresses, {
      ...factoryOptions,
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

    const account = this.account;
    const builtTxid = transaction.getId();
    this.built = {
      hex: transaction.toHex(),
      txid: builtTxid,
      holds,
      home,
      signed,
      psbtBase64: unsigned,
      transaction,
      send(): SentTx {
        const hex = this.hex;
        const signedNow = this.signed;
        const broadcast = async (): Promise<Sent> => {
          if (!signedNow) {
            throw new Error(
              `tx ${builtTxid}: built with placeholder witnesses — a view-only ` +
                "account cannot send; use an Account that holds the key",
            );
          }
          const sent = await account.provider.rpc.electrum.esplora_broadcastTx(hex);
          if (isBoxedError(sent)) throw new Error(sent.message);
          const txid = sent.data;
          const waitForConfirmation = async () => {
            // mined…
            let height = 0;
            for (;;) {
              const tx = await account.provider.rpc.electrum.esplora_gettransaction(txid);
              if (!isBoxedError(tx) && tx.data.status?.confirmed) {
                height = tx.data.status.block_height ?? 0;
                break;
              }
              await sleep(2000);
            }
            // …and indexed, so a read after this sees what the transaction did
            for (;;) {
              const tip = await account.provider.rpc.espo.getTipHeight();
              if (!isBoxedError(tip) && tip.data.height >= height) return;
              await sleep(1000);
            }
          };
          return { txid, waitForConfirmation };
        };
        /*
          One send, two ways to hold it: the promise is created once here, so
          awaiting for the txid and chaining `waitForConfirmation()` off it
          broadcast the same transaction rather than racing two of them.
        */
        const inFlight = broadcast();
        return sentTx(inFlight);
      },
    };
    return this.built;
  }

  /**
   * Simulate this transaction on its own. Nothing is broadcast — this asks
   * what the transaction would do, it does not do it.
   *
   * Goes through `alkanes_simulatetransaction` — the authoritative view for a
   * raw transaction, spoken by metashrew and kirby alike — so a lone
   * `.simulate()` works against a bare sandshrew with no kirby in front of
   * it. The one case that cannot: a transaction spending outputs that exist
   * only alongside other unmined transactions, which by definition needs the
   * block form.
   */
  simulate(): Promise<Slot> {
    if (this.pending.length > 0) {
      return runSimulatedBlock(this.account.provider, [this]).then(
        ([only]) => only as Slot,
      );
    }
    return (async () => {
      const built = await this.build();
      const sim = await this.account.provider.simulateTransaction(built.hex);
      return this.resolve(outcomeOfSimulated(this, built, sim)) as Slot;
    })();
  }

  then<R1 = Slot, R2 = never>(
    onFulfilled?: ((value: Slot) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.simulate().then(onFulfilled, onRejected);
  }

  /* ── internals ─────────────────────────────────────────────── */

  /**
   * How each message-carrying stone's result decodes, in settlement order —
   * the same order the simulated protostones come back in. The transfer stone
   * carries no message and so appears in neither list; a raw stone that does
   * carry one gets a `null` decoder, and its result stays raw bytes.
   */
  decoders(): ({ contract: CallableContract; outShape: unknown } | null)[] {
    return this.chain
      .filter((s) => s.kind === "call" || s.message.length > 0)
      .map((s) =>
        s.kind === "call"
          ? {
              contract: s.contract,
              outShape: s.contract.encodeCall(s.method, s.arg).outShape,
            }
          : null,
      );
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
      /*
        Every alkane transfer drives coin selection — the builder only reaches
        for alkane-bearing utxos when a transfer asks for that alkane. One to a
        person is aimed at their address, which also buys their output; one
        into a chain stone is aimed at our own asset address, since a shadow
        vout is not an output — the edict below is what actually delivers it.
      */
      const destination =
        handoff.address ?? this.account.assetAddress();
      transfers.push({
        asset: handoff.id,
        amount: handoff.amount,
        address: destination,
      });
      noteAddress(destination);
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
      The stones, in their one fixed shape: the transfer stone, then the chain.

      The transfer stone leads because everything riding on the inputs is
      auto-allocated to the FIRST protostone — so it is the only stone with
      anything to route, and its edicts are the routing: each `.transfer()`,
      whether at a recipient's output or into a chain stone's shadow vout.
      Chain stone `n` sits at protostone `n + 1`, and every default not
      overridden by shadow settings points at the sender's alkanes output,
      so results, refunds and leftovers all come home unless aimed elsewhere.
    */
    const protostones: ProtostoneSpec[] = [];
    // shadow index n is protostone n — the transfer stone is 0
    const shadowOf = (n: number) => toProtostone(n);
    if (this.chain.length > 0 || this.handoffs.length > 0) {
      protostones.push({
        edicts: this.handoffs.map((handoff) => ({
          id: { block: BigInt(handoff.id.block), tx: BigInt(handoff.id.tx) },
          amount: handoff.amount,
          output:
            handoff.shadow !== undefined
              ? shadowOf(handoff.shadow)
              : outputIndexOf.get(handoff.address!)!,
        })),
        pointer: POINTER_OUTPUT,
        refundPointer: POINTER_OUTPUT,
      });

      for (const stone of this.chain) {
        const calldata =
          stone.kind === "call"
            ? stone.contract.encodeCall(stone.method, stone.arg).calldata
            : stone.message;
        const s = stone.settings;
        protostones.push({
          calldata,
          edicts: (s.shadowEdicts ?? []).map((e) => ({
            id: { block: BigInt(e.id.block), tx: BigInt(e.id.tx) },
            amount: e.amount,
            output: shadowOf(e.to),
          })),
          pointer:
            s.shadowPointer !== undefined
              ? shadowOf(s.shadowPointer)
              : POINTER_OUTPUT,
          refundPointer:
            s.shadowRefund !== undefined
              ? shadowOf(s.shadowRefund)
              : POINTER_OUTPUT,
        });
      }
    }

    /*
      What this transaction's own edicts leave on each output. A later
      transaction spending one of them can then account for the alkanes without
      anyone looking them up, because nothing on chain knows about them yet.
      Only transfers to people land on outputs — one into a chain stone is
      consumed by the call it pays.
    */
    const holds = new Map<number, AlkaneAmount[]>();
    for (const handoff of this.handoffs) {
      if (handoff.address === undefined) continue;
      const vout = outputIndexOf.get(handoff.address)!;
      const at = holds.get(vout) ?? [];
      at.push({ id: handoff.id, amount: handoff.amount });
      holds.set(vout, at);
    }

    /*
      Resolve each `.spending()` to concrete outputs, by ownership rather than
      by layout: the source's built outputs are script-matched against this
      account's addresses, and the selector counts within the matches. The
      default sweeps the alkane-bearing ones — edicted outputs plus the home
      output, where a call's results land.
    */
    const network = this.account.provider.network;
    const scriptOf = (address: string) =>
      bitcoin.address.toOutputScript(address, network).toString("hex");
    /*
      Two notions of "yours", on purpose. Alkanes live at the asset address,
      so the sweep matches only it — a payment address can be shared for fee
      funding, and sweeping by it would take a housemate's change along. The
      numeric selector matches either address, because it exists precisely to
      reach anything that is yours, shared change included.
    */
    const assetScript = scriptOf(this.account.assetAddress());
    const anyMine = new Set([scriptOf(this.account.address()), assetScript]);
    const resolved = this.pending.flatMap((pending) => {
      const built = pending.from.built!;
      const outs = built.transaction.outs.map((out, vout) => ({
        vout,
        script: out.script.toString("hex"),
      }));
      if (pending.selector !== "all") {
        const mine = outs.filter(({ script }) => anyMine.has(script));
        const at = mine[pending.selector];
        if (at === undefined) {
          throw new Error(
            `tx: .spending(…, ${pending.selector}) — ${built.txid} has ` +
              `${mine.length} output(s) of yours, none at index ${pending.selector}`,
          );
        }
        return [{ built, vout: at.vout }];
      }
      const bearing = outs
        .filter(({ script }) => script === assetScript)
        .map(({ vout }) => vout)
        .filter((v) => built.holds.has(v) || v === built.home);
      if (bearing.length === 0) {
        throw new Error(
          `tx: .spending(…) — ${built.txid} left ${this.account.assetAddress()} ` +
            "no alkane-bearing output to spend",
        );
      }
      return bearing.map((vout) => ({ built, vout }));
    });
    const includeInputs = resolved.map(({ built, vout }) =>
      chainedInput(built, vout, network, built.holds.get(vout) ?? []),
    );
    // An output whose contents only the simulation knows — a call's result —
    // can't be accounted for at build, so the alkane checks stand down.
    const blind = resolved.some(({ built, vout }) => !built.holds.has(vout));

    const options = {
      provider: this.account.provider,
      transfers,
      feeRate:
        this.buildFeeRate ??
        this.account.feeRate ??
        this.account.provider.defaultFeeRate,
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
            utxo.address === this.account.address() &&
            !context.spent.has(`${utxo.txId}:${utxo.outputIndex}`),
        ),
      },
      // a chained input whose contents nobody stated can't be accounted for,
      // so for that case alone the alkane checks have to stand down
      ignoreAlkanesUtxoCheck: blind,
      ignoreAlkanesRequirementCheck: blind,
      ...(protostones.length > 0 ? { protostones } : {}),
    } as ConstructorParameters<typeof ProtostoneTransaction>[1];

    // the alkanes dust output is the first output whenever stones exist
    const home = protostones.length > 0 ? 0 : null;
    return { options, holds, home };
  }
}

/** The address someone receives at. */
function addressOf(who: AlkanesAccount | string): string {
  return typeof who === "string" ? who : who.assetAddress();
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
  const change = bitcoin.address.toOutputScript(account.address(), network);
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
 * alkanes they moved. Goes out as a consensus-encoded block, so what is
 * simulated is the transactions themselves rather than a description of them.
 */
/**
 * Simulate a chunk of transactions in order against one shared state, the way
 * they would land in a block: each sees the storage the ones before it wrote
 * and the alkanes they moved. Goes out as a consensus-encoded block via
 * `alkanes_simulateblock`, so what is simulated is the transactions
 * themselves rather than a description of them.
 *
 *     const [a, handed, b] = await provider.simulateBlock([tx1, tx2, tx3]);
 *
 * A transaction left alone resolves to its whole `TxOutcome`; one marked with
 * `.unwrap()` (or `.unwrapOr`, `.toNullable`) resolves to its answer directly,
 * so a block can be destructured straight into values.
 *
 * Nothing is unwrapped and nothing throws on a revert: each transaction comes
 * back with its own results.
 */
/**
 * Build a dependent run of transactions, in order.
 *
 * Each is told what the ones before it did: which outpoints they consumed, so
 * nothing is spent twice, and what change they produced, so the run can
 * outspend the confirmed utxos an address happens to hold. That is what a
 * wallet does — the second transaction is paid for by the first one's change,
 * and `.spending()` is what lets it be paid in alkanes too.
 *
 * This is the building half of both `simulateBlock` and `sendPackage`: the
 * same bytes either way, so what a package broadcasts is what a block
 * simulated.
 */
export async function buildChain(
  provider: Provider,
  txs: readonly AlkaneTx<any, any>[],
): Promise<BuiltTx[]> {
  const built: BuiltTx[] = [];
  const context: BlockContext = {
    spent: new Set(),
    available: [],
    spendable: new Map(),
  };
  for (const tx of txs) {
    const one = await tx.build(undefined, context);
    for (const input of one.transaction.ins) {
      const txid = Buffer.from(input.hash).reverse().toString("hex");
      context.spent.add(`${txid}:${input.index}`);
    }
    context.available.push(...changeOutputs(one, tx.account, provider.network));
    built.push(one);
  }
  return built;
}

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

  const built = await buildChain(provider, txs);

  const block = await provider.simulateRawBlock(blockOf(built.map((b) => b.hex)));
  // txs[0] is the coinbase the wrapper put there, so ours start at 1
  const results = block.txs.slice(1);
  if (results.length !== built.length) {
    throw new Error(
      `simulateblock: asked about ${built.length} transaction(s), heard about ${results.length}`,
    );
  }

  return txs.map((tx, i) =>
    tx.resolve(outcomeOfSimulated(tx, built[i], results[i])),
  ) as BlockResults<T>;
}

/**
 * A `simulatetransaction` answer as a `TxOutcome`, so `.simulate()` reports the
 * same shape whichever wire it went over. Everything a call returned lives in
 * its protostone's trace: the outermost exit — the last event of a balanced
 * trace — carries the returndata, and a revert carries its reason behind the
 * `08c379a0` selector.
 */
function outcomeOfSimulated(
  tx: AlkaneTx<any, any>,
  built: BuiltTx,
  sim: SimulatedTransaction,
): TxOutcome {
  const decoders = tx.decoders();
  const calls = decoders.map((decoder, k) => {
    const stone = sim.protostones[k];
    const last = stone?.events[stone.events.length - 1] as any;
    if (!last || last.event !== "return") {
      return new BoxedError(
        sim.error ?? "no result for this call in the simulated transaction",
        AlkanesSimulationError.UnknownError,
      ) as BoxedResponse<unknown, AlkanesSimulationError>;
    }
    const data: string = last.data.response.data;
    if (last.data.status !== "success") {
      return new BoxedError(
        `ALKANES: revert: ${extractAbiErrorMessage(data) ?? data}`,
        AlkanesSimulationError.TransactionReverted,
      ) as BoxedResponse<unknown, AlkanesSimulationError>;
    }
    // a raw stone has no declared shape, so its answer stays raw bytes
    if (decoder === null) {
      return new BoxedSuccess(bytesFromHex(data)) as BoxedResponse<
        unknown,
        AlkanesSimulationError
      >;
    }
    try {
      return new BoxedSuccess(
        decoder.contract.decodeReturn(bytesFromHex(data), decoder.outShape),
      ) as BoxedResponse<unknown, AlkanesSimulationError>;
    } catch (error) {
      return new BoxedError(
        `decode failed: ${(error as Error).message}`,
        AlkanesSimulationError.UnknownError,
      ) as BoxedResponse<unknown, AlkanesSimulationError>;
    }
  });

  const traces = sim.protostones.map((stone) => ({
    outpoint: `${sim.txid}:${stone.vout}`,
    events: stone.events,
  }));

  const result =
    calls[calls.length - 1] ??
    (sim.error
      ? (new BoxedError(
          sim.error,
          AlkanesSimulationError.UnknownError,
        ) as BoxedResponse<unknown, AlkanesSimulationError>)
      : (new BoxedSuccess(new Uint8Array()) as BoxedResponse<
          unknown,
          AlkanesSimulationError
        >));

  return {
    txid: sim.txid,
    hex: built.hex,
    signed: built.signed,
    calls,
    outputs: sim.outputs,
    traces,
    trace: traces.map(({ outpoint, events }) => ({
      outpoint,
      events: decodeTrace(events),
    })),
    result,
    ok: calls.every((c) => !isBoxedError(c)) && !sim.error,
  };
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

