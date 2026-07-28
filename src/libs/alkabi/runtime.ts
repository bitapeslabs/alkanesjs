/*─────────────────────────────────────────────────────────────
  ALKABI → BORSHER SCHEMA RECONSTRUCTION
  -----------------------------------------------------------
  Rebuilds borsher `BorshSchema` instances from alkabi schema JSON
  through borsher's public constructors, resolving `$ref`s against
  the document's types section. The typed wrapper claims the
  precisely-inferred type so the existing ResolveSchema/BorshInfer
  machinery types everything downstream.
──────────────────────────────────────────────────────────────*/

import { BorshSchema } from "borsher";
import { InferAlkabiSchema } from "./infer";
import { AlkabiSchemaDef, AlkabiTypes } from "./types";

const PRIMITIVES: Record<string, () => BorshSchema<unknown>> = {
  u8: () => BorshSchema.u8,
  u16: () => BorshSchema.u16,
  u32: () => BorshSchema.u32,
  u64: () => BorshSchema.u64,
  u128: () => BorshSchema.u128,
  i8: () => BorshSchema.i8,
  i16: () => BorshSchema.i16,
  i32: () => BorshSchema.i32,
  i64: () => BorshSchema.i64,
  i128: () => BorshSchema.i128,
  f32: () => BorshSchema.f32,
  f64: () => BorshSchema.f64,
  bool: () => BorshSchema.bool,
  string: () => BorshSchema.String,
};

/** Untyped recursive builder (runtime workhorse). */
export function buildBorshSchema(
  schema: AlkabiSchemaDef,
  types: AlkabiTypes,
): BorshSchema<any> {
  if (typeof schema === "string") {
    const primitive = PRIMITIVES[schema];
    if (!primitive) {
      throw new Error(`alkabi: unknown primitive "${schema}"`);
    }
    return primitive() as BorshSchema<any>;
  }

  if ("$ref" in schema) {
    const resolved = types[schema.$ref];
    if (!resolved) {
      throw new Error(
        `alkabi: $ref "${schema.$ref}" not found in the document's types section`,
      );
    }
    return buildBorshSchema(resolved, types);
  }

  if ("struct" in schema) {
    const fields: Record<string, BorshSchema<unknown>> = {};
    // Object.entries preserves author order — borsh field order is wire-significant.
    for (const [name, field] of Object.entries(schema.struct)) {
      fields[name] = buildBorshSchema(field, types);
    }
    return BorshSchema.Struct(fields) as BorshSchema<any>;
  }

  if ("enum" in schema) {
    const variants: Record<string, BorshSchema<unknown>> = {};
    for (const wrapper of schema.enum) {
      const entries = Object.entries(wrapper.struct);
      if (entries.length !== 1) {
        throw new Error(
          "alkabi: enum variant wrapper must have exactly one key",
        );
      }
      const [name, variant] = entries[0];
      variants[name] = buildBorshSchema(variant, types);
    }
    return BorshSchema.Enum(variants) as BorshSchema<any>;
  }

  if ("option" in schema) {
    return BorshSchema.Option(buildBorshSchema(schema.option, types));
  }

  if ("array" in schema) {
    const element = buildBorshSchema(schema.array.type, types);
    return schema.array.len != null
      ? BorshSchema.Array(element, schema.array.len)
      : BorshSchema.Vec(element);
  }

  throw new Error(`alkabi: unrecognized schema ${JSON.stringify(schema)}`);
}

/**
 * Typed entry point: rebuild a borsher schema from alkabi JSON with the
 * inferred type attached, so `BorshInfer` (and everything built on it)
 * resolves the literal.
 */
export function borshSchemaFromAlkabi<
  const S extends AlkabiSchemaDef,
  const T extends AlkabiTypes,
>(schema: S, types: T): BorshSchema<InferAlkabiSchema<S, T>> {
  return buildBorshSchema(schema, types) as BorshSchema<
    InferAlkabiSchema<S, T>
  >;
}
