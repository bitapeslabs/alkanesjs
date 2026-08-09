/*───────────────────────────────────────────────────────────────
  CONTRACT DEPLOYMENT
  ---------------------------------------------------------------
  Deploying an alkanes contract is a commit/reveal pair:

    commit — pays a P2TR output whose script tree hides an ord-style
             envelope carrying the gzipped wasm.
    reveal — spends that output through the script path (putting the
             wasm on chain in its witness) and carries the protostone
             whose cellpack targets [1, 0]: "instantiate the contract
             in this transaction's envelope", running `calldata` as
             its constructor inputs.

  The pair is priced as a CPFP package: the commit pays the relay
  floor and the reveal pays whatever brings the PACKAGE to the target
  rate, then both go out through espo's `btc.submit_package`, which
  is what lets a floor-rate commit relay at all.

  The constructor call is written the way `.tx()` writes any call —
  typed off the contract's ABI. The contract does not exist yet, so
  the descriptor's alkane id is a placeholder the deployment ignores:

    const blueprint = new Contract(MyContractAbi, { block: 0n, tx: 0n });

    const deployment = await account
      .deploy(wasm)
      .call(blueprint, "initialize", initArgs)
      .build();

    const alkaneId = await account
      .deploy(wasm)
      .call(MyContractAbi, "initialize", initArgs)
      .build()
      .send()
      .waitForDeployment();

  A `DeploymentPackage` also destructures into its two transactions
  when that is all you want:

    const [commitTx, revealTx] = await account.deploy(wasm).build();
──────────────────────────────────────────────────────────────*/

import { Psbt, Transaction, payments } from "bitcoinjs-lib";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371";
import { LEAF_VERSION_TAPSCRIPT } from "bitcoinjs-lib/src/payments/bip341";
import { gzip as gzipCallback } from "zlib";
import {
  encipher,
  encodeRunestoneProtostone,
  p2tr_ord_reveal,
  ProtoStone,
} from "alkanes";

import { AlkaneId, type FormattedUtxo } from "@/apis";
import { consumeOrThrow, isBoxedError } from "@/boxed";
import { awaitConfirmed, tracesOf, type ConfirmedTrace } from "./confirm";
import { sleep } from "@/utils";
import type { AlkabiDocument } from "../alkabi/types";
import { Contract } from "../alkabi/contract";
import type { InferAlkabiIo } from "../alkabi/infer";
import type {
  Account,
  CallableContract,
  MethodNameOf,
  TxBuildOptions,
} from "./account";
import {
  getProtostoneUnsignedPsbtBase64,
  normalizeTransactionAddresses,
} from "./psbt";
import { computeCpfpChildFee, MIN_RELAY_FEE_RATE } from "./cpfp-fee";
import { EcPair, tweakSigner } from "./utils";

// hand-rolled promisify: the browser build's `util` polyfill has none
const gzip = (data: Buffer, options: { level: number }): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    gzipCallback(data, options, (err, out) => (err ? reject(err) : resolve(out))),
  );

const DUST = 546;

export interface DeployOptions {
  /**
   * Raw cellpack inputs run at instantiation — opcode first, arguments after
   * (borsh-encoded structs ride as u128 words). An escape hatch: the typed
   * way to say the same thing is `.call(blueprint, "initialize", args)` on
   * the deployment. A contract whose constructor reverts does not deploy.
   */
  calldata?: bigint[];
  /** The rate the PACKAGE should achieve, sat/vB. Falls back to the
   *  account's fee rate, then the provider's default. */
  feeRate?: number;
  /**
   * What the commit itself pays. Defaults to the relay floor — CPFP doctrine:
   * the parent pays as little as relayable and the reveal buys the package's
   * priority. Raise it if the pair must survive being broadcast one at a time
   * through nodes that never saw `submitpackage`.
   */
  parentFeeRate?: number;
}

/** One signed transaction of the deployment pair. */
export interface DeploymentTx {
  hex: string;
  txid: string;
  vsize: number;
  fee: number;
}

/**
 * A deployed contract's id, plus the traces of the reveal that created it —
 * so the constructor's own execution is inspectable without a second lookup.
 *
 *     const id = await deployment.send().waitForDeployment();
 *     id.toString();                 // "2:74" — an AlkaneId in every way
 *     for (const t of id.traces) console.log(t.outpoint, t.ok);
 *
 * It IS an `AlkaneId`, so it goes anywhere one goes.
 */
export class DeployedAlkane extends AlkaneId {
  constructor(
    block: bigint | number | string,
    tx: bigint | number | string,
    /** The reveal's traces — the constructor call among them. */
    readonly traces: ConfirmedTrace[],
  ) {
    super(block, tx);
  }

  /** True when no protostone of the reveal reverted. */
  get ok(): boolean {
    return this.traces.every((t) => t.ok);
  }

  /** The first revert reason, if any did. */
  get error(): string | undefined {
    return this.traces.find((t) => !t.ok)?.error;
  }
}

/**
 * What `send()` answers: the txids as accepted, and a `waitForDeployment`
 * that resolves to the contract's alkane id once the reveal is mined, espo
 * has indexed its block, and the trace's `create` event names the id.
 */
export interface SubmittedDeployment {
  commitTxid: string;
  revealTxid: string;
  waitForDeployment: () => Promise<DeployedAlkane>;
}

/**
 * A package in flight. Await it for the txids, or keep chaining for the
 * alkane id — one submission either way.
 */
export type SentDeployment = Promise<{
  commitTxid: string;
  revealTxid: string;
}> & {
  waitForDeployment: () => Promise<DeployedAlkane>;
};

/**
 * A deployment being built. The chain ends wherever you stop awaiting it: the
 * built package, its txids once sent, or the alkane id once it is on chain.
 */
export type BuildingDeployment = Promise<DeploymentPackage> & {
  send: () => SentDeployment;
};

function sentDeployment(
  inFlight: Promise<SubmittedDeployment>,
): SentDeployment {
  const txids = inFlight.then(({ commitTxid, revealTxid }) => ({
    commitTxid,
    revealTxid,
  }));
  return Object.assign(txids, {
    waitForDeployment: () => inFlight.then((s) => s.waitForDeployment()),
  });
}

/**
 * The built pair, ready to go on chain. `send()` hands both transactions to
 * espo's `btc.submit_package` — atomically, as a package, which is what lets
 * the floor-rate commit relay. Destructures into `[commitTx, revealTx]`.
 *
 *     const id = await deployment.send().waitForDeployment();
 */
export class DeploymentPackage {
  constructor(
    private readonly account: Account,
    readonly commitTx: DeploymentTx,
    readonly revealTx: DeploymentTx,
  ) {}

  /** The rate the package actually achieves, sat/vB. */
  get packageFeeRate(): number {
    return (
      (this.commitTx.fee + this.revealTx.fee) /
      (this.commitTx.vsize + this.revealTx.vsize)
    );
  }

  *[Symbol.iterator](): Iterator<DeploymentTx> {
    yield this.commitTx;
    yield this.revealTx;
  }

  send(): SentDeployment {
    /*
      One submission, two ways to hold it: the promise is made once, so
      awaiting for the txids and chaining `waitForDeployment()` off it put the
      same package on chain rather than racing two of them.
    */
    return sentDeployment(this.submitPackage());
  }

  private async submitPackage(): Promise<SubmittedDeployment> {
    const provider = this.account.provider;

    const submitted = await provider.rpc.espo.submitPackage([
      this.commitTx.hex,
      this.revealTx.hex,
    ]);
    if (submitted.isErr()) {
      throw new Error(`deploy: submit_package failed: ${submitted.message}`);
    }
    // Core reports per-tx outcomes inside an otherwise-successful answer; a
    // transaction it refused would leave the reveal orphaned, so surface it.
    const results = submitted.data["tx-results"];
    if (results) {
      for (const entry of Object.values(results)) {
        if (entry.error) {
          throw new Error(
            `deploy: package tx ${entry.txid} rejected: ${entry.error}`,
          );
        }
      }
    }

    const revealTxid = this.revealTx.txid;

    const waitForDeployment = async (): Promise<DeployedAlkane> => {
      /*
        Mined, and espo caught up so reads after this see the contract.

        Deliberately the same waiter every other path uses: it treats a
        lookup that finds nothing as "not yet" and keeps polling, because a
        transaction sitting in the mempool reads exactly like one that does
        not exist. A waiter that gave up on not-found would fail whenever a
        block took longer than its patience — which, for the slowest thing
        the SDK does, is most of the time.
      */
      await awaitConfirmed(provider, revealTxid);

      /*
        …and the reveal's own trace names the id the runtime assigned, in its
        `create` event. Read from espo — the same place the package went out
        through — so a deployment needs no metashrew endpoint at all.
      */
      for (let attempt = 0; ; attempt++) {
        const summary = await provider.rpc.espo.getAlkaneTxSummary(revealTxid);
        if (!isBoxedError(summary)) {
          const events = summary.data.traces.flatMap((t) => t.events);
          const create = events.find((e) => e.event === "create");
          if (create) {
            const id = create.data as { block: string; tx: string };
            return new DeployedAlkane(
              id.block,
              id.tx,
              await tracesOf(provider, revealTxid),
            );
          }
          // traced, but nothing was created: the constructor reverted
          if (events.length > 0) {
            throw new Error(
              `deploy: reveal ${revealTxid} traced with no create event — the deployment did not happen`,
            );
          }
        }
        if (attempt >= 60) {
          throw new Error(
            `deploy: espo never served a trace for reveal ${revealTxid}`,
          );
        }
        await sleep(2000);
      }
    };

    return { commitTxid: this.commitTx.txid, revealTxid, waitForDeployment };
  }
}

/*
  What `.call(blueprint, "initialize", …)` knows about the constructor: the
  blueprint's alkabi document, which is where the method-name union and the
  argument's type come from — the same inference `.tx().call()` uses.
*/
type DocMethods<D> = D extends AlkabiDocument ? D["methods"][number] : never;
type MethodByName<D, N> = Extract<DocMethods<D>, { name: N }>;
type ConstructorArg<D, N> = D extends AlkabiDocument
  ? MethodByName<D, N> extends { input: infer I }
    ? [arg: InferAlkabiIo<I, D["types"]>]
    : []
  : [arg?: unknown];

/**
 * The deployment under construction — `account.deploy(wasm)` makes one,
 * `.call()` gives it its constructor, `.build()` turns it into a signed
 * `DeploymentPackage`.
 */
export class AlkaneDeployment {
  private constructorCall?: {
    contract: CallableContract;
    method: string;
    arg?: unknown;
  };

  constructor(
    private readonly account: Account,
    private readonly wasm: Uint8Array,
    private readonly options: DeployOptions = {},
  ) {}

  /**
   * The constructor call, written like any `.tx()` call — except the first
   * argument is the ABI itself, not a contract instance. The contract being
   * deployed has no alkane id yet, so there is nothing honest to instantiate;
   * the ABI is what actually types the method name and its argument, and the
   * cellpack targets the deployment envelope rather than any id.
   *
   *     account.deploy(wasm).call(MyContractAbi, "initialize", initArgs)
   *
   * A deployment runs exactly one constructor call.
   */
  call<const D extends AlkabiDocument, N extends MethodNameOf<D>>(
    abi: D,
    method: N,
    ...rest: ConstructorArg<D, N>
  ): this {
    if (this.constructorCall) {
      throw new Error(
        "deploy: a deployment has one constructor call, and this one already has it",
      );
    }
    if (this.options.calldata) {
      throw new Error(
        "deploy: the constructor is either .call() or options.calldata — not both",
      );
    }
    this.constructorCall = {
      // an id-less descriptor: only encodeCall is ever used, and the leading
      // [block, tx] words it emits are sliced off in favor of the envelope
      contract: new Contract(abi, { block: 0n, tx: 0n }) as CallableContract,
      method,
      arg: rest[0],
    };
    return this;
  }

  /**
   * Build and sign the pair.
   *
   *     .build()                    // account's rate, or the provider's
   *     .build({ feeRate: 3 })      // the PACKAGE lands on 3 sat/vB
   *
   * The rate is normalized over both transactions: the commit stays at the
   * relay floor, the reveal pays the deficit, and commitFee + revealFee over
   * commitVsize + revealVsize comes out to the number given.
   */
  build(buildOptions: TxBuildOptions = {}): BuildingDeployment {
    const inFlight = this.buildPackage(buildOptions);
    return Object.assign(inFlight, {
      send: (): SentDeployment => {
        // boxed so the SentDeployment survives `.then` without being flattened
        const boxed = inFlight.then((pkg) => ({ sent: pkg.send() }));
        const txids = boxed.then((b) => b.sent);
        return Object.assign(txids, {
          waitForDeployment: () => boxed.then((b) => b.sent.waitForDeployment()),
        });
      },
    });
  }

  private async buildPackage(
    buildOptions: TxBuildOptions = {},
  ): Promise<DeploymentPackage> {
    const account = this.account;
    const provider = account.provider;
    const network = provider.network;
    const addresses = normalizeTransactionAddresses(account.addresses);

    const packageFeeRate =
      buildOptions.feeRate ??
      this.options.feeRate ??
      account.feeRate ??
      provider.defaultFeeRate;
    const parentFeeRate = this.options.parentFeeRate ?? MIN_RELAY_FEE_RATE;

    /*
      The envelope: gzipped wasm in an ord-style inscription, hidden in the
      script tree of a P2TR output held by a throwaway key. The key exists for
      this one reveal — the commit output can only ever come back through the
      script path we are about to take, so nothing is lost with it.
    */
    const body = await gzip(Buffer.from(this.wasm), { level: 9 });
    const baseSigner = EcPair.makeRandom({ network });
    const revealSigner = tweakSigner(baseSigner, { network });
    const revealKey = toXOnly(Buffer.from(revealSigner.publicKey));

    const script = Buffer.from(
      p2tr_ord_reveal(revealKey, [
        { body, cursed: false, tags: { contentType: "" } },
      ]).script,
    );
    const envelope = payments.p2tr({
      internalPubkey: revealKey,
      scriptTree: { output: script },
      redeem: { output: script },
      network,
    });
    const controlBlock = envelope.witness![envelope.witness!.length - 1];

    /*
      The reveal's protostone: cellpack [1, 0] — deploy from this
      transaction's envelope — with the constructor inputs after it. Pointer
      and refund are output 0, the dust output below, so whatever the
      constructor mints comes to the deployer.

      A `.call()` encodes through the blueprint like any transaction call
      would; its cellpack leads with the blueprint's placeholder id, which is
      dropped here — the deployment's target is the envelope.
    */
    let calldata = this.options.calldata ?? [];
    if (this.constructorCall) {
      const { contract, method, arg } = this.constructorCall;
      calldata = contract.encodeCall(method, arg).calldata.slice(2);
    }
    const protostone = Buffer.from(
      encodeRunestoneProtostone({
        protostones: [
          ProtoStone.message({
            protocolTag: 1n,
            edicts: [],
            pointer: 0,
            refundPointer: 0,
            calldata: encipher([1n, 0n, ...calldata]),
          }),
        ],
      }).encodedRunestone,
    );

    /*
      The reveal's size is known before the commit exists: its one input is
      the envelope output (txid pending, size fixed), its outputs are the
      dust and the OP_RETURN. Sign a throwaway copy against a fake outpoint
      and measure it — the witness (signature + the whole script + control
      block) is what dominates, and this gets it exactly.
    */
    const revealVsize = this.revealTransaction({
      commitTxid: Buffer.alloc(32, 1).toString("hex"),
      envelopeVout: 0,
      envelopeValue: DUST + 1_000_000,
      envelopeScript: envelope.output!,
      leafScript: script,
      controlBlock,
      protostone,
      receiver: addresses.assetAddress,
      signer: revealSigner,
    }).virtualSize();

    /*
      CPFP arithmetic, to a fixed point: the commit funds the reveal's whole
      fee through the envelope output (the reveal has no other input), and
      the fee the reveal must pay depends on the commit's own fee and size —
      which can shift when funding it changes coin selection. Selection is
      deterministic, so this settles in a pass or two.
    */
    // every commit pass — measure or build, whichever iteration — spends
    // against the same chain state, so the outpoints are fetched once
    const spendableCache = new Map<string, Promise<FormattedUtxo[]>>();

    let childFee = Math.ceil(revealVsize * packageFeeRate);
    let commitBuild: { psbtBase64: string; fee: number; vsize: number };
    for (let attempt = 0; ; attempt++) {
      commitBuild = consumeOrThrow(
        await getProtostoneUnsignedPsbtBase64(account.addresses, {
          provider,
          transfers: [
            { asset: "btc", amount: DUST + childFee, address: envelope.address! },
          ],
          excludeProtostone: true,
          feeRate: parentFeeRate,
          minimumFee: 0,
          spendableCache,
        }),
      );
      const next = computeCpfpChildFee({
        parentFee: commitBuild.fee,
        parentVsize: commitBuild.vsize,
        childVsize: revealVsize,
        packageFeeRate,
      }).childFee;
      // funded at least what the package needs → the pair can only overshoot
      if (next <= childFee || attempt >= 3) {
        childFee = Math.max(childFee, next);
        break;
      }
      childFee = next;
    }

    /* commit: signed by the account, like any of its transactions */
    const signedCommit = await account.sign(commitBuild.psbtBase64);
    const commitTx = Psbt.fromBase64(signedCommit, {
      network,
    }).extractTransaction();
    const commitTxid = commitTx.getId();

    const envelopeVout = commitTx.outs.findIndex((out) =>
      out.script.equals(envelope.output!),
    );
    if (envelopeVout < 0) {
      throw new Error("deploy: the signed commit lost its envelope output");
    }
    const envelopeValue = commitTx.outs[envelopeVout].value;

    /* reveal: signed by the throwaway key, through the script path */
    const revealTx = this.revealTransaction({
      commitTxid,
      envelopeVout,
      envelopeValue,
      envelopeScript: envelope.output!,
      leafScript: script,
      controlBlock,
      protostone,
      receiver: addresses.assetAddress,
      signer: revealSigner,
    });

    const commitInputValue = sumPsbtInputs(
      Psbt.fromBase64(commitBuild.psbtBase64, { network }),
    );
    const commitFee =
      commitInputValue - commitTx.outs.reduce((a, o) => a + o.value, 0);

    return new DeploymentPackage(
      account,
      {
        hex: commitTx.toHex(),
        txid: commitTxid,
        vsize: commitTx.virtualSize(),
        fee: commitFee,
      },
      {
        hex: revealTx.toHex(),
        txid: revealTx.getId(),
        vsize: revealTx.virtualSize(),
        fee: envelopeValue - DUST,
      },
    );
  }

  /**
   * The reveal, built and signed: one script-path input spending the
   * envelope, a dust output pointing the deployment's result at the
   * deployer, and the protostone. Everything the envelope holds beyond the
   * dust is the fee — the commit put it there for exactly that.
   */
  private revealTransaction(args: {
    commitTxid: string;
    envelopeVout: number;
    envelopeValue: number;
    envelopeScript: Buffer;
    leafScript: Buffer;
    controlBlock: Buffer;
    protostone: Buffer;
    receiver: string;
    signer: Parameters<Psbt["signInput"]>[1];
  }): Transaction {
    const psbt = new Psbt({
      network: this.account.provider.network,
      maximumFeeRate: 1_000_000_000,
    });
    psbt.addInput({
      hash: args.commitTxid,
      index: args.envelopeVout,
      witnessUtxo: { value: args.envelopeValue, script: args.envelopeScript },
      tapLeafScript: [
        {
          leafVersion: LEAF_VERSION_TAPSCRIPT,
          script: args.leafScript,
          controlBlock: args.controlBlock,
        },
      ],
    });
    psbt.addOutput({ value: DUST, address: args.receiver });
    psbt.addOutput({ value: 0, script: args.protostone });
    psbt.signInput(0, args.signer);
    psbt.finalizeInput(0);
    return psbt.extractTransaction();
  }
}

function sumPsbtInputs(psbt: Psbt): number {
  return psbt.data.inputs.reduce((acc, input, index) => {
    if (input.witnessUtxo) return acc + input.witnessUtxo.value;
    if (input.nonWitnessUtxo) {
      const prev = Transaction.fromBuffer(input.nonWitnessUtxo);
      return acc + prev.outs[psbt.txInputs[index].index].value;
    }
    throw new Error(`deploy: commit input ${index} carries no utxo info`);
  }, 0);
}
