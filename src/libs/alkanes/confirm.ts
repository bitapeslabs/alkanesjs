/*
  Waiting a transaction out, and what you get for waiting.

  A confirmed transaction is not a successful one — a protostone can revert
  and the transaction still mines like any other. So everything that waits
  here comes back with the TRACES: what each protostone did, whether it
  returned or reverted, and why.

  Lives in its own module because both the transaction builder and the
  deployment builder need it, and importing one from the other would close a
  cycle.
*/

import type { Provider } from "@/provider";
import { isBoxedError } from "@/boxed";
import { sleep } from "@/utils";
import { decodeTrace, extractAbiErrorMessage } from "@/apis/alkanes/utils";
import type {
  AlkanesTraceEncodedResult,
  AlkanesTraceResult,
} from "@/apis/alkanes/types";

/** What one protostone of a confirmed transaction did. */
export interface ConfirmedTrace {
  /** `txid:vout` — the shadow vout the indexer filed this trace under. */
  outpoint: string;
  /** Decoded events in execution order: `invoke` opens a frame, `return` closes it. */
  events: AlkanesTraceResult;
  /** Whether its outermost return said success. */
  ok: boolean;
  /** The revert reason, when it did not. */
  error?: string;
}

/**
 * Wait a transaction out: mined, AND indexed by espo — so anything read
 * afterwards sees what it did. Shared by every path that produces a txid,
 * whether this wallet broadcast it or the faucet did.
 */
export async function awaitConfirmed(
  provider: Provider,
  txid: string,
): Promise<void> {
  // mined…
  let height = 0;
  for (;;) {
    const tx = await provider.rpc.electrum.esplora_gettransaction(txid);
    if (!isBoxedError(tx) && tx.data.status?.confirmed) {
      height = tx.data.status.block_height ?? 0;
      break;
    }
    await sleep(2000);
  }
  // …and indexed, so a read after this sees what the transaction did
  for (;;) {
    const tip = await provider.rpc.espo.getTipHeight();
    if (!isBoxedError(tip) && tip.data.height >= height) return;
    await sleep(1000);
  }
}

/**
 * What a confirmed transaction's protostones did, as espo indexed them.
 *
 * Empty for a transaction that ran none — a plain payment, a faucet payout —
 * and empty too if espo could not summarize it, which is why `ok` means "no
 * protostone reverted" rather than "something definitely succeeded".
 */
export async function tracesOf(
  provider: Provider,
  txid: string,
): Promise<ConfirmedTrace[]> {
  const summary = await provider.rpc.espo.getAlkaneTxSummary(txid);
  if (isBoxedError(summary)) return [];

  return summary.data.traces.map(({ outpoint, events }) => {
    const decoded = decodeTrace(events as AlkanesTraceEncodedResult);
    const exit = decoded.findLast((e) => e.event === "return");
    if (exit?.event !== "return") {
      return { outpoint, events: decoded, ok: false, error: "no return event" };
    }
    if (exit.data.status === "success") {
      return { outpoint, events: decoded, ok: true };
    }
    const raw = exit.data.response.data;
    return {
      outpoint,
      events: decoded,
      ok: false,
      error: extractAbiErrorMessage(raw) ?? raw,
    };
  });
}

/**
 * A broadcast transaction — what awaiting a `SentTx` resolves to. Carries the
 * txid and the waiter, so the handle survives the await:
 *
 *     const sent = await tx.build().send();
 *     console.log(sent.txid);
 *     const confirmed = await sent.waitForConfirmation();
 *
 * Prints and serializes as its txid (`` `sent ${sent}` ``, `JSON.stringify`),
 * so anywhere a txid string was expected for display still reads right.
 */
export class Sent {
  constructor(
    readonly txid: string,
    protected readonly provider: Provider,
  ) {}

  /**
   * Resolves once the transaction is mined AND espo has indexed its block —
   * to a `Confirmed`, which is this same transaction plus what its
   * protostones did.
   */
  async waitForConfirmation(): Promise<Confirmed> {
    await awaitConfirmed(this.provider, this.txid);
    return new Confirmed(this.txid, this.provider, await tracesOf(this.provider, this.txid));
  }

  toString(): string {
    return this.txid;
  }
  toJSON(): string {
    return this.txid;
  }
}

/**
 * A transaction that has been mined and indexed, with its traces read back.
 *
 *     const done = await tx.build().send().waitForConfirmation();
 *     done.txid;
 *     done.ok;                       // did every protostone return?
 *     done.error;                    // …and if not, why not
 *     for (const t of done.traces) console.log(t.outpoint, t.events);
 *
 * `ok` is true when nothing reverted — a transaction that ran no protostones
 * at all has no traces and reads as ok, which for a plain payment is right.
 */
export class Confirmed extends Sent {
  constructor(
    txid: string,
    provider: Provider,
    /** One entry per protostone that ran, in the order espo filed them. */
    readonly traces: ConfirmedTrace[],
  ) {
    super(txid, provider);
  }

  /** True when no protostone reverted. */
  get ok(): boolean {
    return this.traces.every((t) => t.ok);
  }

  /** The first revert reason, if any protostone failed. */
  get error(): string | undefined {
    return this.traces.find((t) => !t.ok)?.error;
  }

  /** Already confirmed — resolves to itself rather than waiting again. */
  override async waitForConfirmation(): Promise<Confirmed> {
    return this;
  }
}
