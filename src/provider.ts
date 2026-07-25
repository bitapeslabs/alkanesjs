import type { Network as BitcoinNetwork } from "bitcoinjs-lib";
import {
  RpcCall,
  RpcError,
  buildRpcCall as sandshrewBuildRpcCall,
} from "@/apis/sandshrew/shared";
import { WaitPacer } from "./pacer";

import { AlkanesExecuteError, execute, simulate } from "@/libs/alkanes";
import {
  runSimulatedBlock,
  type AlkaneTx,
  type BlockResults,
} from "@/libs/alkanes/account";
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
  electrumApiUrl: string;
  network: BitcoinNetwork;
  explorerUrl: string;
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
 * Where the provider's JSON-RPC goes. The normal shape is a single `kirbyUrl`
 * — kirby serves metashrew/alkanes/esplora methods on `/rpc` and espo on
 * `/espo`, so both endpoints derive from it. The split `sandshrewUrl` +
 * `espoUrl` form remains for talking to the upstreams directly (comparison
 * runs, or environments without a kirby).
 */
export type ProviderConfig = ProviderConfigBase &
  (
    | { kirbyUrl: string; sandshrewUrl?: never; espoUrl?: never }
    | { sandshrewUrl: string; espoUrl?: string; kirbyUrl?: never }
  );

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
  readonly sandshrewUrl: string;
  readonly electrumApiUrl: string;
  readonly espoUrl?: string;
  readonly network: BitcoinNetwork;
  readonly explorerUrl: string;
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
    if (config.kirbyUrl) {
      const kirby = config.kirbyUrl.replace(/\/+$/, "");
      this.sandshrewUrl = `${kirby}/rpc`;
      this.espoUrl = `${kirby}/espo`;
    } else {
      this.sandshrewUrl = config.sandshrewUrl!;
      this.espoUrl = config.espoUrl;
    }
    this.electrumApiUrl = config.electrumApiUrl;
    this.network = config.network;
    this.explorerUrl = config.explorerUrl.replace(/\/+$/, "");
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

  protected txUrl(txid: string): string {
    return `${this.explorerUrl}/tx/${txid}`;
  }
  protected addressUrl(address: string): string {
    return `${this.explorerUrl}/address/${address}`;
  }

  buildRpcCall<T>(method: string, params: unknown[] = []): RpcCall<T> {
    return sandshrewBuildRpcCall<T>(method, params, this.sandshrewUrl);
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
   *       alice.tx().call(pool).getReserves().unwrap(),
   *       alice.tx().call(pool).swap(args, pays),
   *       alice.tx().call(pool).getReserves().unwrap(),
   *     ]);
   *
   * Needs kirby — `kirby_simulateblock`; a bare metashrew has no notion of a
   * chunk, which is why this hangs off the provider rather than off a
   * transaction: the endpoint is the provider's to know.
   */
  simulateBlock<T extends readonly AlkaneTx<any, any>[]>(
    // `[...T]` rather than `T`: it makes the array literal infer as a tuple, so
    // each slot keeps its own type instead of collapsing to a union
    txs: readonly [...T],
  ): Promise<BlockResults<T>> {
    return runSimulatedBlock(this, txs);
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
