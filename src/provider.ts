import type { Network as BitcoinNetwork } from "bitcoinjs-lib";
import {
  RpcCall,
  RpcError,
  buildRpcCall as sandshrewBuildRpcCall,
} from "@/apis/sandshrew/shared";
import { WaitPacer } from "./pacer";

import { AlkanesExecuteError, execute, simulate } from "@/libs/alkanes";
import {
  buildChain,
  runSimulatedBlock,
  type AlkaneTx,
  type BlockResults,
} from "@/libs/alkanes/account";
import { Confirmed, tracesOf } from "@/libs/alkanes/confirm";

/**
 * A package in flight. Await it for the txids, in the order given, or chain
 * `waitForConfirmation()` to wait the whole package out.
 */
export type SentPackage = Promise<string[]> & {
  /** Wait the package out; resolves to one `Confirmed` per transaction, in order. */
  waitForConfirmation: () => Promise<Confirmed[]>;
};
import {
  decodeSimulateBlockResponse,
  decodeSimulateTransactionResponse,
  encodeSimulateBlockRequest,
  encodeSimulateTransactionRequest,
  type SimulatedBlock,
  type SimulatedTransaction,
} from "@/apis/alkanes/simtx";
import {
  retryOnBoxedError,
  BoxedResponse,
  BoxedSuccess,
  BoxedError,
  isBoxedError,
  consumeOrThrow,
} from "@/boxed";

import {
  AlkanesRpcProvider,
  AlkanesTraceCreateEvent,
  AlkanesTraceInvokeEvent,
  AlkanesTraceReturnEvent,
  BaseRpcProvider,
  AlkanesTraceError,
  AlkanesTraceResult,
  IEsploraTransaction,
} from "./apis";

import { sleep } from "@/utils";
import { AlkanesSimulationError } from "./libs";
import { setFetchDebug } from "./debug";

interface ProviderConfigBase {
  network: BitcoinNetwork;
  defaultFeeRate?: number;
  btcTicker?: string;
  pacerSettings?: PacerSettings;
  /** When true, logs every API call as `[CALL] <endpoint> <body>`. */
  /**
   * API-call logging level. 0 (default) — silent. 1 — one line per outgoing
   * request: URL, rpc method, response time. 2 — the JSON body as well.
   */
  debug?: number;
}

/**
 * Where the provider's JSON-RPC goes. `metashrewUrl` is any endpoint speaking
 * the metashrew/alkanes methods — a kirby's `/rpc`, a sandshrew-style gateway,
 * subfrost — they all answer the same contract, which is the point: the SDK
 * targets the standard API and the URL decides who serves it. `espoUrl` is
 * espo's own getters (a kirby's `/espo`, or espo directly).
 */
export type ProviderConfig = ProviderConfigBase & {
  metashrewUrl: string;
  espoUrl?: string;
};

enum AlkanesPollError {
  UnknownError = "UnknownError",
}

type PacerSettings = {
  intervalMs: number;
  maxPerInterval: number;
};

export type AlkanesParsedTraceResult = {
  create?: AlkanesTraceCreateEvent["data"];
  invoke?: AlkanesTraceInvokeEvent["data"];
  return: AlkanesTraceReturnEvent["data"];
};

export class Provider {
  readonly metashrewUrl: string;
  readonly espoUrl?: string;
  readonly network: BitcoinNetwork;
  readonly pacerSettings: PacerSettings = {
    intervalMs: 1000,
    maxPerInterval: 10,
  };
  readonly btcTicker: string;
  readonly jitterMs = 1000; // 1 second
  readonly rpc: BaseRpcProvider;
  readonly defaultFeeRate: number;
  private readonly TIMEOUT_MS = 60_000 * 5; // 5 minutes
  private readonly INTERVAL_MS = 5_000; // 5 seconds
  public pacer: WaitPacer;

  constructor(config: ProviderConfig) {
    this.metashrewUrl = config.metashrewUrl;
    this.espoUrl = config.espoUrl;
    this.network = config.network;
    this.btcTicker = config.btcTicker ?? "BTC";
    this.pacerSettings = config.pacerSettings ?? this.pacerSettings;
    this.defaultFeeRate = config.defaultFeeRate ?? 5;

    this.rpc = new BaseRpcProvider(this);
    this.pacer = new WaitPacer(this.pacerSettings);

    if (config.debug) this.setDebug(config.debug);
  }

  /**
   * Set API-call logging: 0 silent, 1 method + response time per request,
   * 2 the JSON body as well. All transports share one fetch wrapper, so this
   * applies globally.
   */
  setDebug(level: number): void {
    setFetchDebug(level);
  }

  buildRpcCall<T>(method: string, params: unknown[] = []): RpcCall<T> {
    return sandshrewBuildRpcCall<T>(method, params, this.metashrewUrl);
  }

  execute(
    config: Omit<Parameters<typeof execute>[0], "provider">,
  ): ReturnType<typeof execute> {
    return retryOnBoxedError({
      intervalMs: this.INTERVAL_MS,
      timeoutMs: this.TIMEOUT_MS,
    })(
      () => execute({ provider: this, ...config }),
      (attempt, res) => {
        console.warn(
          `EXECUTE: Attempt ${attempt + 1}: Failed to execute request (response: ${res.errorType + ": " + res.message}). Retrying...`,
        );
      },
      [AlkanesExecuteError.UnknownError, AlkanesExecuteError.InvalidParams],
    );
  }
  /**
   * Simulate a chunk of transactions in order against one shared state, the way
   * they would land in a block — each sees the storage the ones before it wrote
   * and the alkanes they moved. They go out as raw transaction hex, so what is
   * simulated is the transaction rather than a description of one.
   *
   *     const [before, , after] = await provider.simulateBlock([
   *       alice.tx().call(pool, "getReserves").unwrap(),
   *       alice.tx().transfer(TOKEN_0, amountIn, 1).call(pool, "swap", args),
   *       alice.tx().call(pool, "getReserves").unwrap(),
   *     ]);
   *
   * Goes out as `alkanes_simulateblock` — the transactions wrapped in a block,
   * which is the authoritative way to ask this. It hangs off the provider
   * rather than off a transaction because a chunk is nobody's transaction in
   * particular, and the endpoint is the provider's to know.
   */
  simulateBlock<T extends readonly AlkaneTx<any, any>[]>(
    // `[...T]` rather than `T`: it makes the array literal infer as a tuple, so
    // each slot keeps its own type instead of collapsing to a union
    txs: readonly [...T],
  ): Promise<BlockResults<T>> {
    return runSimulatedBlock(this, txs);
  }

  /**
   * Broadcast a dependent run of transactions as ONE package — the same build
   * `simulateBlock` does, then espo's `btc.submit_package`.
   *
   *     const { txids } = await provider.sendPackage([wrap, swap]);
   *     await sent.waitForConfirmation();
   *
   * A package is judged on its COMBINED fee rate, so a parent paying under the
   * mempool minimum still relays when the child covers the deficit — and the
   * child may spend outputs the parent has not had confirmed, which is what
   * makes a `.spending()` chain broadcastable at all. Order matters: parents
   * before the children that spend them, which is the order given.
   *
   * Waiting resolves once the LAST transaction is mined and espo has indexed
   * its block — a package is mined together, so that is the whole run — and
   * answers with one `Confirmed` per transaction, traces included.
   */
  sendPackage(
    txs: readonly AlkaneTx<any, any>[],
  ): SentPackage {
    const inFlight = (async () => {
      const built = await buildChain(this, txs);
      const unsigned = built.find((b) => !b.signed);
      if (unsigned) {
        throw new Error(
          "sendPackage: a transaction carries placeholder witnesses — a " +
            "ViewAccount builds bytes a simulation accepts, not bytes a node will",
        );
      }
      consumeOrThrow(await this.rpc.espo.submitPackage(built.map((b) => b.hex)));
      return built.map((b) => b.txid);
    })();

    return Object.assign(inFlight, {
      waitForConfirmation: async (): Promise<Confirmed[]> => {
        const txids = await inFlight;
        const last = txids[txids.length - 1];
        // mined…
        let height = 0;
        for (;;) {
          const tx = await this.rpc.electrum.esplora_gettransaction(last);
          if (!isBoxedError(tx) && tx.data.status?.confirmed) {
            height = tx.data.status.block_height ?? 0;
            break;
          }
          await sleep(2000);
        }
        // …and indexed, so a read after this sees what the package did
        for (;;) {
          const tip = await this.rpc.espo.getTipHeight();
          if (!isBoxedError(tip) && tip.data.height >= height) break;
          await sleep(1000);
        }
        // a package mines together, so every transaction is readable now
        return Promise.all(
          txids.map(async (txid) =>
            new Confirmed(txid, this, await tracesOf(this, txid)),
          ),
        );
      },
    });
  }

  /**
   * Simulate one raw transaction — signed or not, since nothing here checks a
   * signature — via `alkanes_simulatetransaction`, the metashrew view for
   * exactly this question. kirby answers tip-state requests itself and hands
   * anything else to metashrew, so this call behaves identically against
   * either endpoint; kirby is just the fast way to ask.
   */
  async simulateTransaction(
    txHex: string,
    era?: number,
  ): Promise<SimulatedTransaction> {
    const result = await this.protobufView(
      "alkanes_simulatetransaction",
      (tip) => encodeSimulateTransactionRequest(txHex, tip),
      era,
    );
    return decodeSimulateTransactionResponse(result);
  }

  /** The height the endpoint has indexed to. */
  async height(): Promise<number> {
    return Number(consumeOrThrow(await this.rpc.alkanes.alkanes_metashrewHeight().call()));
  }

  /**
   * Simulate a whole consensus-encoded block — `alkanes_simulateblock`, the
   * same view for a block that `simulateTransaction` is for a transaction.
   * Every transaction runs in order against one shared state, so each sees
   * what the ones before it did. `simulateBlock` is the ergonomic way in;
   * this is here for callers holding block bytes already.
   */
  async simulateRawBlock(
    blockHex: string,
    era?: number,
  ): Promise<SimulatedBlock> {
    const result = await this.protobufView(
      "alkanes_simulateblock",
      (tip) => encodeSimulateBlockRequest(blockHex, tip),
      era,
    );
    return decodeSimulateBlockResponse(result);
  }

  /**
   * One of the hex-protobuf metashrew views, asked at the current era.
   *
   * The height in these requests selects the consensus era, not the state —
   * passing 0 means pre-genesis rules and nothing modern survives them. So ask
   * the endpoint where its tip is first; one small call, and it makes the
   * request correct against bare metashrew and kirby alike.
   *
   * `era` overrides that, for the one case where the endpoint's own answer is
   * the wrong one: asking two endpoints the same question. They index
   * independently and are routinely a block apart, so letting each pick its
   * own tip means comparing answers from two different eras.
   */
  private async protobufView(
    method: string,
    request: (tip: number) => string,
    era?: number,
  ): Promise<string> {
    const ask = (body: unknown) =>
      fetch(this.metashrewUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<any>);

    const tip =
      era ??
      Number(
        (await ask({ jsonrpc: "2.0", id: 1, method: "metashrew_height", params: [] }))
          ?.result ?? 0,
      );
    const json = await ask({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: [request(tip)],
    });
    if (json?.error || typeof json?.result !== "string") {
      throw new Error(json?.error?.message ?? `${method} failed`);
    }
    return json.result;
  }

  simulate(
    request: Parameters<typeof simulate>[1],
  ): ReturnType<typeof simulate> {
    return retryOnBoxedError({
      intervalMs: this.INTERVAL_MS,
      timeoutMs: this.TIMEOUT_MS,
    })(
      () => simulate(this, request),
      (attempt, res) => {
        console.warn(
          `SIMULATE: Attempt ${attempt + 1}: Failed to simulate request (response: ${res.errorType + ": " + res.message}). Retrying...`,
        );
      },
      [AlkanesSimulationError.TransactionReverted],
    );
  }

  trace(
    ...args: Parameters<typeof AlkanesRpcProvider.prototype.alkanes_trace>
  ): ReturnType<
    ReturnType<typeof AlkanesRpcProvider.prototype.alkanes_trace>["call"]
  > {
    return retryOnBoxedError({
      intervalMs: this.INTERVAL_MS,
      timeoutMs: this.TIMEOUT_MS,
    })(
      () => this.rpc.alkanes.alkanes_trace(...args).call(),
      (attempt, res) => {
        console.warn(
          `TRACE: Attempt ${attempt + 1}: Failed to fetch trace for txid: ${args[0]} (response: ${res.errorType + ": " + res.message}). Retrying...`,
        );
      },
      [AlkanesTraceError.TransactionReverted, AlkanesTraceError.NoTraceFound],
    );
  }

  waitForBlocks = async (
    amount: number,
  ): Promise<BoxedResponse<boolean, AlkanesPollError>> => {
    try {
      let initialBlockCount = Number(
        consumeOrThrow(await this.rpc.alkanes.alkanes_metashrewHeight().call()),
      );
      let currentBlockCount = Number(initialBlockCount);

      while (currentBlockCount < initialBlockCount + amount) {
        currentBlockCount = Number(
          consumeOrThrow(
            await this.rpc.alkanes.alkanes_metashrewHeight().call(),
          ),
        );
        if (currentBlockCount > initialBlockCount + amount) break;
        await sleep(this.INTERVAL_MS);
      }
      return new BoxedSuccess(true);
    } catch (err) {
      return new BoxedError("An error occurred while waiting for blocks: " + (err as Error).message, AlkanesPollError.UnknownError);
    }
  };

  waitForTraceResult = async (
    txid: string,
  ): Promise<BoxedResponse<AlkanesParsedTraceResult, AlkanesTraceError>> => {
    let tx = consumeOrThrow(
      await retryOnBoxedError({
        intervalMs: 1000,
        timeoutMs: 10000,
      })(() => this.rpc.electrum.esplora_gettransaction(txid)),
    );

    let result: AlkanesParsedTraceResult | undefined = undefined;
    let maxAttempts = 300;
    while (result === undefined) {
      let traceResults = await Promise.all([
        this.trace(txid, tx.vout.length + 1),
        this.trace(txid, tx.vout.length + 2),
      ]);

      let errors = traceResults.filter(isBoxedError);
      let success = (
        traceResults.filter((result) => !isBoxedError(result)) as
          | BoxedSuccess<AlkanesTraceResult, AlkanesTraceError>[]
          | undefined
      )?.[0]?.data;

      let revertError = errors.find(
        (result) => result.errorType === AlkanesTraceError.TransactionReverted,
      );
      if (revertError) {
        return revertError;
      }

      if (success) {
        const createEvent = success.find((e) => e.event === "create");
        const invokeEvent = success.find((e) => e.event === "invoke")!; //There will always be an invoke event
        const returnEvent = success.findLast((e) => e.event === "return")!; //There will always be a return event
        result = {
          create: createEvent?.data as AlkanesTraceCreateEvent["data"],
          invoke: invokeEvent?.data as AlkanesTraceInvokeEvent["data"],
          return: returnEvent?.data as AlkanesTraceReturnEvent["data"],
        };
      }

      if (maxAttempts-- <= 0) {
        return new BoxedError("No trace found for the given txid after 300 attempts", AlkanesTraceError.NoTraceFound);
      }

      await sleep(2000);
    }
    return new BoxedSuccess(result);
  };

  waitForConfirmation = async (
    txid: string,
  ): Promise<BoxedResponse<boolean, AlkanesPollError>> => {
    try {
      let tx: IEsploraTransaction | undefined = undefined;
      while (!tx?.status.confirmed) {
        tx = consumeOrThrow(
          await retryOnBoxedError({
            intervalMs: 1000,
            timeoutMs: 10000,
          })(() => this.rpc.electrum.esplora_gettransaction(txid)),
        );

        if (tx?.status.confirmed) break;
        await sleep(4_000);
      }
      return new BoxedSuccess(true);
    } catch (err) {
      return new BoxedError("An error ocurred while waiting for tx confirmation: " +
          (err as Error).message, AlkanesPollError.UnknownError);
    }
  };
}
