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

import type { BundledViewCall } from "../interfaces/base";
import { BorshSchema } from "borsher";
import type { ViewCallOptions } from "./wasm-runtime";
import { AlkaneId } from "@/apis";
import { Provider } from "@/provider";
import { BoxedPromise, BoxedResponse, IBoxedError } from "@/boxed";
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
export function specFromAlkabi(
  document: AlkabiDocument,
  wasm?: Uint8Array | WebAssembly.Module,
) {
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

      // Given the contract's own bytes, a view is answered by running them
      // against a stub host reading storage from espo (with automatic simulate
      // fallback) instead of by simulating.
      if (wasm) {
        const inShape = input ?? "__void";
        viewSpec.impl = function (
          this: AlkanesBaseContract,
          arg: any,
          opts?: ViewCallOptions,
        ) {
          return this.handleWasmView(
            opcode,
            arg,
            inShape as any,
            output as any,
            wasm,
            opts,
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
      opts?: ViewCallOptions,
    ) => BoxedPromise<OutOf<M, T>, AlkanesSimulationError>
  : (opts?: ViewCallOptions) => BoxedPromise<OutOf<M, T>, AlkanesSimulationError>;

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
  /**
   * The contract's own wasm. Supply it and view methods are answered by running
   * the contract locally against storage read from espo, instead of by asking
   * the indexer to simulate. Exact for any pure view; anything that reaches
   * outside its own storage falls back to simulate on its own.
   *
   * Pass a pre-compiled `WebAssembly.Module` to skip recompiling per contract.
   */
  wasm?: Uint8Array | WebAssembly.Module;
}

/*------------------------------------------------------------*
 | View bundles — many calls, one JSON-RPC batch               |
 *------------------------------------------------------------*/

type ViewDef<D extends AlkabiDocument> = Extract<
  D["methods"][number],
  { kind: "view" }
>;

type Boxed<Out> = BoxedResponse<Out, AlkanesSimulationError>;

type BundleAdd<D extends AlkabiDocument, M, Acc extends readonly unknown[]> =
  M extends { input: infer I }
    ? (
        arg: InferAlkabiIo<I, D["types"]>,
      ) => BundleSlot<D, Acc, OutOf<M, D["types"]>>
    : () => BundleSlot<D, Acc, OutOf<M, D["types"]>>;

/**
 * The chain right after adding a call: still the whole bundle (chain the next
 * view, await, `send()`), plus the bxrs-style modifiers deciding how THIS
 * call's slot resolves. Left unmodified, the slot stays a `BoxedResponse`.
 */
export type BundleSlot<
  D extends AlkabiDocument,
  Acc extends readonly unknown[],
  Out,
> = ViewBundle<D, readonly [...Acc, Boxed<Out>]> & {
  /** Slot resolves to the bare value; failure rejects the awaited bundle. */
  unwrap(): ViewBundle<D, readonly [...Acc, Out]>;
  /** `unwrap` with your own message on failure. */
  expect(message: string): ViewBundle<D, readonly [...Acc, Out]>;
  /** Slot resolves to the value, or `fallback` if this call failed. */
  unwrapOr(fallback: Out): ViewBundle<D, readonly [...Acc, Out]>;
  /** Slot resolves to the value, or whatever `f` makes of the failure. */
  unwrapOrElse(
    f: (err: IBoxedError<AlkanesSimulationError>) => Out,
  ): ViewBundle<D, readonly [...Acc, Out]>;
  /** Slot resolves to the value, or `null` if this call failed. */
  toNullable(): ViewBundle<D, readonly [...Acc, Out | null]>;
};

/**
 * A chain of view calls that goes out as ONE JSON-RPC batch. Each added call
 * appends a slot to the awaited tuple, and the modifier chained right after
 * it decides what that slot resolves to:
 *
 *   const [name, state] = await contract
 *     .bundle()
 *     .getName().unwrap()                  // bare value; failure rejects
 *     .getBetState(id).unwrapOr(none);     // bare value; failure → default
 *
 * No modifier → the slot stays that call's `BoxedResponse`, handled later.
 * Awaiting the chain sends it (`send()` does the same, explicitly).
 */
export type ViewBundle<
  D extends AlkabiDocument,
  Acc extends readonly unknown[] = readonly [],
> = {
  [M in ViewDef<D> as M["name"] & string]: BundleAdd<D, M, Acc>;
} & PromiseLike<Acc> & {
    send(): Promise<Acc>;
  };

export type AlkanesContractInstance<D extends AlkabiDocument> =
  AlkanesBaseContract &
  AlkabiMethodMap<D> & {
    /** Start a view bundle — chain calls, await once, get a typed tuple. */
    bundle(): ViewBundle<D>;
    /**
     * The cellpack for one of this contract's methods, and the shape its answer
     * decodes with. What a transaction needs; see `AlkaneTx.call`.
     */
    encodeCall(
      method: string,
      arg?: unknown,
    ): { alkaneId: AlkaneId; calldata: bigint[]; outShape: unknown };
    /**
     * Phantom — never present at runtime. Carries the document type so a
     * transaction's `.call(contract)` can offer this contract's own methods.
     */
    readonly __alkabi?: D;
  };

/* How a chained slot resolves — shared by `bundle()` and `block()`. */
type SlotMode =
  | { kind: "boxed" }
  | { kind: "unwrap" }
  | { kind: "expect"; message: string }
  | { kind: "unwrapOr"; fallback: unknown }
  | { kind: "unwrapOrElse"; f: (err: unknown) => unknown }
  | { kind: "toNullable" };

const MODIFIERS: Record<string, (...args: unknown[]) => SlotMode> = {
  unwrap: () => ({ kind: "unwrap" }),
  expect: (message) => ({ kind: "expect", message: String(message) }),
  unwrapOr: (fallback) => ({ kind: "unwrapOr", fallback }),
  unwrapOrElse: (f) => ({
    kind: "unwrapOrElse",
    f: f as (err: unknown) => unknown,
  }),
  toNullable: () => ({ kind: "toNullable" }),
};

function applyMode(
  response: BoxedResponse<unknown, AlkanesSimulationError>,
  mode: SlotMode,
): unknown {
  switch (mode.kind) {
    case "boxed":
      return response;
    case "unwrap":
      return response.unwrap();
    case "expect":
      return response.expect(mode.message);
    case "unwrapOr":
      return response.isErr() ? mode.fallback : response.data;
    case "unwrapOrElse":
      return response.unwrapOrElse(mode.f as never);
    case "toNullable":
      return response.toNullable();
  }
}

class AlkanesContractImpl extends AlkanesBaseContract {
  private readonly opcodeTable: OpcodeTable;
  /** Per-view encode/decode shapes, for assembling bundles. */
  private readonly viewMeta: Record<
    string,
    { opcode: bigint; inShape: unknown; outShape: unknown }
  >;
  /** The same, for every method — a transaction can call an execute too. */
  private readonly methodMeta: Record<
    string,
    { opcode: bigint; inShape: unknown; outShape: unknown }
  >;

  protected get OpCodes(): OpcodeTable {
    return this.opcodeTable;
  }

  constructor(document: AlkabiDocument, options: AlkanesContractOptions) {
    super(options.provider, options.alkaneId, options.signPsbt);
    const spec = specFromAlkabi(document, options.wasm);
    this.opcodeTable = buildOpcodeTable(spec);
    wireMethods(this, spec);

    this.viewMeta = {};
    this.methodMeta = {};
    for (const method of document.methods) {
      const meta = {
        opcode: BigInt(method.opcode),
        inShape: inputShape(method.input, document.types) ?? "__void",
        outShape: outputShape(method.output, document.types),
      };
      this.methodMeta[method.name] = meta;
      if (method.kind === "view") this.viewMeta[method.name] = meta;
    }
  }

  /**
   * Everything a transaction needs to write this call into a protostone: the
   * cellpack (`[block, tx, opcode, ...words]`) and the shape its answer decodes
   * with. Who is making the call, and what they pay with, is the account's
   * business — see `AlkanesAccount`.
   */
  encodeCall(
    method: string,
    arg?: unknown,
  ): { alkaneId: AlkaneId; calldata: bigint[]; outShape: unknown } {
    const meta = this.methodMeta[method];
    if (!meta) {
      throw new Error(`${method}: no such method on this contract`);
    }
    const words = this.encodeCalldata(arg as never, meta.inShape as never);
    if (words.isErr()) {
      throw new Error(`${method}: ${words.message ?? "encoding failed"}`);
    }
    return {
      alkaneId: this.alkaneId,
      calldata: [
        BigInt(this.alkaneId.block),
        BigInt(this.alkaneId.tx),
        meta.opcode,
        ...words.data,
      ],
      outShape: meta.outShape,
    };
  }

  /** See `ViewBundle` — a chainable, awaitable batch of view calls. */
  bundle(): unknown {
    const queue: { call: BundledViewCall; mode: SlotMode }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const send = async (): Promise<unknown[]> => {
      const boxed = await self.handleViewBundle(queue.map((q) => q.call));
      return boxed.map((response, i) => applyMode(response, queue[i].mode));
    };

    const proxy: unknown = new Proxy(Object.create(null), {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "send") return send;
        if (prop === "then") {
          return (
            onFulfilled?: (value: unknown[]) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => send().then(onFulfilled, onRejected);
        }
        const modifier = MODIFIERS[prop];
        if (modifier) {
          return (...args: unknown[]) => {
            const last = queue[queue.length - 1];
            if (!last) {
              throw new Error(`bundle: .${prop}() before any view call`);
            }
            last.mode = modifier(...args);
            return proxy;
          };
        }
        const meta = self.viewMeta[prop];
        if (!meta) return undefined;
        return (arg?: unknown) => {
          queue.push({
            call: { name: prop, arg, ...meta },
            mode: { kind: "boxed" },
          });
          return proxy;
        };
      },
    });
    return proxy;
  }
}

export const AlkanesContract = AlkanesContractImpl as unknown as {
  new <const D extends AlkabiDocument>(
    document: D,
    options: AlkanesContractOptions,
  ): AlkanesContractInstance<D>;
};
