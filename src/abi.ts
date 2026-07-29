/*
  Entry: `alkanesjs/abi` — working with alkabi documents themselves.

  The `Contract` class (core entry) is how you CALL a contract through its
  ABI. This entry is for the layer underneath: the document format, shaping
  a generated document before use, and executing a view against raw wasm
  without any chain at all.

    withOverrides         adjust a generated document without editing it —
                          generated ABIs are authoritative; overrides are how
                          local corrections stay separate from codegen output
    borshSchemaFromAlkabi rebuild a runtime borsh schema from document JSON
    runWasmView           run one view call inside a local wasm instance
    bytesToHex/hexToBytes the byte plumbing those two speak
*/

/* the document format */
export type {
  AlkabiDocument,
  AlkabiMethodDef,
  AlkabiIoDef,
  AlkabiIoMode,
  AlkabiSchemaDef,
  AlkabiPrimitive,
  AlkabiTypes,
} from "@/libs/alkabi/types";

/* shaping documents */
export { withOverrides } from "@/libs/alkabi/overrides";
export type { AlkabiOverrides, ApplyAbiOverrides } from "@/libs/alkabi/overrides";

/* borsh schemas from document JSON */
export { borshSchemaFromAlkabi, buildBorshSchema } from "@/libs/alkabi/runtime";

/* local wasm execution */
export {
  runWasmView,
  bytesToHex,
  hexToBytes,
  PLACEHOLDER_HEIGHT,
  ContractRevertError,
  UnrunnableViewError,
} from "@/libs/alkabi/wasm-runtime";
export type {
  WasmViewOptions,
  WasmAlkaneId,
  StorageFetcher,
} from "@/libs/alkabi/wasm-runtime";
