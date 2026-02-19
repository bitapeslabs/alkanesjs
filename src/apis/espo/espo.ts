import { BoxedResponse, Err, Ok } from "bxrs";
import {
  EspoOkResult,
  EspoErrorResult,
  EspoEssentialsPingResult,
  EspoAmmdataPingResult,
  UnwrapEspoResult,
  EspoTipHeight,
  EspoAlkaneId,
  EspoOutpoint,
  EspoAmountString,
  EspoGetKeysParams,
  EspoGetKeys,
  EspoGetKeysOk,
  EspoGetKeysRpcOk,
  EspoGetKeysRpcResult,
  EspoKeyValueItem,
  EspoKeyValueItemRaw,
  EspoHolderRaw,
  EspoBalanceEntry,
  EspoBalanceEntryRaw,
  EspoOutpointBalance,
  EspoOutpointBalanceRaw,
  EspoOutpointBalanceWithAddress,
  EspoOutpointBalanceWithAddressRaw,
  EspoTrade,
  EspoTradeRaw,
  EspoPool,
  EspoPoolRaw,
  EspoSwapHop,
  EspoSwapHopRaw,
  EspoGetHoldersParams,
  EspoGetHolders,
  EspoGetHoldersOk,
  EspoGetHoldersResult,
  EspoGetHoldersRpcOk,
  EspoGetHoldersRpcResult,
  EspoGetAddressBalancesParams,
  EspoGetAddressBalances,
  EspoGetAddressBalancesOk,
  EspoGetAddressBalancesResult,
  EspoGetAddressBalancesRpcOk,
  EspoGetAddressBalancesRpcResult,
  EspoGetOutpointBalances,
  EspoGetOutpointBalancesOk,
  EspoGetOutpointBalancesResult,
  EspoGetOutpointBalancesRpcOk,
  EspoGetOutpointBalancesRpcResult,
  EspoGetHoldersCount,
  EspoGetHoldersCountResult,
  EspoGetHoldersCountOk,
  EspoGetAddressOutpoints,
  EspoGetAddressOutpointsResult,
  EspoGetAddressOutpointsOk,
  EspoGetAddressOutpointsRpcOk,
  EspoGetAddressOutpointsRpcResult,
  EspoGetCandlesParams,
  EspoGetCandles,
  EspoGetCandlesOk,
  EspoGetCandlesResult,
  EspoGetTradesParams,
  EspoGetTrades,
  EspoGetTradesOk,
  EspoGetTradesResult,
  EspoGetTradesRpcOk,
  EspoGetTradesRpcResult,
  EspoGetPoolsParams,
  EspoGetPools,
  EspoGetPoolsOk,
  EspoGetPoolsResult,
  EspoGetPoolsRpcOk,
  EspoGetPoolsRpcResult,
  EspoFindBestSwapPathParams,
  EspoFindBestSwapPath,
  EspoFindBestSwapPathOk,
  EspoFindBestSwapPathResult,
  EspoFindBestSwapPathRpcOk,
  EspoFindBestSwapPathRpcResult,
  EspoGetBestMevSwapParams,
  EspoGetBestMevSwap,
  EspoGetBestMevSwapOk,
  EspoGetBestMevSwapResult,
  EspoGetBestMevSwapRpcOk,
  EspoGetBestMevSwapRpcResult,
} from "./types";
import { RpcCall } from "./utils/jsonrpc";
import { stripFields } from "./utils";

type AmountLike = EspoAmountString | number | bigint;

type GetKeysOptions = Partial<
  Omit<EspoGetKeysParams, "alkane" | "try_decode_utf8">
> & {
  try_decode_utf8?: boolean;
  tryDecodeUtf8?: boolean;
};

type GetHoldersOptions = Partial<Omit<EspoGetHoldersParams, "alkane">>;

type GetAddressBalancesOptions = {
  include_outpoints?: boolean;
  includeOutpoints?: boolean;
};

type GetCandlesOptions = Partial<Omit<EspoGetCandlesParams, "pool">>;

type GetTradesOptions = Partial<
  Omit<EspoGetTradesParams, "pool" | "filter_side">
> & {
  filter_side?: EspoGetTradesParams["filter_side"];
  filterSide?: EspoGetTradesParams["filter_side"];
};

type GetPoolsOptions = Partial<EspoGetPoolsParams>;

interface FindBestSwapPathOptions {
  mode?: EspoFindBestSwapPathParams["mode"];
  amount_in?: AmountLike;
  amountIn?: AmountLike;
  amount_out_min?: AmountLike;
  amountOutMin?: AmountLike;
  amount_out?: AmountLike;
  amountOut?: AmountLike;
  amount_in_max?: AmountLike;
  amountInMax?: AmountLike;
  available_in?: AmountLike;
  availableIn?: AmountLike;
  fee_bps?: number;
  feeBps?: number;
  max_hops?: number;
  maxHops?: number;
}

type GetBestMevSwapOptions = {
  fee_bps?: number;
  feeBps?: number;
  max_hops?: number;
  maxHops?: number;
};

export class Espo {
  rpc_url: string;

  constructor(url: string) {
    this.rpc_url = url;
  }

  private resultToBoxed<T extends EspoOkResult | EspoErrorResult>(
    result: T
  ): BoxedResponse<UnwrapEspoResult<T>, string> {
    const stripped = stripFields(result, ["ok", "error", "hint"] as const);

    return Ok<UnwrapEspoResult<T>, string>(stripped);
  }

  private async callAndUnbox<
    OkT extends EspoOkResult,
    ResultT extends OkT | EspoErrorResult
  >(
    method: string,
    params?: object | unknown[]
  ): Promise<BoxedResponse<UnwrapEspoResult<OkT>, string>> {
    const rpcParams =
      params === undefined
        ? []
        : (params as Record<string, unknown> | unknown[]);

    const response = await RpcCall<ResultT>(
      this.rpc_url,
      method,
      rpcParams
    ).call();

    if (response.isErr()) {
      return response as BoxedResponse<UnwrapEspoResult<OkT>, string>;
    }

    const data = response.data;

    if (!("ok" in data) || data.ok === false) {
      const errorPayload = data as Partial<EspoErrorResult>;
      const errorMessage =
        typeof errorPayload.error === "string"
          ? errorPayload.error
          : "Unknown Espo error";
      const hint =
        typeof errorPayload.hint === "string" && errorPayload.hint.length > 0
          ? ` (${errorPayload.hint})`
          : "";

      return Err(`${errorMessage}${hint}`);
    }

    return this.resultToBoxed(data as OkT);
  }

  private normalizeAmountLike(
    value?: AmountLike
  ): EspoAmountString | number | undefined {
    if (value === undefined) {
      return undefined;
    }

    return typeof value === "bigint" ? value.toString() : value;
  }

  private parseAmountString(value: EspoAmountString): number {
    return Number(value) / 1e8;
  }

  private normalizeBalanceEntry(entry: EspoBalanceEntryRaw): EspoBalanceEntry {
    return {
      alkane: entry.alkane,
      amount: this.parseAmountString(entry.amount),
    };
  }

  private hexStringToUint8Array(value: string): Uint8Array {
    const hex = value.startsWith("0x") ? value.slice(2) : value;

    if (hex.length % 2 !== 0) {
      return new Uint8Array();
    }

    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      const byte = Number.parseInt(hex.slice(i, i + 2), 16);
      if (Number.isNaN(byte)) {
        return new Uint8Array();
      }
      bytes[i / 2] = byte;
    }

    return bytes;
  }

  private toBigIntAmount(value: EspoAmountString): bigint {
    return BigInt(value);
  }

  private toOptionalBigInt(
    value: EspoAmountString | string | null | undefined
  ): bigint | null {
    if (value === undefined || value === null) {
      return null;
    }

    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  private normalizePool(pool: EspoPoolRaw): EspoPool {
    return {
      ...pool,
      base_reserve: this.toBigIntAmount(pool.base_reserve),
      quote_reserve: this.toBigIntAmount(pool.quote_reserve),
    };
  }

  private normalizePoolsRecord(
    pools: Record<EspoAlkaneId, EspoPoolRaw>
  ): Record<EspoAlkaneId, EspoPool> {
    const normalized: Record<EspoAlkaneId, EspoPool> = {} as Record<
      EspoAlkaneId,
      EspoPool
    >;

    for (const key of Object.keys(pools) as EspoAlkaneId[]) {
      normalized[key] = this.normalizePool(pools[key]);
    }

    return normalized;
  }

  private normalizeSwapHop(hop: EspoSwapHopRaw): EspoSwapHop {
    return {
      ...hop,
      amount_in: this.toBigIntAmount(hop.amount_in),
      amount_out: this.toBigIntAmount(hop.amount_out),
    };
  }

  private normalizeTrade(trade: EspoTradeRaw): EspoTrade {
    return {
      ...trade,
      xpubkey: this.hexStringToUint8Array(trade.xpubkey),
      base_inflow: this.toBigIntAmount(trade.base_inflow),
      quote_inflow: this.toBigIntAmount(trade.quote_inflow),
    };
  }

  private normalizeOutpointBalance(
    balance: EspoOutpointBalanceRaw
  ): EspoOutpointBalance {
    return {
      outpoint: balance.outpoint,
      entries: balance.entries.map((entry: EspoBalanceEntryRaw) =>
        this.normalizeBalanceEntry(entry)
      ),
    };
  }

  private normalizeOutpointBalanceWithAddress(
    balance: EspoOutpointBalanceWithAddressRaw
  ): EspoOutpointBalanceWithAddress {
    return {
      ...this.normalizeOutpointBalance(balance),
      ...(balance.address !== undefined ? { address: balance.address } : {}),
    };
  }

  private normalizeBalancesRecord(
    balances: Record<EspoAlkaneId, EspoAmountString>
  ): Record<EspoAlkaneId, number> {
    const normalized: Record<EspoAlkaneId, number> = {} as Record<
      EspoAlkaneId,
      number
    >;

    for (const alkane of Object.keys(balances) as EspoAlkaneId[]) {
      normalized[alkane] = this.parseAmountString(balances[alkane]);
    }

    return normalized;
  }

  public ping(): Promise<BoxedResponse<"pong", string>> {
    return RpcCall<EspoEssentialsPingResult>(
      this.rpc_url,
      "essentials.ping"
    ).call();
  }

  public ammdataPing(): Promise<BoxedResponse<"pong", string>> {
    return RpcCall<EspoAmmdataPingResult>(this.rpc_url, "ammdata.ping").call();
  }

  public getTipHeight(): Promise<
    BoxedResponse<UnwrapEspoResult<EspoTipHeight>, string>
  > {
    return RpcCall<EspoTipHeight>(this.rpc_url, "get_espo_height").call();
  }

  public getHoldersCount(
    alkane: EspoAlkaneId
  ): Promise<BoxedResponse<EspoGetHoldersCount, string>> {
    return this.callAndUnbox<EspoGetHoldersCountOk, EspoGetHoldersCountResult>(
      "essentials.get_holders_count",
      { alkane }
    );
  }

  public async getKeys(
    alkane: EspoAlkaneId,
    options: GetKeysOptions = {}
  ): Promise<BoxedResponse<EspoGetKeys, string>> {
    const { try_decode_utf8, tryDecodeUtf8, ...rest } = options;
    const params: Record<string, unknown> = {
      ...rest,
      alkane,
    };

    const decodeUtf8 = try_decode_utf8 ?? tryDecodeUtf8;
    if (decodeUtf8 !== undefined) {
      params.try_decode_utf8 = decodeUtf8;
    }

    const response = await this.callAndUnbox<
      EspoGetKeysRpcOk,
      EspoGetKeysRpcResult
    >("essentials.get_keys", params);

    if (response.isErr()) {
      return response as BoxedResponse<EspoGetKeys, string>;
    }

    const normalizedItems: Record<string, EspoKeyValueItem> = {};
    const entries = Object.entries(response.data.items) as [
      string,
      EspoKeyValueItemRaw
    ][];

    for (const [key, item] of entries) {
      normalizedItems[key] = {
        ...item,
        value_u128: this.toOptionalBigInt(item.value_u128),
      };
    }

    const normalized: EspoGetKeys = {
      ...response.data,
      items: normalizedItems,
    };

    return Ok<EspoGetKeys, string>(normalized);
  }

  public async getHolders(
    alkane: EspoAlkaneId,
    options: GetHoldersOptions = {}
  ): Promise<BoxedResponse<EspoGetHolders, string>> {
    const response = await this.callAndUnbox<
      EspoGetHoldersRpcOk,
      EspoGetHoldersRpcResult
    >("essentials.get_holders", {
      ...options,
      alkane,
    });

    if (response.isErr()) {
      return response as BoxedResponse<EspoGetHolders, string>;
    }

    const normalizedItems = response.data.items.map(
      (holder: EspoHolderRaw) => ({
        address: holder.address,
        amount: this.parseAmountString(holder.amount),
      })
    );

    const normalized: EspoGetHolders = {
      ...response.data,
      items: normalizedItems,
    };

    return Ok<EspoGetHolders, string>(normalized);
  }

  public async getAddressBalances(
    address: string,
    options: GetAddressBalancesOptions = {}
  ): Promise<BoxedResponse<EspoGetAddressBalances, string>> {
    const includeOutpoints =
      options.include_outpoints ?? options.includeOutpoints;
    const params: EspoGetAddressBalancesParams = {
      address,
      ...(includeOutpoints !== undefined
        ? { include_outpoints: includeOutpoints }
        : {}),
    };

    const response = await this.callAndUnbox<
      EspoGetAddressBalancesRpcOk,
      EspoGetAddressBalancesRpcResult
    >("essentials.get_address_balances", params);

    if (response.isErr()) {
      return response as BoxedResponse<EspoGetAddressBalances, string>;
    }

    const { outpoints, ...rest } = response.data;
    const normalizedOutpoints = outpoints?.map(
      (outpoint: EspoOutpointBalanceRaw) =>
        this.normalizeOutpointBalance(outpoint)
    );

    const normalized: EspoGetAddressBalances = {
      ...rest,
      balances: this.normalizeBalancesRecord(rest.balances),
      ...(normalizedOutpoints ? { outpoints: normalizedOutpoints } : {}),
    };

    return Ok<EspoGetAddressBalances, string>(normalized);
  }

  public async getOutpointBalances(
    outpoint: EspoOutpoint
  ): Promise<BoxedResponse<EspoGetOutpointBalances, string>> {
    const response = await this.callAndUnbox<
      EspoGetOutpointBalancesRpcOk,
      EspoGetOutpointBalancesRpcResult
    >("essentials.get_outpoint_balances", { outpoint });

    if (response.isErr()) {
      return response as BoxedResponse<EspoGetOutpointBalances, string>;
    }

    const items = response.data.items.map(
      (entry: EspoOutpointBalanceWithAddressRaw) =>
        this.normalizeOutpointBalanceWithAddress(entry)
    );

    const normalized: EspoGetOutpointBalances = {
      ...response.data,
      items,
    };

    return Ok<EspoGetOutpointBalances, string>(normalized);
  }

  public async getAddressOutpoints(
    address: string
  ): Promise<BoxedResponse<EspoGetAddressOutpoints, string>> {
    const response = await this.callAndUnbox<
      EspoGetAddressOutpointsRpcOk,
      EspoGetAddressOutpointsRpcResult
    >("essentials.get_address_outpoints", { address });

    if (response.isErr()) {
      return response as BoxedResponse<EspoGetAddressOutpoints, string>;
    }

    const outpoints = response.data.outpoints.map(
      (outpoint: EspoOutpointBalanceRaw) =>
        this.normalizeOutpointBalance(outpoint)
    );

    const normalized: EspoGetAddressOutpoints = {
      ...response.data,
      outpoints,
    };

    return Ok<EspoGetAddressOutpoints, string>(normalized);
  }

  public getCandles(
    pool: EspoAlkaneId,
    options: GetCandlesOptions = {}
  ): Promise<BoxedResponse<EspoGetCandles, string>> {
    const params: EspoGetCandlesParams = {
      pool,
      ...options,
    };

    return this.callAndUnbox<EspoGetCandlesOk, EspoGetCandlesResult>(
      "ammdata.get_candles",
      params
    );
  }

  public async getTrades(
    pool: EspoAlkaneId,
    options: GetTradesOptions = {}
  ): Promise<BoxedResponse<EspoGetTrades, string>> {
    const { filter_side, filterSide, ...rest } = options;
    const params: EspoGetTradesParams = {
      pool,
      ...rest,
    };

    const selectedFilterSide = filter_side ?? filterSide;
    if (selectedFilterSide !== undefined) {
      params.filter_side = selectedFilterSide;
    }

    const response = await this.callAndUnbox<
      EspoGetTradesRpcOk,
      EspoGetTradesRpcResult
    >("ammdata.get_trades", params);

    if (response.isErr()) {
      return response as BoxedResponse<EspoGetTrades, string>;
    }

    const trades = response.data.trades.map((trade: EspoTradeRaw) =>
      this.normalizeTrade(trade)
    );

    const normalized: EspoGetTrades = {
      ...response.data,
      trades,
    };

    return Ok<EspoGetTrades, string>(normalized);
  }

  public async getPools(
    options: GetPoolsOptions = {}
  ): Promise<BoxedResponse<EspoGetPools, string>> {
    const response = await this.callAndUnbox<
      EspoGetPoolsRpcOk,
      EspoGetPoolsRpcResult
    >("ammdata.get_pools", options);

    if (response.isErr()) {
      return response as BoxedResponse<EspoGetPools, string>;
    }

    const normalized: EspoGetPools = {
      ...response.data,
      pools: this.normalizePoolsRecord(response.data.pools),
    };

    return Ok<EspoGetPools, string>(normalized);
  }

  public async findBestSwapPath(
    tokenIn: EspoAlkaneId,
    tokenOut: EspoAlkaneId,
    options: FindBestSwapPathOptions = {}
  ): Promise<BoxedResponse<EspoFindBestSwapPath, string>> {
    const params: EspoFindBestSwapPathParams = {
      token_in: tokenIn,
      token_out: tokenOut,
    };

    if (options.mode) {
      params.mode = options.mode;
    }

    const amountIn = this.normalizeAmountLike(
      options.amount_in ?? options.amountIn
    );
    if (amountIn !== undefined) {
      params.amount_in = amountIn;
    }

    const amountOut = this.normalizeAmountLike(
      options.amount_out ?? options.amountOut
    );
    if (amountOut !== undefined) {
      params.amount_out = amountOut;
    }

    const amountOutMin = this.normalizeAmountLike(
      options.amount_out_min ?? options.amountOutMin
    );
    if (amountOutMin !== undefined) {
      params.amount_out_min = amountOutMin;
    }

    const amountInMax = this.normalizeAmountLike(
      options.amount_in_max ?? options.amountInMax
    );
    if (amountInMax !== undefined) {
      params.amount_in_max = amountInMax;
    }

    const availableIn = this.normalizeAmountLike(
      options.available_in ?? options.availableIn
    );
    if (availableIn !== undefined) {
      params.available_in = availableIn;
    }

    const feeBps = options.fee_bps ?? options.feeBps;
    if (feeBps !== undefined) {
      params.fee_bps = feeBps;
    }

    const maxHops = options.max_hops ?? options.maxHops;
    if (maxHops !== undefined) {
      params.max_hops = maxHops;
    }

    const response = await this.callAndUnbox<
      EspoFindBestSwapPathRpcOk,
      EspoFindBestSwapPathRpcResult
    >("ammdata.find_best_swap_path", params);

    if (response.isErr()) {
      return response as BoxedResponse<EspoFindBestSwapPath, string>;
    }

    const normalized: EspoFindBestSwapPath = {
      ...response.data,
      amount_in: this.toBigIntAmount(response.data.amount_in),
      amount_out: this.toBigIntAmount(response.data.amount_out),
      hops: response.data.hops.map((hop: EspoSwapHopRaw) =>
        this.normalizeSwapHop(hop)
      ),
    };

    return Ok<EspoFindBestSwapPath, string>(normalized);
  }

  public async getBestMevSwap(
    token: EspoAlkaneId,
    options: GetBestMevSwapOptions = {}
  ): Promise<BoxedResponse<EspoGetBestMevSwap, string>> {
    const params: EspoGetBestMevSwapParams = {
      token,
    };

    const feeBps = options.fee_bps ?? options.feeBps;
    if (feeBps !== undefined) {
      params.fee_bps = feeBps;
    }

    const maxHops = options.max_hops ?? options.maxHops;
    if (maxHops !== undefined) {
      params.max_hops = maxHops;
    }

    const response = await this.callAndUnbox<
      EspoGetBestMevSwapRpcOk,
      EspoGetBestMevSwapRpcResult
    >("ammdata.get_best_mev_swap", params);

    if (response.isErr()) {
      return response as BoxedResponse<EspoGetBestMevSwap, string>;
    }

    const normalized: EspoGetBestMevSwap = {
      ...response.data,
      amount_in: this.toBigIntAmount(response.data.amount_in),
      amount_out: this.toBigIntAmount(response.data.amount_out),
      profit: this.toBigIntAmount(response.data.profit),
      hops: response.data.hops.map((hop: EspoSwapHopRaw) =>
        this.normalizeSwapHop(hop)
      ),
    };

    return Ok<EspoGetBestMevSwap, string>(normalized);
  }
}
