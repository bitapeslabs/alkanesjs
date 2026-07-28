/*─────────────────────────────────────────────────────────────
  ALKABI TYPE-LEVEL INTERPRETER
  -----------------------------------------------------------
  Walks the `as const` document literal and produces the same TS
  types borsh-js hands back at runtime (borsher's conventions):
  u8–u32 → number, u64/u128 → bigint, option → T | null, enums →
  single-key-object unions. `$ref` resolves through the document's
  `types` map. This is what makes `new AlkanesContract(abi)` fully
  typed with zero codegen.
──────────────────────────────────────────────────────────────*/

import { AlkabiIoDef, AlkabiTypes } from "./types";

export type InferAlkabiSchema<S, T extends AlkabiTypes> =
  /* primitives — must match what borsh-js actually returns */
  S extends "u8" | "u16" | "u32" | "i8" | "i16" | "i32" | "f32" | "f64"
    ? number
    : S extends "u64" | "u128" | "i64" | "i128"
      ? bigint
      : S extends "bool"
        ? boolean
        : S extends "string"
          ? string
          : /* $ref → resolve through the document's types section */
            S extends { $ref: infer N }
            ? N extends keyof T
              ? InferAlkabiSchema<T[N], T>
              : unknown
            : /* struct — field order is wire-significant but not type-significant */
              S extends { struct: infer F }
              ? { -readonly [K in keyof F]: InferAlkabiSchema<F[K], T> }
              : /* option */
                S extends { option: infer I }
                ? InferAlkabiSchema<I, T> | null
                : /* array — fixed length or Vec */
                  S extends { array: { type: infer E; len: number } }
                  ? InferAlkabiSchema<E, T>[]
                  : S extends { array: { type: infer E } }
                    ? InferAlkabiSchema<E, T>[]
                    : /* enum — borsher-shaped union of single-key objects */
                      S extends { enum: infer V extends readonly unknown[] }
                      ? InferAlkabiEnumVariant<V[number], T>
                      : never;

type InferAlkabiEnumVariant<Variant, T extends AlkabiTypes> = Variant extends {
  struct: infer W;
}
  ? { -readonly [K in keyof W]: InferAlkabiSchema<W[K], T> }
  : never;

/**
 * Resolve an IO declaration to its runtime TS type. Identical to
 * `InferAlkabiSchema` except raw-mode byte arrays, which decode to
 * `Uint8Array` (raw mode means "the remaining response bytes").
 */
export type InferAlkabiIo<IO, T extends AlkabiTypes> = IO extends {
  mode: "raw";
  schema: infer S;
}
  ? S extends { array: { type: "u8" } }
    ? Uint8Array
    : InferAlkabiSchema<S, T>
  : IO extends { schema: infer S }
    ? InferAlkabiSchema<S, T>
    : never;

/** Convenience: the resolved type of a named entry in the types section. */
export type InferAlkabiType<
  D extends { types: AlkabiTypes },
  Name extends keyof D["types"],
> = InferAlkabiSchema<D["types"][Name], D["types"]>;

export type { AlkabiIoDef };
