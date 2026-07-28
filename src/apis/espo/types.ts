export type EspoAlkaneId = string;
export type EspoOutpoint = string;
export type EspoAmountString = string;

export interface EspoOkResult {
  ok: true;
}

export interface EspoErrorResult {
  ok: false;
  error: string;
  hint?: string;
}

/* -------------------------------------------------------------------------- */
/* Essentials module                                                          */
/* -------------------------------------------------------------------------- */

export interface EspoKeyValueItemRaw {
  key_hex: string;
  key_str: string | null;
  value_hex: string;
  value_str: string | null;
  value_u128: EspoAmountString | null;
  last_txid: string | null;
}

export interface EspoKeyValueItem {
  key_hex: string;
  key_str: string | null;
  value_hex: string;
  value_str: string | null;
  value_u128: bigint | null;
  last_txid: string | null;
}

export interface EspoGetKeysParams {
  alkane: EspoAlkaneId;
  try_decode_utf8?: boolean;
  keys?: string[];
  limit?: number;
  page?: number;
}

export interface EspoGetKeysOk extends EspoOkResult {
  alkane: EspoAlkaneId;
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  items: Record<string, EspoKeyValueItem>;
}
export type EspoGetKeys = DeepExpand<UnwrapEspoResult<EspoGetKeysOk>>;

export interface EspoGetKeysRpcOk extends EspoOkResult {
  alkane: EspoAlkaneId;
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  items: Record<string, EspoKeyValueItemRaw>;
}
export type EspoGetKeysResult = EspoGetKeysOk | EspoErrorResult;
export type EspoGetKeysRpcResult = EspoGetKeysRpcOk | EspoErrorResult;

export interface EspoHolderRaw {
  address: string;
  amount: EspoAmountString;
}

export interface EspoHolder {
  address: string;
  amount: number;
}

export interface EspoGetHoldersParams {
  alkane: EspoAlkaneId;
  limit?: number;
  page?: number;
}

export interface EspoGetHoldersOk extends EspoOkResult {
  alkane: EspoAlkaneId;
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  items: EspoHolder[];
}
export type EspoGetHolders = DeepExpand<UnwrapEspoResult<EspoGetHoldersOk>>;

export interface EspoGetHoldersRpcOk extends EspoOkResult {
  alkane: EspoAlkaneId;
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  items: EspoHolderRaw[];
}

export type EspoGetHoldersResult = EspoGetHoldersOk | EspoErrorResult;
export type EspoGetHoldersRpcResult = EspoGetHoldersRpcOk | EspoErrorResult;

export interface EspoBalanceEntryRaw {
  alkane: EspoAlkaneId;
  amount: EspoAmountString;
}

export interface EspoBalanceEntry {
  alkane: EspoAlkaneId;
  amount: number;
}

export interface EspoOutpointBalanceRaw {
  outpoint: EspoOutpoint;
  entries: EspoBalanceEntryRaw[];
}

export interface EspoOutpointBalance {
  outpoint: EspoOutpoint;
  entries: EspoBalanceEntry[];
}

export interface EspoOutpointBalanceWithAddressRaw
  extends EspoOutpointBalanceRaw {
  address?: string;
}

export interface EspoOutpointBalanceWithAddress extends EspoOutpointBalance {
  address?: string;
}

export interface EspoGetAddressBalancesParams {
  address: string;
  include_outpoints?: boolean;
}

export interface EspoGetAddressBalancesOk extends EspoOkResult {
  address: string;
  balances: Record<EspoAlkaneId, number>;
  outpoints?: EspoOutpointBalance[];
}
export type EspoGetAddressBalances = DeepExpand<
  UnwrapEspoResult<EspoGetAddressBalancesOk>
>;

export interface EspoGetAddressBalancesRpcOk extends EspoOkResult {
  address: string;
  balances: Record<EspoAlkaneId, EspoAmountString>;
  outpoints?: EspoOutpointBalanceRaw[];
}

export type EspoGetAddressBalancesResult =
  | EspoGetAddressBalancesOk
  | EspoErrorResult;
export type EspoGetAddressBalancesRpcResult =
  | EspoGetAddressBalancesRpcOk
  | EspoErrorResult;

export interface EspoGetOutpointBalancesParams {
  outpoint: EspoOutpoint;
}

export interface EspoGetOutpointBalancesOk extends EspoOkResult {
  outpoint: EspoOutpoint;
  items: EspoOutpointBalanceWithAddress[];
}
export type EspoGetOutpointBalances = DeepExpand<
  UnwrapEspoResult<EspoGetOutpointBalancesOk>
>;

export interface EspoGetOutpointBalancesRpcOk extends EspoOkResult {
  outpoint: EspoOutpoint;
  items: EspoOutpointBalanceWithAddressRaw[];
}

export type EspoGetOutpointBalancesResult =
  | EspoGetOutpointBalancesOk
  | EspoErrorResult;
export type EspoGetOutpointBalancesRpcResult =
  | EspoGetOutpointBalancesRpcOk
  | EspoErrorResult;

export interface EspoGetHoldersCountParams {
  alkane: EspoAlkaneId;
}

export interface EspoGetHoldersCountOk extends EspoOkResult {
  count: number;
}
export type EspoGetHoldersCount = DeepExpand<
  UnwrapEspoResult<EspoGetHoldersCountOk>
>;

export type EspoGetHoldersCountResult = EspoGetHoldersCountOk | EspoErrorResult;

export interface EspoGetAddressOutpointsParams {
  address: string;
}

export interface EspoGetAddressOutpointsOk extends EspoOkResult {
  address: string;
  outpoints: EspoOutpointBalance[];
}
export type EspoGetAddressOutpoints = DeepExpand<
  UnwrapEspoResult<EspoGetAddressOutpointsOk>
>;

export interface EspoGetAddressOutpointsRpcOk extends EspoOkResult {
  address: string;
  outpoints: EspoOutpointBalanceRaw[];
}

export type EspoGetAddressOutpointsResult =
  | EspoGetAddressOutpointsOk
  | EspoErrorResult;
export type EspoGetAddressOutpointsRpcResult =
  | EspoGetAddressOutpointsRpcOk
  | EspoErrorResult;

export interface EspoGetAddressSpendableOutpointsParams {
  address: string;
  omit_raw_tx?: boolean;
}

export interface EspoSpendableOutpointAlkane {
  alkane: EspoAlkaneId;
  amount: EspoAmountString;
}

export interface EspoSpendableOutpointRune {
  id: string;
  rune: string;
  amount: EspoAmountString;
}

export interface EspoSpendableOutpoint {
  outpoint: EspoOutpoint;
  value: number;
  script_pubkey_hex: string;
  block_height: number | null;
  confirmations: number;
  coinbase: boolean;
  alkanes: EspoSpendableOutpointAlkane[];
  runes: EspoSpendableOutpointRune[];
  raw_tx_hex: string;
}

export interface EspoGetAddressSpendableOutpointsOk extends EspoOkResult {
  address: string;
  height: number;
  length: number;
  outpoints: EspoSpendableOutpoint[];
}
export type EspoGetAddressSpendableOutpoints = DeepExpand<
  UnwrapEspoResult<EspoGetAddressSpendableOutpointsOk>
>;

export type EspoGetAddressSpendableOutpointsResult =
  | EspoGetAddressSpendableOutpointsOk
  | EspoErrorResult;

export type EspoEssentialsPingResult = "pong";

/* -------------------------------------------------------------------------- */
/* AMMDATA module                                                             */
/* -------------------------------------------------------------------------- */

export interface EspoCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EspoGetCandlesParams {
  pool: EspoAlkaneId;
  timeframe?:
    | "10m"
    | "1h"
    | "1d"
    | "1w"
    | "1M"
    | "m10"
    | "h1"
    | "d1"
    | "w1"
    | "m1";
  side?: "base" | "quote";
  limit?: number;
  size?: number;
  page?: number;
  now?: number;
}

export interface EspoGetCandlesOk extends EspoOkResult {
  pool: EspoAlkaneId;
  timeframe: string;
  side: "base" | "quote";
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  candles: EspoCandle[];
}
export type EspoGetCandles = DeepExpand<UnwrapEspoResult<EspoGetCandlesOk>>;

export type EspoGetCandlesResult = EspoGetCandlesOk | EspoErrorResult;

export type EspoTradeSide = "buy" | "sell" | "neutral";

export interface EspoTradeRaw {
  timestamp: number;
  txid: string;
  address: string;
  xpubkey: string;
  base_inflow: EspoAmountString;
  quote_inflow: EspoAmountString;
  side: EspoTradeSide;
  amount: number;
}

export interface EspoTrade {
  timestamp: number;
  txid: string;
  address: string;
  xpubkey: Uint8Array;
  base_inflow: bigint;
  quote_inflow: bigint;
  side: EspoTradeSide;
  amount: number;
}

export interface EspoGetTradesParams {
  pool: EspoAlkaneId;
  limit?: number;
  page?: number;
  side?: "base" | "quote";
  filter_side?: "buy" | "sell" | "all" | "a" | "b" | "s";
  sort?: string;
  dir?: "asc" | "desc" | "ascending" | "descending";
  direction?: "asc" | "desc" | "ascending" | "descending";
}

export interface EspoGetTradesOk extends EspoOkResult {
  pool: EspoAlkaneId;
  side: "base" | "quote";
  filter_side: "all" | "buy" | "sell";
  sort: string;
  dir: "asc" | "desc";
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  trades: EspoTrade[];
}
export type EspoGetTrades = DeepExpand<UnwrapEspoResult<EspoGetTradesOk>>;

export interface EspoGetTradesRpcOk extends EspoOkResult {
  pool: EspoAlkaneId;
  side: "base" | "quote";
  filter_side: "all" | "buy" | "sell";
  sort: string;
  dir: "asc" | "desc";
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  trades: EspoTradeRaw[];
}

export type EspoGetTradesResult = EspoGetTradesOk | EspoErrorResult;
export type EspoGetTradesRpcResult = EspoGetTradesRpcOk | EspoErrorResult;

export interface EspoPoolRaw {
  base: EspoAlkaneId;
  quote: EspoAlkaneId;
  base_reserve: EspoAmountString;
  quote_reserve: EspoAmountString;
  source: "live";
}

export interface EspoPool {
  base: EspoAlkaneId;
  quote: EspoAlkaneId;
  base_reserve: bigint;
  quote_reserve: bigint;
  source: "live";
}

export interface EspoGetPoolsParams {
  limit?: number;
  page?: number;
}

export interface EspoGetPoolsOk extends EspoOkResult {
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  pools: Record<EspoAlkaneId, EspoPool>;
}
export type EspoGetPools = DeepExpand<UnwrapEspoResult<EspoGetPoolsOk>>;

export interface EspoGetPoolsRpcOk extends EspoOkResult {
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  pools: Record<EspoAlkaneId, EspoPoolRaw>;
}

export type EspoGetPoolsResult = EspoGetPoolsOk | EspoErrorResult;
export type EspoGetPoolsRpcResult = EspoGetPoolsRpcOk | EspoErrorResult;

export interface EspoSwapHopRaw {
  pool: EspoAlkaneId;
  token_in: EspoAlkaneId;
  token_out: EspoAlkaneId;
  amount_in: EspoAmountString;
  amount_out: EspoAmountString;
}

export interface EspoSwapHop {
  pool: EspoAlkaneId;
  token_in: EspoAlkaneId;
  token_out: EspoAlkaneId;
  amount_in: bigint;
  amount_out: bigint;
}

export interface EspoFindBestSwapPathParams {
  mode?: "exact_in" | "exact_out" | "implicit";
  token_in: EspoAlkaneId;
  token_out: EspoAlkaneId;
  amount_in?: EspoAmountString | number;
  amount_out_min?: EspoAmountString | number;
  amount_out?: EspoAmountString | number;
  amount_in_max?: EspoAmountString | number;
  available_in?: EspoAmountString | number;
  fee_bps?: number;
  max_hops?: number;
}

export interface EspoFindBestSwapPathOk extends EspoOkResult {
  mode: string;
  token_in: EspoAlkaneId;
  token_out: EspoAlkaneId;
  fee_bps: number;
  max_hops: number;
  amount_in: bigint;
  amount_out: bigint;
  hops: EspoSwapHop[];
}
export type EspoFindBestSwapPath = DeepExpand<
  UnwrapEspoResult<EspoFindBestSwapPathOk>
>;

export interface EspoFindBestSwapPathRpcOk extends EspoOkResult {
  mode: string;
  token_in: EspoAlkaneId;
  token_out: EspoAlkaneId;
  fee_bps: number;
  max_hops: number;
  amount_in: EspoAmountString;
  amount_out: EspoAmountString;
  hops: EspoSwapHopRaw[];
}

export type EspoFindBestSwapPathResult =
  | EspoFindBestSwapPathOk
  | EspoErrorResult;
export type EspoFindBestSwapPathRpcResult =
  | EspoFindBestSwapPathRpcOk
  | EspoErrorResult;

export interface EspoGetBestMevSwapParams {
  token: EspoAlkaneId;
  fee_bps?: number;
  max_hops?: number;
}

export interface EspoGetBestMevSwapOk extends EspoOkResult {
  token: EspoAlkaneId;
  fee_bps: number;
  max_hops: number;
  amount_in: bigint;
  amount_out: bigint;
  profit: bigint;
  hops: EspoSwapHop[];
}
export type EspoGetBestMevSwap = DeepExpand<
  UnwrapEspoResult<EspoGetBestMevSwapOk>
>;

export interface EspoGetBestMevSwapRpcOk extends EspoOkResult {
  token: EspoAlkaneId;
  fee_bps: number;
  max_hops: number;
  amount_in: EspoAmountString;
  amount_out: EspoAmountString;
  profit: EspoAmountString;
  hops: EspoSwapHopRaw[];
}

export type EspoGetBestMevSwapResult = EspoGetBestMevSwapOk | EspoErrorResult;
export type EspoGetBestMevSwapRpcResult =
  | EspoGetBestMevSwapRpcOk
  | EspoErrorResult;

export type EspoAmmdataPingResult = "pong";

/* -------------------------------------------------------------------------- */
/* Root RPC method                                                            */
/* -------------------------------------------------------------------------- */

export interface EspoTipHeight {
  height: number;
}

/* -------------------------------------------------------------------------- */
/* Method map                                                                 */
/* -------------------------------------------------------------------------- */

export interface EspoRpcMethods {
  get_espo_height: {
    params?: Record<string, never>;
    result: EspoTipHeight;
  };

  "essentials.get_keys": {
    params: EspoGetKeysParams;
    result: EspoGetKeysRpcResult;
  };
  "essentials.get_holders": {
    params: EspoGetHoldersParams;
    result: EspoGetHoldersRpcResult;
  };
  "essentials.get_address_balances": {
    params: EspoGetAddressBalancesParams;
    result: EspoGetAddressBalancesRpcResult;
  };
  "essentials.get_outpoint_balances": {
    params: EspoGetOutpointBalancesParams;
    result: EspoGetOutpointBalancesRpcResult;
  };
  "essentials.get_holders_count": {
    params: EspoGetHoldersCountParams;
    result: EspoGetHoldersCountResult;
  };
  "essentials.get_address_outpoints": {
    params: EspoGetAddressOutpointsParams;
    result: EspoGetAddressOutpointsRpcResult;
  };
  "essentials.get_address_spendable_outpoints": {
    params: EspoGetAddressSpendableOutpointsParams;
    result: EspoGetAddressSpendableOutpointsResult;
  };
  "essentials.ping": {
    params?: Record<string, never>;
    result: EspoEssentialsPingResult;
  };

  "ammdata.get_candles": {
    params: EspoGetCandlesParams;
    result: EspoGetCandlesResult;
  };
  "ammdata.get_trades": {
    params: EspoGetTradesParams;
    result: EspoGetTradesRpcResult;
  };
  "ammdata.get_pools": {
    params: EspoGetPoolsParams;
    result: EspoGetPoolsRpcResult;
  };
  "ammdata.find_best_swap_path": {
    params: EspoFindBestSwapPathParams;
    result: EspoFindBestSwapPathRpcResult;
  };
  "ammdata.get_best_mev_swap": {
    params: EspoGetBestMevSwapParams;
    result: EspoGetBestMevSwapRpcResult;
  };
  "ammdata.ping": {
    params?: Record<string, never>;
    result: EspoAmmdataPingResult;
  };
}
type Keys = readonly PropertyKey[];

export type Strip<T, K extends Keys> = Omit<T, Extract<K[number], keyof T>>;
// convenience aliases for your two cases
/* -------------------------------------------------------------------------- */
/* Subfrost module                                                            */
/* -------------------------------------------------------------------------- */

export interface EspoGetSubfrostSignerOk extends EspoOkResult {
  /** The alkane whose storage holds the signer (frBTC, "32:0"). */
  alkane: EspoAlkaneId;
  storage_key: string;
  /** 0x-prefixed P2TR script_pubkey hex. */
  script_pubkey: string;
  address: string;
}

export type EspoGetSubfrostSignerResult =
  | EspoGetSubfrostSignerOk
  | EspoErrorResult;

export type EspoGetSubfrostSigner = DeepExpand<
  UnwrapEspoResult<EspoGetSubfrostSignerOk>
>;

export type UnwrapEspoResult<T> = Strip<T, ["ok", "error", "hint"]>;

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

export type DeepExpand<T> = T extends Primitive
  ? T
  : T extends Array<infer U>
  ? Array<DeepExpand<U>>
  : { [K in keyof T]: DeepExpand<T[K]> };

/* -------------------------------------------------------------------------- */
/* btc module — broadcast surface                                             */
/* -------------------------------------------------------------------------- */

/*
  `btc.submit_package` hands a set of raw transactions to Bitcoin Core's
  `submitpackage` — the way to broadcast a CPFP pair (commit + reveal, parent +
  child) atomically, so a parent paying under the mempool minimum still relays
  as long as the package rate clears it. The result is Core's own answer,
  passed through.
*/
export interface EspoSubmitPackageTxResult {
  txid: string;
  error?: string;
  vsize?: number;
  fees?: { base?: number; [k: string]: unknown };
  [k: string]: unknown;
}

export interface EspoSubmitPackageResult {
  package_msg: string;
  "tx-results"?: Record<string, EspoSubmitPackageTxResult>;
  "replaced-transactions"?: string[];
  [k: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Alkabi                                                                     */
/* -------------------------------------------------------------------------- */

export type EspoAlkabiFormat = "json" | "ts";

/** The self-describing ABI a contract embeds — see alkabi's DESIGN.md. */
export interface EspoAlkabiDocument {
  alkabi: number;
  contract: string;
  types: Record<string, unknown>;
  methods: {
    name: string;
    opcode: number;
    kind: string;
    [k: string]: unknown;
  }[];
  [k: string]: unknown;
}

export interface EspoGetAlkabiOk extends EspoOkResult {
  alkane: EspoAlkaneId;
  format: EspoAlkabiFormat;
  /** The document for `format: "json"`, the rendered module for `"ts"`. */
  abi: EspoAlkabiDocument | string;
}

export type EspoGetAlkabiResult = EspoGetAlkabiOk | EspoErrorResult;

// no DeepExpand: it widens the document's `unknown` members into `{}`
export type EspoGetAlkabi = UnwrapEspoResult<EspoGetAlkabiOk>;

/* -------------------------------------------------------------------------- */
/* Transaction traces                                                         */
/* -------------------------------------------------------------------------- */

/** One protostone event exactly as espo indexed it — values still 0x hex. */
export interface EspoTraceEvent {
  event: "create" | "invoke" | "return" | (string & {});
  data: unknown;
}

export interface EspoTransactionTrace {
  /** `txid:vout` — the shadow vout the indexer filed the trace under. */
  outpoint: string;
  events: EspoTraceEvent[];
}

export interface EspoGetAlkaneTxSummaryOk extends EspoOkResult {
  txid: string;
  height: number;
  traces: EspoTransactionTrace[];
}

export type EspoGetAlkaneTxSummaryResult =
  | EspoGetAlkaneTxSummaryOk
  | EspoErrorResult;

export type EspoGetAlkaneTxSummary = UnwrapEspoResult<EspoGetAlkaneTxSummaryOk>;
