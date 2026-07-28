/*─────────────────────────────────────────────────────────────
  ABI OVERRIDES
  -----------------------------------------------------------
  Generated ABI files are authoritative and must stay byte-identical
  to what alkabi emitted. When a document needs hand-verified
  corrections — typically normalized pre-alkabi contracts, whose
  view/execute kinds are heuristic and whose upstream #[returns]
  hints are lossy — apply them here, in consumer code:

    const FactoryAbi = withOverrides(AMMFactoryAbi, {
      findExistingPoolId: {
        kind: "view",
        output: { mode: "raw", schema: { $ref: "AlkaneId" } },
      },
    });

  Every correction is an explicit, reviewable diff that survives
  regenerating the ABI. Overridden fields flow through type
  inference, so method signatures update accordingly.
──────────────────────────────────────────────────────────────*/

import { AlkabiDocument, AlkabiIoDef, AlkabiMethodDef } from "./types";

/** Per-method field replacements, keyed by method name. */
export type AlkabiOverrides<D extends AlkabiDocument> = {
  readonly [K in D["methods"][number]["name"]]?: {
    readonly kind?: AlkabiMethodDef["kind"];
    readonly input?: AlkabiIoDef;
    readonly witness?: AlkabiIoDef;
    readonly output?: AlkabiIoDef;
  };
};

type MergeMethod<M, P> = Omit<M, keyof P> & P;

type ApplyOne<M, O> = M extends { name: infer N extends string }
  ? N extends keyof O
    ? MergeMethod<M, NonNullable<O[N]>>
    : M
  : M;

export type ApplyAbiOverrides<D extends AlkabiDocument, O> = Omit<
  D,
  "methods"
> & {
  readonly methods: { readonly [I in keyof D["methods"]]: ApplyOne<D["methods"][I], O> };
};

/**
 * Return a new document with the given per-method corrections applied.
 * The input document is not modified. Overriding a method name that does
 * not exist in the document throws (catches typos and stale overrides
 * after a contract regenerates its ABI).
 */
export function withOverrides<
  const D extends AlkabiDocument,
  const O extends AlkabiOverrides<D>,
>(document: D, overrides: O): ApplyAbiOverrides<D, O> {
  const known = new Set(document.methods.map((m) => m.name));
  for (const name of Object.keys(overrides)) {
    if (!known.has(name)) {
      throw new Error(
        `alkabi: override targets unknown method "${name}" ` +
          `(document "${document.contract}" has: ${[...known].join(", ")})`,
      );
    }
  }

  return {
    ...document,
    methods: document.methods.map((method) => {
      const patch = (overrides as Record<string, object | undefined>)[
        method.name
      ];
      return patch ? { ...method, ...patch } : method;
    }),
  } as unknown as ApplyAbiOverrides<D, O>;
}
