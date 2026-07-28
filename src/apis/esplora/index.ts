/*
  The esplora-shaped reads and writes, served by espo.

  `metashrewUrl` guarantees only the `metashrew_*`/`alkanes_*` contract — a
  bare metashrew has no fee or broadcast surface at all. espo does, behind
  its `btc.*` namespace: `btc.fee_estimates` reads the live mempool,
  `btc.broadcast_transaction` hands the bytes to electrum with a Bitcoin
  Core fallback, and `btc.get_transaction` answers in the electrs/esplora
  shape, mempool included. So everything the old REST client did rides
  `espoUrl` now, and `metashrewUrl` is for simulates.

  Only what the SDK actually uses lives here: fee estimation for the builder,
  broadcasting for `execute`, and transaction lookup for confirmation polling.
  Address utxos are espo's job too (`essentials.get_address_spendable_outpoints`),
  which knows the mempool and the alkanes on each outpoint.
*/
import { BoxedError, BoxedSuccess, BoxedResponse } from "@/boxed";
import { EsploraFetchError, IEsploraTransaction } from "./types";
import { Provider } from "@/provider";

export class ElectrumApiProvider {
  constructor(private readonly provider: Provider) {}

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const url = this.provider.espoUrl;
    if (!url) {
      throw new Error(`${method}: this provider has no espoUrl to ask`);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? `${method} failed`);
    return json.result as T;
  }

  /** The fastest fee tier, in sat/vB, off espo's live mempool. */
  async esplora_getfee(): Promise<BoxedResponse<number, EsploraFetchError>> {
    try {
      const estimates = await this.rpc<{ fastestFee?: number }>(
        "btc.fee_estimates",
        {},
      );
      if (estimates.fastestFee === undefined) {
        return new BoxedError(
          "fee_estimates: no fastestFee in response",
          EsploraFetchError.UnknownError,
        );
      }
      return new BoxedSuccess(Number(estimates.fastestFee));
    } catch (error) {
      return new BoxedError(
        `Failed to fetch fee estimates: ${(error as Error).message}`,
        EsploraFetchError.UnknownError,
      );
    }
  }

  /** Broadcast a signed transaction; resolves to its txid. */
  async esplora_broadcastTx(
    rawTransactionHex: string,
  ): Promise<BoxedResponse<string, EsploraFetchError>> {
    try {
      const { txid } = await this.rpc<{ txid: string }>(
        "btc.broadcast_transaction",
        [rawTransactionHex],
      );
      return new BoxedSuccess(txid);
    } catch (error) {
      return new BoxedError(
        `Failed to broadcast transaction: ${(error as Error).message}`,
        EsploraFetchError.UnknownError,
      );
    }
  }

  /*
    `btc.get_transaction` answers `{ ok, found, tx, hex }` — the tx in the
    electrs/esplora JSON shape, mempool as well as confirmed, with `found:
    false` (not an error) for a transaction the index has never seen.
    Confirmation polling reads `tx.status.confirmed`.
  */
  async esplora_gettransaction(
    transactionId: string,
  ): Promise<BoxedResponse<IEsploraTransaction, EsploraFetchError>> {
    try {
      const r = await this.rpc<{ found?: boolean; tx?: IEsploraTransaction }>(
        "btc.get_transaction",
        { txid: transactionId },
      );
      if (!r.tx) {
        return new BoxedError(
          `transaction ${transactionId} not found`,
          EsploraFetchError.UnknownError,
        );
      }
      return new BoxedSuccess(r.tx);
    } catch (error) {
      return new BoxedError(
        `Failed to fetch transaction ${transactionId}: ${(error as Error).message}`,
        EsploraFetchError.UnknownError,
      );
    }
  }

  async esplora_getrawtransaction(
    transactionId: string,
  ): Promise<BoxedResponse<string, EsploraFetchError>> {
    try {
      const r = await this.rpc<{ hex?: string }>("btc.get_transaction", {
        txid: transactionId,
      });
      if (!r.hex) {
        return new BoxedError(
          `transaction ${transactionId} not found`,
          EsploraFetchError.UnknownError,
        );
      }
      return new BoxedSuccess(r.hex);
    } catch (error) {
      return new BoxedError(
        `Failed to fetch raw transaction ${transactionId}: ${(error as Error).message}`,
        EsploraFetchError.UnknownError,
      );
    }
  }
}

export * from "./types";
