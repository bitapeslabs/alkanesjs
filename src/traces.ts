/*
  Entry: `alkanesjs/traces` — reading what a transaction's protostones did.

  A trace is the indexer's record of one protostone's execution: a flat list
  of events in execution order (`invoke` opens a frame, `return` closes it).
  Everything here is pure decoding — bytes and JSON in, typed events out.
  Nothing talks to the network; the traces themselves come from the core
  entry (`TxOutcome.trace`, `provider.rpc.alkanes.alkanes_trace`, espo's
  `get_alkane_tx_summary`).

  Decoded events carry real values (`bigint` amounts, parsed ids); encoded
  events are espo's own JSON with every value still a `0x` hex string.
*/

export {
  decodeTrace,
  extractAbiErrorMessage,
} from "@/apis/alkanes/utils";

export { decodeTraceEvents } from "@/apis/alkanes/simtx";

export type {
  AlkanesTraceResult,
  AlkanesTraceEncodedResult,
  AlkanesTraceEncodedEvent,
  AlkanesTraceCreateEvent,
  AlkanesTraceInvokeEvent,
  AlkanesTraceReturnEvent,
} from "@/apis/alkanes/types";
