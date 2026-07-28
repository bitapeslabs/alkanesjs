import {
  BoxedError,
  BoxedSuccess,
  BoxedResponse,
  consumeOrThrow,
  isBoxedError,
  consumeAll,
} from "@/boxed";
import { Provider } from "@/provider";

import { RpcCall, RpcResponse, RpcTuple } from "./shared";

import { ElectrumApiProvider } from "../esplora";

import { OrdRpcProvider } from "../ord";

import { AlkanesRpcProvider } from "../alkanes";

import {
  EsploraUtxo,
  IEsploraSpendableUtxo,
  IEsploraTransaction,
} from "../esplora/types";

import { OrdOutput } from "../ord/types";

import {
  AlkanesOutpoint,
  AlkanesUtxoEntry,
  AlkaneReadableId,
  AlkanesOutpoints,
  AlkanesOutpointsExtended,
  AlkanesByAddressResponse,
  AlkanesOutpointExtended,
  AlkanesByAddressOutpoint,
} from "../alkanes/types";

import { reverseHexBytes } from "@/utils";
import { FormattedUtxo } from "./types";

export enum SandshrewFetchError {
  UnknownError = "UnknownError",
  InternalError = "InternalError",
}

export class SandshrewRpcProvider {
  constructor(
    private readonly provider: Provider,
    private readonly electrumApiProvider: ElectrumApiProvider,
    private readonly ordRpcProvider: OrdRpcProvider,
    private readonly alkanesRpcProvider: AlkanesRpcProvider,
  ) {}

  async sandshrew_multcall<T>(
    rpcCalls: RpcCall<T>[],
  ): Promise<BoxedResponse<T[], SandshrewFetchError>> {
    const rpcTuples: RpcTuple[] = rpcCalls.map((rpcCall) => rpcCall.payload);

    try {
      const rpcResponse = consumeOrThrow(
        await this.provider
          .buildRpcCall<
            RpcResponse<unknown>[]
          >("sandshrew_multicall", rpcTuples)
          .call(),
      );

      const errors = rpcResponse.filter(
        (response) => response?.error !== undefined,
      );

      if (errors.length > 0) {
        return new BoxedError(`
          Some RPC calls failed:
          ${errors.map((error, index) => `(${index}) Method ${rpcCalls[index].call.name} with params ${rpcCalls[index].payload} failed with error: ${error}\n\n`)}
          `, SandshrewFetchError.InternalError);
      }

      return new BoxedSuccess(
        rpcResponse.map((response) => response.result) as T[],
      );
    } catch (error) {
      return new BoxedError((error as Error).message ?? "Unknown Error", SandshrewFetchError.UnknownError);
    }
  }

}

/* Re-export legacy types / helpers so old import paths keep working */
export * from "./types";
export * from "./shared";
