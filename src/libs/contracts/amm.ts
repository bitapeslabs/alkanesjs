/*
  Oyl AMM — factory (the router) and pool contracts.

  Factory opcodes:
    2   FindExistingPoolId { alkane_a, alkane_b }  -> pool AlkaneId (block||tx, LE u128 each)
    3   GetAllPools                                -> count, then count * (block||tx)
    4   GetNumPools                                -> u128
    13  SwapExactTokensForTokens { path, amount_in, amount_out_min, deadline }
    14  SwapTokensForExactTokens { path, amount_out, amount_in_max, deadline }
    29  SwapExactTokensForTokensImplicit { path, amount_out_min, deadline }

  Pool opcodes:
    20  GetTotalFee   -> u128, fee per 1000 (default 10 == 1.0%), per-pool overridable
    97  GetReserves   -> reserve_0 || reserve_1, in SORTED token order
    999 PoolDetails   -> token_a, token_b, reserve_a, reserve_b, total_supply, pool_name

  Pool ids are sequence-assigned, NOT derivable: always go through opcode 2.
  The lookup is order-insensitive (the contract sorts the pair itself).
*/

import {
  BoxedError,
  BoxedSuccess,
  type BoxedResponse,
  isBoxedError,
} from "@/boxed";
import type { AlkaneId } from "@/apis";
import type { Provider } from "@/provider";
import { abi } from "../interfaces/builder";
import { AlkanesBaseContract, AlkanesSimulationError } from "../interfaces/base";
import { DecodableAlkanesResponse } from "../decoders";
import {
  alkaneIdsEqual,
  decodeAlkaneIdVec,
  encodeAlkaneIdVec,
  readU128LE,
  sortAlkaneIds,
} from "./alkane-id";

export const AMM_FACTORY_OPCODES = {
  findExistingPoolId: 2n,
  getAllPools: 3n,
  getNumPools: 4n,
  swapExactTokensForTokens: 13n,
  swapTokensForExactTokens: 14n,
  swapExactTokensForTokensImplicit: 29n,
} as const;

export const AMM_POOL_OPCODES = {
  getTotalFee: 20n,
  getReserves: 97n,
  poolDetails: 999n,
} as const;

/** Pool fee per 1000 assumed when opcode 20 is unavailable. 10 == 1.0%. */
export const DEFAULT_POOL_FEE_PER_1000 = 10n;

/*──────────────────────────── pure calldata encoders ────────────────────────*/

export interface SwapImplicitArgs {
  /**
   * The REMAINING hops only. Opcode 29 infers both the input token and the
   * input amount from the alkane attached to the protostone, and prepends that
   * id itself, so a single hop A -> B carries just `[B]`.
   */
  path: AlkaneId[];
  amountOutMin: bigint;
  /** BLOCK HEIGHT, not a timestamp. 0 means "no deadline". */
  deadline: bigint;
}

/** `[29, ...Vec<AlkaneId>, amount_out_min, deadline]` — no contract prefix. */
export function encodeSwapImplicitCallData({
  path,
  amountOutMin,
  deadline,
}: SwapImplicitArgs): bigint[] {
  return [
    AMM_FACTORY_OPCODES.swapExactTokensForTokensImplicit,
    ...encodeAlkaneIdVec(path),
    amountOutMin,
    deadline,
  ];
}

/**
 * The full protostone calldata for an implicit swap:
 * `[factory.block, factory.tx, 29, ...Vec<AlkaneId>, amount_out_min, deadline]`.
 *
 * The `[block, tx]` target prefix mirrors what `AlkanesBaseContract.pushExecute`
 * prepends before handing calldata to `addProtostoneData`.
 */
export function buildSwapCallData(
  factoryId: AlkaneId,
  args: SwapImplicitArgs,
): bigint[] {
  return [factoryId.block, factoryId.tx, ...encodeSwapImplicitCallData(args)];
}

export interface SwapExactInArgs {
  /**
   * The FULL path, INCLUDING the input token (opcode 13 reads the input token
   * out of `path[0]`), e.g. a two-hop A -> B -> C carries `[A, B, C]`.
   */
  path: AlkaneId[];
  /** the exact amount of `path[0]` to spend (must equal what is attached) */
  amountIn: bigint;
  /** the slippage floor on `path[path.length - 1]` */
  amountOutMin: bigint;
  /** BLOCK HEIGHT, not a timestamp. 0 means "no deadline". */
  deadline: bigint;
}

/** `[13, ...Vec<AlkaneId>, amount_in, amount_out_min, deadline]` — no prefix. */
export function encodeSwapExactInCallData({
  path,
  amountIn,
  amountOutMin,
  deadline,
}: SwapExactInArgs): bigint[] {
  return [
    AMM_FACTORY_OPCODES.swapExactTokensForTokens,
    ...encodeAlkaneIdVec(path),
    amountIn,
    amountOutMin,
    deadline,
  ];
}

/**
 * The full protostone calldata for an explicit exact-in swap:
 * `[factory.block, factory.tx, 13, ...Vec<AlkaneId>, amount_in,
 * amount_out_min, deadline]`.
 */
export function buildSwapExactInCallData(
  factoryId: AlkaneId,
  args: SwapExactInArgs,
): bigint[] {
  return [factoryId.block, factoryId.tx, ...encodeSwapExactInCallData(args)];
}

export interface SwapExactOutArgs {
  /**
   * The FULL path, INCLUDING the input token. Unlike opcode 29 (which infers
   * the input id from the attached alkane and therefore names only the
   * remaining hops), opcodes 13/14 read the input token out of `path[0]`, so a
   * single hop A -> B carries `[A, B]`.
   */
  path: AlkaneId[];
  /** the EXACT amount of `path[path.length - 1]` the caller wants back */
  amountOut: bigint;
  /**
   * The ceiling on what may be consumed of `path[0]`. The call reverts with
   * `EXCESSIVE_INPUT_AMOUNT` when the computed input exceeds it, so this is
   * also the amount to ATTACH: the factory's `_return_leftovers` sweeps the
   * unspent remainder back to the caller.
   */
  amountInMax: bigint;
  /** BLOCK HEIGHT, not a timestamp. 0 means "no deadline". */
  deadline: bigint;
}

/** `[14, ...Vec<AlkaneId>, amount_out, amount_in_max, deadline]` — no prefix. */
export function encodeSwapExactOutCallData({
  path,
  amountOut,
  amountInMax,
  deadline,
}: SwapExactOutArgs): bigint[] {
  return [
    AMM_FACTORY_OPCODES.swapTokensForExactTokens,
    ...encodeAlkaneIdVec(path),
    amountOut,
    amountInMax,
    deadline,
  ];
}

/**
 * The full protostone calldata for an exact-output swap:
 * `[factory.block, factory.tx, 14, ...Vec<AlkaneId>, amount_out, amount_in_max,
 * deadline]`.
 */
export function buildSwapExactOutCallData(
  factoryId: AlkaneId,
  args: SwapExactOutArgs,
): bigint[] {
  return [factoryId.block, factoryId.tx, ...encodeSwapExactOutCallData(args)];
}

/*──────────────────────────────── ABI classes ───────────────────────────────*/

const cannotSign = async (): Promise<string> => {
  throw new Error("AMM contract handle is read-only and cannot sign a psbt");
};

export const AmmFactoryABI = abi.contract({
  getAllPools: abi
    .opcode(AMM_FACTORY_OPCODES.getAllPools)
    .view()
    .returns("bigintArray"),

  getNumPools: abi
    .opcode(AMM_FACTORY_OPCODES.getNumPools)
    .view()
    .returns("bigint"),

  /*
    A 4-word input (a.block, a.tx, b.block, b.tx) is not expressible through
    the builder's single-value encoders, so this one drops to `custom`.
  */
  findExistingPoolId: abi
    .opcode(AMM_FACTORY_OPCODES.findExistingPoolId)
    .custom(async function (
      this: AlkanesBaseContract,
      opcode,
      params: { a: AlkaneId; b: AlkaneId },
    ) {
      const simulated = await this.simulate({
        callData: [
          opcode,
          params.a.block,
          params.a.tx,
          params.b.block,
          params.b.tx,
        ],
      });
      if (isBoxedError(simulated)) {
        return new BoxedError(simulated.message ?? "find_existing_pool_id failed", AlkanesSimulationError.UnknownError);
      }
      const words = new DecodableAlkanesResponse(simulated.data).decodeTo(
        "bigintArray",
      );
      return new BoxedSuccess(decodePoolIdWords(words));
    }),
});

export class AmmFactoryContract extends abi.attach(
  AlkanesBaseContract,
  AmmFactoryABI,
) {}

export const ammFactoryContract = (
  provider: Provider,
  factoryId: AlkaneId,
): AmmFactoryContract => new AmmFactoryContract(provider, factoryId, cannotSign);

export const AmmPoolABI = abi.contract({
  /** fee per 1000 — 10 == 1.0% */
  getTotalFee: abi
    .opcode(AMM_POOL_OPCODES.getTotalFee)
    .view()
    .returns("bigint"),

  /** `[reserve_0, reserve_1]` in SORTED token order, not the caller's order */
  getReserves: abi
    .opcode(AMM_POOL_OPCODES.getReserves)
    .view()
    .returns("bigintArray"),

  /** raw PoolDetails bytes; run them through `decodePoolDetails` */
  getPoolDetailsRaw: abi
    .opcode(AMM_POOL_OPCODES.poolDetails)
    .view()
    .returns("uint8Array"),
});

export class AmmPoolContract extends abi.attach(
  AlkanesBaseContract,
  AmmPoolABI,
) {}

export const ammPoolContract = (
  provider: Provider,
  poolId: AlkaneId,
): AmmPoolContract => new AmmPoolContract(provider, poolId, cannotSign);

/*───────────────────────────── decode helpers ───────────────────────────────*/

const ZERO_ID: AlkaneId = { block: 0n, tx: 0n };

/** `[block, tx]` LE u128 words -> AlkaneId, or null when the pool is absent. */
export function decodePoolIdWords(words: bigint[]): AlkaneId | null {
  if (words.length < 2) return null;
  const id = { block: words[0], tx: words[1] };
  return alkaneIdsEqual(id, ZERO_ID) ? null : id;
}

export interface PoolDetails {
  tokenA: AlkaneId;
  tokenB: AlkaneId;
  reserveA: bigint;
  reserveB: bigint;
  totalSupply: bigint;
  poolName: string;
}

/** utf8 tail with control bytes dropped (the name may be length prefixed). */
function sanitiseName(bytes: Uint8Array): string {
  const printable = Array.from(bytes).filter((b) => b >= 0x20 && b !== 0x7f);
  return new TextDecoder().decode(Uint8Array.from(printable)).trim();
}

/*
  PoolDetails layout as understood:
    token_a.block  u128 LE   offset 0
    token_a.tx     u128 LE   offset 16
    token_b.block  u128 LE   offset 32
    token_b.tx     u128 LE   offset 48
    reserve_a      u128 LE   offset 64
    reserve_b      u128 LE   offset 80
    total_supply   u128 LE   offset 96
    pool_name      utf8      offset 112..

  The name tail is the least certain part (it may or may not be length
  prefixed), so it is sanitised rather than trusted, and the numeric prefix is
  sanity checked. Callers that cannot tolerate a misparse should go through
  `getPoolState`, which validates this and falls back to opcode 97.
*/
export const POOL_DETAILS_FIXED_LENGTH = 112;

export function decodePoolDetails(bytes: Uint8Array): PoolDetails | null {
  if (bytes.length < POOL_DETAILS_FIXED_LENGTH) return null;

  const details: PoolDetails = {
    tokenA: { block: readU128LE(bytes, 0), tx: readU128LE(bytes, 16) },
    tokenB: { block: readU128LE(bytes, 32), tx: readU128LE(bytes, 48) },
    reserveA: readU128LE(bytes, 64),
    reserveB: readU128LE(bytes, 80),
    totalSupply: readU128LE(bytes, 96),
    poolName: sanitiseName(bytes.subarray(POOL_DETAILS_FIXED_LENGTH)),
  };

  /*
    An alkane's block is always a small protocol constant (2, 4, 32, …). A
    parse that lands a giant value there means the layout guess was wrong.
  */
  const plausibleBlock = (id: AlkaneId) =>
    id.block > 0n && id.block <= 0xffff_ffffn;

  if (!plausibleBlock(details.tokenA) || !plausibleBlock(details.tokenB)) {
    return null;
  }
  if (alkaneIdsEqual(details.tokenA, details.tokenB)) return null;

  return details;
}

/*──────────────────────────────── lookups ───────────────────────────────────*/

/**
 * The pool id for a pair, or `null` when no pool exists. Order-insensitive.
 * Pool ids are sequence-assigned by the factory and cannot be derived.
 */
export async function findPoolId(
  provider: Provider,
  factoryId: AlkaneId,
  a: AlkaneId,
  b: AlkaneId,
): Promise<BoxedResponse<AlkaneId | null, string>> {
  const simulated = await provider.simulate({
    target: factoryId,
    callData: [
      AMM_FACTORY_OPCODES.findExistingPoolId,
      a.block,
      a.tx,
      b.block,
      b.tx,
    ],
  });

  if (isBoxedError(simulated)) {
    /*
      A missing pool may surface either as a zeroed id or as a revert,
      depending on the factory build. Both mean "no pool", not "broken rpc".
    */
    if (simulated.errorType === AlkanesSimulationError.TransactionReverted) {
      return new BoxedSuccess(null);
    }
    return new BoxedError(`find_existing_pool_id failed: ${simulated.message ?? simulated.errorType}`, "AmmLookupError");
  }

  try {
    const words = new DecodableAlkanesResponse(simulated.data).decodeTo(
      "bigintArray",
    );
    return new BoxedSuccess(decodePoolIdWords(words));
  } catch (err) {
    return new BoxedError(`Could not decode the pool id: ${(err as Error).message}`, "AmmLookupError");
  }
}

/** Every pool the factory knows about. */
export async function getAllPoolIds(
  provider: Provider,
  factoryId: AlkaneId,
): Promise<BoxedResponse<AlkaneId[], string>> {
  const simulated = await provider.simulate({
    target: factoryId,
    callData: [AMM_FACTORY_OPCODES.getAllPools],
  });
  if (isBoxedError(simulated)) {
    return new BoxedError(`get_all_pools failed: ${simulated.message ?? simulated.errorType}`, "AmmLookupError");
  }

  try {
    const words = new DecodableAlkanesResponse(simulated.data).decodeTo(
      "bigintArray",
    );
    return new BoxedSuccess(decodeAlkaneIdVec(words));
  } catch (err) {
    return new BoxedError(`Could not decode the pool list: ${(err as Error).message}`, "AmmLookupError");
  }
}

export interface PoolState {
  token0: AlkaneId;
  token1: AlkaneId;
  reserve0: bigint;
  reserve1: bigint;
  /** fee per 1000, straight from opcode 20 (default 10 == 1.0%) */
  feePer1000: bigint;
}

/** Opcode 20, falling back to the 1.0% default when the pool predates it. */
export async function getPoolFeePer1000(
  provider: Provider,
  poolId: AlkaneId,
): Promise<bigint> {
  const simulated = await provider.simulate({
    target: poolId,
    callData: [AMM_POOL_OPCODES.getTotalFee],
  });
  if (isBoxedError(simulated)) return DEFAULT_POOL_FEE_PER_1000;

  try {
    const fee = new DecodableAlkanesResponse(simulated.data).decodeTo("bigint");
    return fee > 0n && fee < 1000n ? fee : DEFAULT_POOL_FEE_PER_1000;
  } catch {
    return DEFAULT_POOL_FEE_PER_1000;
  }
}

/**
 * The pool's live token order, reserves and fee.
 *
 * Which reserve is "in" and which is "out" MUST come from this LIVE ordering,
 * never from whatever order the caller happens to hold the pair in: getting it
 * backwards silently produces near-zero quotes instead of an error. Feed the
 * result to `orientPoolReserves`.
 *
 * Reads opcode 999 first (tokens and reserves in one call) and falls back to
 * opcode 97, which returns reserves in SORTED token order — that fallback
 * needs `tokensHint` to know which two tokens the pool holds.
 */
export async function getPoolState(
  provider: Provider,
  poolId: AlkaneId,
  tokensHint?: [AlkaneId, AlkaneId],
): Promise<BoxedResponse<PoolState, string>> {
  const feePer1000 = await getPoolFeePer1000(provider, poolId);

  const detailsSim = await provider.simulate({
    target: poolId,
    callData: [AMM_POOL_OPCODES.poolDetails],
  });

  if (!isBoxedError(detailsSim)) {
    try {
      const bytes = new DecodableAlkanesResponse(detailsSim.data).decodeTo(
        "uint8Array",
      );
      const details = decodePoolDetails(bytes);
      if (details) {
        return new BoxedSuccess({
          token0: details.tokenA,
          token1: details.tokenB,
          reserve0: details.reserveA,
          reserve1: details.reserveB,
          feePer1000,
        });
      }
    } catch {
      //fall through to the reserves-only path
    }
  }

  const reservesSim = await provider.simulate({
    target: poolId,
    callData: [AMM_POOL_OPCODES.getReserves],
  });
  if (isBoxedError(reservesSim)) {
    return new BoxedError(`Neither pool_details (999) nor get_reserves (97) could be read for pool ${poolId.block}:${poolId.tx}`, "AmmLookupError");
  }

  if (!tokensHint) {
    return new BoxedError("pool_details (999) was unreadable and no token hint was supplied, so the reserve order cannot be resolved", "AmmLookupError");
  }

  try {
    const words = new DecodableAlkanesResponse(reservesSim.data).decodeTo(
      "bigintArray",
    );
    if (words.length < 2) {
      return new BoxedError("get_reserves returned no reserves", "AmmLookupError");
    }
    const [token0, token1] = sortAlkaneIds(tokensHint[0], tokensHint[1]);
    return new BoxedSuccess({
      token0,
      token1,
      reserve0: words[0],
      reserve1: words[1],
      feePer1000,
    });
  } catch (err) {
    return new BoxedError(`Could not decode the reserves: ${(err as Error).message}`, "AmmLookupError");
  }
}

/**
 * PURE. Map a pool's `(token0, reserve0, token1, reserve1)` onto the in/out
 * sides of a trade. Returns null when `sellId` is not one of the pool's tokens.
 */
export function orientPoolReserves(
  state: PoolState,
  sellId: AlkaneId,
): { reserveIn: bigint; reserveOut: bigint; buyId: AlkaneId } | null {
  if (alkaneIdsEqual(state.token0, sellId)) {
    return {
      reserveIn: state.reserve0,
      reserveOut: state.reserve1,
      buyId: state.token1,
    };
  }
  if (alkaneIdsEqual(state.token1, sellId)) {
    return {
      reserveIn: state.reserve1,
      reserveOut: state.reserve0,
      buyId: state.token0,
    };
  }
  return null;
}
