# `alkanesjs/abi` — alkabi documents

```ts
import { withOverrides, runWasmView, bytesToHex } from "alkanesjs/abi";
import type { AlkabiDocument } from "alkanesjs/abi";
```

An **alkabi document** is the JSON ABI a contract's build emits: methods with
opcodes, input/output shapes (borsh, legacy u128 words, or raw), and the
named types they reference. The core entry's `Contract` consumes documents;
this entry is for working with the documents *themselves*.

## The document format

```ts
const MyTokenAbi = {
  alkabi: "1",
  contract: "my_token",
  types: {
    SchemaAlkaneId: { struct: { block: "u32", tx: "u64" } },
  },
  methods: [
    { name: "initialize", opcode: 0, kind: "execute",
      input: { mode: "borsh", schema: { $ref: "SchemaInitParams" } } },
    { name: "getOwner", opcode: 105, kind: "view",
      output: { mode: "borsh", schema: { $ref: "SchemaAlkaneId" } } },
    { name: "getTotalSupply", opcode: 101, kind: "view",
      output: { mode: "raw", schema: "u128" } },
  ],
} as const;   // ← the `as const` is what makes Contract fully typed
```

- `mode: "borsh"` — bytes are borsh; on the wire they ride 16-byte LE words,
  zero-padded, decoded tolerantly (trailing pad bytes are left unread).
- `mode: "legacy"` — positional u128 words, the pre-borsh convention.
- `mode: "raw"` — contiguous LE bytes, for bespoke layouts.

Generated documents are authoritative — never hand-edit one. When a document
needs correcting locally, override it:

## `withOverrides`

```ts
import { withOverrides } from "alkanesjs/abi";

const FixedAbi = withOverrides(GeneratedAbi, {
  findExistingPoolId: {
    output: { mode: "raw", schema: { struct: { block: "u128", tx: "u128" } } },
  },
});
```

The override is type-checked against the document, applied without mutating
it, and — because it is code, not an edit — survives regeneration and shows
its own diff.

## `runWasmView` — views without a chain

Execute one view call inside a local WebAssembly instance of the contract:
no endpoint, no deployment, storage served by a callback.

```ts
import { runWasmView, bytesToHex } from "alkanesjs/abi";

const answer = await runWasmView({
  wasm,                                  // Uint8Array or WebAssembly.Module
  alkaneId: { block: 2n, tx: 1n },       // who the contract believes it is
  opcode: 105n,
  words: [],                             // calldata after the opcode
  fetchStorage: async (key) => storage.get(bytesToHex(key)),
});
```

Reverts throw `ContractRevertError` (with the contract's reason); a view
that needs chain context the runner cannot supply throws
`UnrunnableViewError`. This is the machinery behind server-side simulate
fast-paths and ABI-conformance tests — comparing a local run against a
`Contract` view catches a stale document before production does.

## Borsh schemas from documents

```ts
import { borshSchemaFromAlkabi } from "alkanesjs/abi";

const schema = borshSchemaFromAlkabi(abiDoc, { $ref: "SchemaAlkaneId" });
```

Rebuilds a runtime borsher schema from document JSON, resolving `$ref`s
against the document's `types`. Field order is preserved — borsh order is
wire-significant.
