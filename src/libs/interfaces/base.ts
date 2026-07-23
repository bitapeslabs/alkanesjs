import {
  BoxedResponse,
  BoxedPromise,
  isBoxedError,
  BoxedSuccess,
  BoxedError,
  consumeOrThrow,
} from "@/boxed";
import { AlkaneId } from "@/apis";
import { Provider } from "@/provider";

import {
  AlkanesExecuteError,
  AlkanesInscription,
  ProtostoneTransactionOptions,
} from "../alkanes";
import {
  IDecodableAlkanesResponse,
  DecodableAlkanesResponse,
  DecoderFns,
  DecodeError,
} from "../decoders";
import { Expand, sleep } from "@/utils";
import { BorshSchema, Infer as BorshInfer, borshSerialize } from "borsher";
import { abi, Schema, ResolveSchema, Dec } from "./builder"; // 🠕
import { Encodable, EncodeError, EncoderFns } from "../encoders";
import { LegacyCodec, RawCodec } from "../alkabi/codecs";
import {
  runWasmView,
  bytesToHex,
  PLACEHOLDER_HEIGHT,
  type ViewCallOptions,
} from "../alkabi/wasm-runtime";

export enum AlkanesSimulationError {
  UnknownError = "UnknownError",
  TransactionReverted = "Revert",
}

export type OpcodeTable = { readonly [K in string]: bigint };

export type AlkanesPushExecuteResponse<T> = Expand<{
  waitForResult: () => BoxedPromise<
    IDecodableAlkanesResponse<T>,
    AlkanesExecuteError
  >;
  txid: string;
}>;

const isBorshSchema = <T>(schema: Schema | Dec): schema is BorshSchema<T> =>
  typeof schema !== "string" && schema instanceof BorshSchema;

/** espo returns value bytes as "0x…" hex ("0x" for unset). */
function hexFromEspo(valueHex: string | undefined): Uint8Array {
  const clean = (valueHex ?? "0x").replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export abstract class AlkanesBaseContract {
  constructor(
    protected readonly provider: Provider,
    public readonly alkaneId: AlkaneId,
    private readonly signPsbtFn: (unsigned: string) => Promise<string>,
  ) {}
  protected abstract get OpCodes(): OpcodeTable;

  /*─────────────── thin helpers around Provider ───────────────*/
  protected get rpc() {
    return this.provider.buildRpcCall.bind(this.provider);
  }
  protected get execute() {
    return this.provider.execute.bind(this.provider);
  }

  protected get trace() {
    return this.provider.trace.bind(this.provider);
  }

  public get signPsbt() {
    return this.signPsbtFn.bind(this);
  }

  public simulate(
    request: Omit<Parameters<Provider["simulate"]>[0], "target">,
  ): ReturnType<Provider["simulate"]> {
    return this.provider.simulate({ target: this.alkaneId, ...request });
  }

  private getEncodedCallData<I extends Schema>(
    arg: ResolveSchema<I>,
    shape: I,
  ): BoxedResponse<bigint[], EncodeError> {
    if (shape === "__void") {
      return new BoxedSuccess([]);
    }
    /* alkabi legacy calldata (positional u128 words) */
    if (shape instanceof LegacyCodec) {
      try {
        return new BoxedSuccess(shape.encodeCalldata(arg));
      } catch (error) {
        return new BoxedError("Legacy encoding failed: " + (error as Error).message, EncodeError.InvalidPayload);
      }
    }
    let encoder = isBorshSchema(shape)
      ? new Encodable(arg, shape)
      : new Encodable(arg);

    let bigintArrayResponse = isBorshSchema(shape)
      ? encoder.encodeFrom("object")
      : encoder.encodeFrom(shape as keyof EncoderFns<unknown>);

    return bigintArrayResponse;
  }

  private getDecodedResponse<O extends Schema>(
    response: ConstructorParameters<typeof DecodableAlkanesResponse>[0],
    outShape: O,
  ): BoxedResponse<ResolveSchema<O>, DecodeError> {
    try {
      /* alkabi raw / legacy returndata (schema-driven decoding) */
      if (outShape instanceof RawCodec || outShape instanceof LegacyCodec) {
        const decodable = new DecodableAlkanesResponse(response);
        return new BoxedSuccess(
          outShape.decodeReturn(decodable.bytes) as ResolveSchema<O>,
        );
      }
      let decodable = isBorshSchema(outShape)
        ? new DecodableAlkanesResponse(response, outShape)
        : new DecodableAlkanesResponse(response);
      let decodedResponse = isBorshSchema(outShape)
        ? decodable.decodeTo("object")
        : decodable.decodeTo(outShape as keyof DecoderFns<unknown>);
      return new BoxedSuccess(decodedResponse as ResolveSchema<O>);
    } catch (error) {
      return new BoxedError("Decoding response failed: " + (error as Error).message, DecodeError.UnknownError);
    }
  }

  public pushExecute = async <T>(
    config: Parameters<Provider["execute"]>[0],
    borshSchema?: BorshSchema<T>,
  ): Promise<
    BoxedResponse<AlkanesPushExecuteResponse<T>, AlkanesExecuteError>
  > => {
    try {
      const signedTxs = consumeOrThrow(
        await this.provider.execute({
          ...config,
          callData: [this.alkaneId.block, this.alkaneId.tx, ...config.callData],
        }),
      );

      let lastTxid: string = "";
      for (const signedTx of signedTxs) {
        lastTxid = consumeOrThrow(
          await this.provider.rpc.electrum.esplora_broadcastTx(signedTx),
        );
        await sleep(1000);
      }

      const waitForResult = async (): Promise<
        BoxedResponse<IDecodableAlkanesResponse<T>, AlkanesExecuteError>
      > => {
        try {
          const traceResult = consumeOrThrow(
            await this.provider.waitForTraceResult(lastTxid),
          );

          return new BoxedSuccess(
            new DecodableAlkanesResponse(traceResult.return, borshSchema),
          );
        } catch (err) {
          return new BoxedError("Wait for result failed: " + (err as Error).message, AlkanesExecuteError.UnknownError);
        }
      };

      return new BoxedSuccess({
        waitForResult: () => BoxedPromise.from(waitForResult()),
        txid: lastTxid,
      });
    } catch (err) {
      return new BoxedError("Push execute failed: " + (err as Error).message, AlkanesExecuteError.UnknownError);
    }
  };

  public async handleView<I extends Schema, O extends Schema>(
    opcode: bigint,
    arg: ResolveSchema<I>,
    inShape: I, // may or may not be a BorshSchema
    outShape: O, // may or may not be a BorshSchema
  ): Promise<BoxedResponse<ResolveSchema<O>, AlkanesSimulationError>> {
    try {
      let callData: bigint[] = [
        opcode, // opcode for Word Count
        ...consumeOrThrow(this.getEncodedCallData(arg, inShape)),
      ];

      let response = consumeOrThrow(
        await this.simulate({
          callData,
        }),
      );

      return new BoxedSuccess(
        consumeOrThrow(this.getDecodedResponse(response, outShape)),
      );
    } catch (error) {
      return new BoxedError("Simulation failed: " + (error as Error).message, AlkanesSimulationError.UnknownError);
    }
  }

  /**
   * A view evaluated by running the contract's own wasm instead of asking the
   * indexer to simulate it. Storage the contract reaches for is fetched from
   * espo in batches (see `runWasmView`), so this costs a handful of key reads
   * rather than a simulate — and it is exact, because it *is* the contract.
   *
   * Needs espo and the contract bytes; without either, or if the view turns out
   * to be impure, or on any failure at all, it falls back to simulate. Running
   * the wasm is an optimization, never load-bearing for correctness.
   */
  public async handleWasmView<I extends Schema, O extends Schema>(
    opcode: bigint,
    arg: ResolveSchema<I>,
    inShape: I,
    outShape: O,
    wasm: Uint8Array | WebAssembly.Module,
    opts?: ViewCallOptions,
  ): Promise<BoxedResponse<ResolveSchema<O>, AlkanesSimulationError>> {
    try {
      if (!this.provider.espoUrl) {
        return this.handleView(opcode, arg, inShape, outShape);
      }

      const words = consumeOrThrow(this.getEncodedCallData(arg, inShape));
      // The height comes from espo, the same place the storage does, so a view
      // that reads both sees one coherent view of the chain. Only fetched when
      // the caller says the answer depends on it.
      let height = PLACEHOLDER_HEIGHT;
      if (opts?.latestHeight) {
        const tip = consumeOrThrow(await this.provider.rpc.espo.getTipHeight());
        height = BigInt(typeof tip === "number" ? tip : tip.height);
      }
      const alkaneStr = `${this.alkaneId.block}:${this.alkaneId.tx}`;

      const bytes = await runWasmView({
        wasm,
        alkaneId: this.alkaneId,
        opcode,
        words,
        height,
        fetchKeys: async (keys) => {
          const result = await this.provider.rpc.espo.getKeys(alkaneStr, {
            keys: keys.map((k) => "0x" + bytesToHex(k)),
            try_decode_utf8: false,
          });
          if (result.isErr()) throw new Error("espo get_keys failed");
          const out = new Map<string, Uint8Array>();
          for (const item of Object.values(result.data.items)) {
            out.set(
              item.key_hex.replace(/^0x/, "").toLowerCase(),
              hexFromEspo(item.value_hex),
            );
          }
          return out;
        },
      });

      return new BoxedSuccess(
        consumeOrThrow(this.getDecodedResponse(bytes, outShape)),
      );
    } catch {
      // any failure → fall back to the authoritative simulate path
      return this.handleView(opcode, arg, inShape, outShape);
    }
  }

  public async handleExecute<
    I extends Schema,
    K extends BorshSchema<unknown>,
    O extends Dec,
  >(
    address: string,
    opcode: bigint,
    arg: ResolveSchema<I>,
    argInscription: ResolveSchema<K> | undefined,
    inShape: I,
    inInscriptionShape: K | undefined, // may or may not be a BorshSchema
    outShape: O,
    txOpts?: Partial<ProtostoneTransactionOptions>,
  ): Promise<
    BoxedResponse<
      AlkanesPushExecuteResponse<ResolveSchema<O>>,
      AlkanesExecuteError
    >
  > {
    try {
      let inscription: AlkanesInscription<unknown> | undefined;
      if (argInscription && inInscriptionShape) {
        inscription = new AlkanesInscription(
          argInscription,
          inInscriptionShape,
        );
      }

      let callData: bigint[] = [
        opcode,
        ...consumeOrThrow(this.getEncodedCallData(arg, inShape)),
      ];

      const executePromise = isBorshSchema<BorshInfer<typeof outShape>>(
        outShape,
      )
        ? this.pushExecute<BorshInfer<typeof outShape>>(
            {
              address,
              callData,
              signPsbt: this.signPsbt,
              inscription,
              ...txOpts,
            },
            outShape,
          )
        : this.pushExecute({
            address,
            callData,
            signPsbt: this.signPsbt,
            inscription,
            ...txOpts,
          });

      const response = await executePromise;
      return response as BoxedResponse<
        AlkanesPushExecuteResponse<ResolveSchema<O>>,
        AlkanesExecuteError
      >;
    } catch (error) {
      return new BoxedError("Execution failed: " + (error as Error).message, AlkanesExecuteError.UnknownError);
    }
  }
}
