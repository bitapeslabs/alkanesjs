/*─────────────────────────────────────────────────────────────
  ALKANES CONTRACT FROM AN ALKABI DOCUMENT
  -----------------------------------------------------------
  `new AlkanesContract(MyAbi, { provider, alkaneId, signPsbt })`
  yields the same interface a hand-written alkanesjs ABI gives:
  fully-typed view/execute methods, straight from the `as const`
  abi.ts literal — zero codegen.

  Under the hood the document compiles into the existing
  ViewSpec/ExecuteSpec records (borsh IO → borsher schemas,
  legacy inputs → LegacyCodec, raw outputs → RawCodec, witness →
  the inscription slot) and is wired through the same
  handleView/handleExecute plumbing every contract uses.
──────────────────────────────────────────────────────────────*/

import { BorshSchema } from "borsher";
import { AlkaneId } from "@/apis";
import { Provider } from "@/provider";
import { BoxedPromise } from "@/boxed";
import { AlkanesExecuteError } from "../alkanes";
import {
  AlkanesBaseContract,
  AlkanesPushExecuteResponse,
  AlkanesSimulationError,
  OpcodeTable,
} from "../interfaces/base";
import {
  abi,
  buildOpcodeTable,
  wireMethods,
  Dec,
  ProtostoneTransactionOptionsPartial,
  Schema,
} from "../interfaces/builder";
import { LegacyCodec, RawCodec } from "./codecs";
import { InferAlkabiIo } from "./infer";
import { buildBorshSchema } from "./runtime";
import {
  AlkabiDocument,
  AlkabiIoDef,
  AlkabiMethodDef,
  AlkabiTypes,
} from "./types";

/*------------------------------------------------------------*
 | 1.  Document → spec record (runtime)                        |
 *------------------------------------------------------------*/

function inputShape(
  io: AlkabiIoDef | undefined,
  types: AlkabiTypes,
): Schema | undefined {
  if (!io) return undefined;
  switch (io.mode) {
    case "borsh":
      return buildBorshSchema(io.schema, types);
    case "legacy":
      return new LegacyCodec(io.schema, types);
    default:
      throw new Error(`alkabi: unsupported input mode "${io.mode}"`);
  }
}

function outputShape(io: AlkabiIoDef | undefined, types: AlkabiTypes): Dec {
  if (!io) return "uint8Array"; // void — same default as hand-written ABIs
  switch (io.mode) {
    case "borsh":
      return buildBorshSchema(io.schema, types);
    case "raw":
      return new RawCodec(io.schema, types);
    case "legacy":
      // bespoke upstream layouts (u128 length-prefixed vecs etc.) decoded
      // exactly like legacy calldata, just from the response bytes
      return new LegacyCodec(io.schema, types);
    default:
      throw new Error(`alkabi: unsupported output mode "${io.mode}"`);
  }
}

/**
 * Compile an alkabi document into an alkanesjs spec record — the same
 * shape `abi.contract({...})` produces by hand, so it composes with
 * `abi.extend` / `abi.attach` and custom offchain methods.
 */
export function specFromAlkabi(document: AlkabiDocument) {
  const spec: Record<string, any> = {};

  for (const method of document.methods) {
    const opcode = BigInt(method.opcode);
    const input = inputShape(method.input, document.types);
    const output = outputShape(method.output, document.types);

    if (method.kind === "view") {
      if (method.witness) {
        throw new Error(
          `alkabi: view method "${method.name}" cannot carry a witness payload`,
        );
      }
      const viewSpec: any = abi
        .opcode(opcode)
        .view(input as any)
        .returns(output as any);

      // A verified plan turns this view into a batched get_keys read + local
      // evaluation (with automatic simulate fallback), instead of a simulate.
      if (method.plan) {
        const plan = method.plan;
        const inShape = input ?? "__void";
        viewSpec.impl = function (this: AlkanesBaseContract, arg: any) {
          return this.handlePlannedView(
            opcode,
            arg,
            inShape as any,
            output as any,
            plan,
          );
        };
      }

      spec[method.name] = viewSpec;
    } else {
      const inscription = method.witness
        ? (buildBorshSchema(
            method.witness.schema,
            document.types,
          ) as BorshSchema<any>)
        : undefined;
      spec[method.name] = abi
        .opcode(opcode)
        .execute(input as any, inscription as any)
        .returns(output as any);
    }
  }

  return spec;
}

/*------------------------------------------------------------*
 | 2.  Document → method map (type level)                      |
 *------------------------------------------------------------*/

type OutOf<M, T extends AlkabiTypes> = M extends { output: infer O }
  ? InferAlkabiIo<O, T>
  : Uint8Array;

type ViewFn<M, T extends AlkabiTypes> = M extends { input: infer I }
  ? (
      arg: InferAlkabiIo<I, T>,
    ) => BoxedPromise<OutOf<M, T>, AlkanesSimulationError>
  : () => BoxedPromise<OutOf<M, T>, AlkanesSimulationError>;

type ExecuteTail<M, T extends AlkabiTypes> = M extends { input: infer I }
  ? M extends { witness: infer W }
    ? [input: InferAlkabiIo<I, T>, witness: InferAlkabiIo<W, T>]
    : [input: InferAlkabiIo<I, T>]
  : M extends { witness: infer W }
    ? [witness: InferAlkabiIo<W, T>]
    : [];

type ExecuteFn<M, T extends AlkabiTypes> = (
  address: string,
  ...args: [...ExecuteTail<M, T>, txOpts?: ProtostoneTransactionOptionsPartial]
) => BoxedPromise<
  AlkanesPushExecuteResponse<OutOf<M, T>>,
  AlkanesExecuteError
>;

export type AlkabiMethodMap<D extends AlkabiDocument> = {
  [M in D["methods"][number] as M["name"]]: M["kind"] extends "view"
    ? ViewFn<M, D["types"]>
    : ExecuteFn<M, D["types"]>;
};

/*------------------------------------------------------------*
 | 3.  AlkanesContract                                         |
 *------------------------------------------------------------*/

export interface AlkanesContractOptions {
  provider: Provider;
  alkaneId: AlkaneId;
  signPsbt: (unsigned: string) => Promise<string>;
}

export type AlkanesContractInstance<D extends AlkabiDocument> =
  AlkanesBaseContract & AlkabiMethodMap<D>;

class AlkanesContractImpl extends AlkanesBaseContract {
  private readonly opcodeTable: OpcodeTable;

  protected get OpCodes(): OpcodeTable {
    return this.opcodeTable;
  }

  constructor(document: AlkabiDocument, options: AlkanesContractOptions) {
    super(options.provider, options.alkaneId, options.signPsbt);
    const spec = specFromAlkabi(document);
    this.opcodeTable = buildOpcodeTable(spec);
    wireMethods(this, spec);
  }
}

export const AlkanesContract = AlkanesContractImpl as unknown as {
  new <const D extends AlkabiDocument>(
    document: D,
    options: AlkanesContractOptions,
  ): AlkanesContractInstance<D>;
};
