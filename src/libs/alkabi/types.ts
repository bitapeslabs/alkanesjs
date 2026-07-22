/*─────────────────────────────────────────────────────────────
  ALKABI DOCUMENT TYPES
  -----------------------------------------------------------
  The literal shape of an alkabi v1 ABI document — what alkabi-rs
  emits as abi.json / abi.ts (`export const XAbi = {...} as const`).
  Schemas use the borsh-js grammar borsher wraps, extended with
  `$ref` pointers into the document's `types` section.
──────────────────────────────────────────────────────────────*/

export type AlkabiPrimitive =
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "u128"
  | "i8"
  | "i16"
  | "i32"
  | "i64"
  | "i128"
  | "f32"
  | "f64"
  | "bool"
  | "string";

export type AlkabiSchemaDef =
  | AlkabiPrimitive
  | { readonly $ref: string }
  | { readonly struct: { readonly [field: string]: AlkabiSchemaDef } }
  | {
      readonly enum: readonly {
        readonly struct: { readonly [variant: string]: AlkabiSchemaDef };
      }[];
    }
  | { readonly option: AlkabiSchemaDef }
  | { readonly array: { readonly type: AlkabiSchemaDef; readonly len?: number } };

/** How bytes on the wire relate to the schema. */
export type AlkabiIoMode = "legacy" | "borsh" | "raw";

export interface AlkabiIoDef {
  readonly mode: AlkabiIoMode;
  readonly schema: AlkabiSchemaDef;
}

export interface AlkabiMethodDef {
  /** camelCase method name, as exposed on the contract instance. */
  readonly name: string;
  readonly opcode: number;
  readonly kind: "view" | "execute";
  /** Calldata payload (u128 words after the opcode). */
  readonly input?: AlkabiIoDef;
  /** Borsh payload carried in the reveal transaction's witness envelope. */
  readonly witness?: AlkabiIoDef;
  /** Response data; absent means void. */
  readonly output?: AlkabiIoDef;
  /**
   * A verified static fast-path: a pure expression over storage keys, calldata,
   * and height that reproduces this view's response bytes without simulating.
   * Synthesized by alkabi's wasm analysis (`--plans`) and verified against the
   * bytecode. When present and the provider has an `espoUrl`, `AlkanesContract`
   * evaluates it — fetching storage in one batched espo `get_keys` call — in
   * place of `simulate`, falling back to simulate on any error.
   */
  readonly plan?: AlkabiPlan;
}

/** Opaque for now — see the alkabi plan grammar (Rust `alkabi::plan`). */
export interface AlkabiPlan {
  readonly v: number;
  readonly expr: unknown;
  readonly trials: number;
}

export interface AlkabiDocument {
  readonly alkabi: number;
  readonly contract: string;
  readonly types: { readonly [name: string]: AlkabiSchemaDef };
  readonly methods: readonly AlkabiMethodDef[];
}

export type AlkabiTypes = AlkabiDocument["types"];
