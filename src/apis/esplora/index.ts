import { BoxedError, BoxedSuccess, BoxedResponse, isBoxedError } from "@/boxed";
import {
  EsploraAddressResponse,
  EsploraFetchError,
  EsploraUtxo,
  IEsploraSpendableUtxo,
  IEsploraTransaction,
} from "./types";
import { satsToBTC, getEsploraTransactionWithHex } from "@/crypto/utils";
import { Provider } from "@/provider";
import { consumeAll } from "@/boxed";

export class ElectrumApiProvider {
  constructor(private readonly provider: Provider) {}

  private get electrumApiUrl(): string {
    return this.provider.electrumApiUrl.replace(/\/+$/, "");
  }

  async esplora_getaddress(
    address: string,
  ): Promise<BoxedResponse<EsploraAddressResponse, EsploraFetchError>> {
    try {
      const requestUrl = `${this.electrumApiUrl}/address/${address}`;
      const httpResponse = await fetch(requestUrl);

      if (!httpResponse.ok) {
        return new BoxedError(`Failed to fetch address data from ${requestUrl}: ${httpResponse.statusText}`, EsploraFetchError.UnknownError);
      }

      const json = (await httpResponse.json()) as EsploraAddressResponse;
      return new BoxedSuccess(json);
    } catch (error) {
      return new BoxedError(`Failed to fetch address data: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }

  async esplora_getaddressbalance(
    address: string,
  ): Promise<BoxedResponse<number, EsploraFetchError>> {
    const addressResponse = await this.esplora_getaddress(address);
    if (isBoxedError(addressResponse)) return addressResponse;

    const { funded_txo_sum, spent_txo_sum } = addressResponse.data.chain_stats;
    const satoshiBalance = funded_txo_sum - spent_txo_sum;

    return new BoxedSuccess(satsToBTC(satoshiBalance));
  }

  async esplora_getutxos(
    address: string,
  ): Promise<BoxedResponse<EsploraUtxo[], EsploraFetchError>> {
    try {
      const requestUrl = `${this.electrumApiUrl}/address/${address}/utxo`;
      const httpResponse = await fetch(requestUrl);

      if (!httpResponse.ok) {
        return new BoxedError(`Failed to fetch UTXOs from ${requestUrl}: ${httpResponse.statusText}`, EsploraFetchError.UnknownError);
      }

      const utxos = (await httpResponse.json()) as EsploraUtxo[];
      const confirmedUtxos = utxos.filter((utxo) => utxo.status.confirmed);

      return new BoxedSuccess(confirmedUtxos);
    } catch (error) {
      return new BoxedError(`Failed to fetch UTXOs: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }
  async esplora_getfee(): Promise<BoxedResponse<number, EsploraFetchError>> {
    try {
      const requestUrl = `${this.electrumApiUrl}/fee-estimates`;
      const httpResponse = await fetch(requestUrl);

      if (!httpResponse.ok) {
        return new BoxedError(`Failed to fetch fee estimates from ${requestUrl}: ${httpResponse.statusText}`, EsploraFetchError.UnknownError);
      }

      const estimates = await httpResponse.json();
      const fastestFee = estimates["1"];

      if (fastestFee === undefined) {
        return new BoxedError(`Fee tier "1" not available in response`, EsploraFetchError.UnknownError);
      }

      return new BoxedSuccess(Number(fastestFee));
    } catch (error) {
      return new BoxedError(`Failed to fetch fee estimates: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }

  async esplora_broadcastTx(
    rawTransactionHex: string,
    customElectrumUrl?: string,
  ): Promise<BoxedResponse<string, EsploraFetchError>> {
    try {
      const baseUrl = (customElectrumUrl ?? this.electrumApiUrl).replace(
        /\/+$/,
        "",
      );
      const requestUrl = `${baseUrl}/tx`;

      const httpResponse = await fetch(requestUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: rawTransactionHex,
      });

      if (!httpResponse.ok) {
        const errorMessage = await httpResponse.text();
        return new BoxedError(`Failed to broadcast transaction: ${errorMessage}`, EsploraFetchError.UnknownError);
      }

      const transactionId = (await httpResponse.text()).trim();
      return new BoxedSuccess(transactionId);
    } catch (error) {
      return new BoxedError(`Failed to broadcast transaction: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }

  async esplora_getaddresstxs(
    address: string,
    lastSeenTransactionId?: string,
  ): Promise<BoxedResponse<IEsploraTransaction[], EsploraFetchError>> {
    try {
      const basePath = `${this.electrumApiUrl}/address/${address}/txs`;
      const requestUrl = lastSeenTransactionId
        ? `${basePath}/chain/${lastSeenTransactionId}`
        : basePath;

      const httpResponse = await fetch(requestUrl);
      if (!httpResponse.ok) {
        return new BoxedError(`Failed to fetch transactions from ${requestUrl}: ${httpResponse.statusText}`, EsploraFetchError.UnknownError);
      }

      const transactions = (await httpResponse.json()) as IEsploraTransaction[];
      return new BoxedSuccess(transactions);
    } catch (error) {
      return new BoxedError(`Failed to fetch address transactions: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }

  async esplora_getbulktransactions(
    transactionIds: string[],
  ): Promise<BoxedResponse<IEsploraTransaction[], EsploraFetchError>> {
    try {
      const requestUrl = `${this.electrumApiUrl}/txs`;

      const httpResponse = await fetch(requestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txs: transactionIds }),
      });

      if (!httpResponse.ok) {
        return new BoxedError(`Failed to fetch transactions from ${requestUrl}: ${httpResponse.statusText}`, EsploraFetchError.UnknownError);
      }

      const transactions = (await httpResponse.json()) as IEsploraTransaction[];
      return new BoxedSuccess(transactions);

      const txs = await Promise.all(
        transactionIds.map((txid) => this.esplora_gettransaction(txid)),
      );
    } catch (error) {
      return new BoxedError(`Failed to fetch bulk transactions: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }
  async esplora_getblocktiphash(): Promise<
    BoxedResponse<string, EsploraFetchError>
  > {
    try {
      const requestUrl = `${this.electrumApiUrl}/blocks/tip/hash`;
      const httpResponse = await fetch(requestUrl);

      if (!httpResponse.ok) {
        return new BoxedError(`Failed to fetch tip hash from ${requestUrl}: ${httpResponse.statusText}`, EsploraFetchError.UnknownError);
      }

      const tipHash = (await httpResponse.text()).trim();
      return new BoxedSuccess(tipHash);
    } catch (error) {
      return new BoxedError(`Failed to fetch tip hash: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }

  async esplora_getblocktipheight(): Promise<
    BoxedResponse<number, EsploraFetchError>
  > {
    try {
      const requestUrl = `${this.electrumApiUrl}/blocks/tip/height`;
      const httpResponse = await fetch(requestUrl);

      if (!httpResponse.ok) {
        return new BoxedError(`Failed to fetch tip height from ${requestUrl}: ${httpResponse.statusText}`, EsploraFetchError.UnknownError);
      }

      const height = Number((await httpResponse.text()).trim());
      if (!Number.isFinite(height)) {
        return new BoxedError("Tip height response was not a number", EsploraFetchError.UnknownError);
      }
      return new BoxedSuccess(height);
    } catch (error) {
      return new BoxedError(`Failed to fetch tip height: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }
  async _esplora_getrawblock(
    blockHash: string,
  ): Promise<BoxedResponse<string, EsploraFetchError>> {
    try {
      const requestUrl = `${this.electrumApiUrl}/block/${blockHash}/raw`;
      const httpResponse = await fetch(requestUrl);

      if (!httpResponse.ok) {
        return new BoxedError(`Failed to fetch raw block ${blockHash} from ${requestUrl}: ${httpResponse.statusText}`, EsploraFetchError.UnknownError);
      }

      // ── convert ArrayBuffer → Uint8Array → hex string ────────────────────
      const bytes = new Uint8Array(await httpResponse.arrayBuffer());
      const rawHex = Array.from(bytes, (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");

      return new BoxedSuccess("0x" + rawHex);
    } catch (error) {
      return new BoxedError(`Failed to fetch raw block ${blockHash}: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }

  async esplora_getrawblocktip(): Promise<
    BoxedResponse<string, EsploraFetchError>
  > {
    const tipHashResponse = await this.esplora_getblocktiphash();
    if (isBoxedError(tipHashResponse)) return tipHashResponse;

    return this._esplora_getrawblock(tipHashResponse.data);
  }
  /*
  async esplora_getbulktransactions(
    transactionIds: string[],
  ): Promise<BoxedResponse<IEsploraTransaction[], EsploraFetchError>> {
    try {
      const allTxs: IEsploraTransaction[] = [];

      // ‑‑ process in batches of 10 ------------------------------------------------
      for (let i = 0; i < transactionIds.length; i += 10) {
        const batch = transactionIds.slice(i, i + 10);

        // run the 10 requests in parallel
        const batchResponses = await Promise.all(
          batch.map((txid) => this.esplora_gettransaction(txid)),
        );


        const batchTxs = consumeAll(batchResponses); // IEsploraTransaction[]
        allTxs.push(...batchTxs);
      }

      return new BoxedSuccess(allTxs);
    } catch (error) {
      // if consumeAll returns/throws a BoxedError we land here ⬇
      if (error instanceof BoxedError) {
        return error;
      }

      return new BoxedError(`Failed to fetch bulk transactions: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }
  */
  async esplora_gettransaction(
    transactionId: string,
  ): Promise<BoxedResponse<IEsploraTransaction, EsploraFetchError>> {
    try {
      const requestUrl = `${this.electrumApiUrl}/tx/${transactionId}`;
      const httpResponse = await fetch(requestUrl);

      if (!httpResponse.ok) {
        return new BoxedError(`Failed to fetch transaction ${transactionId} from ${requestUrl}: ${httpResponse.statusText}`, EsploraFetchError.UnknownError);
      }

      const transaction = (await httpResponse.json()) as IEsploraTransaction;
      return new BoxedSuccess(transaction);
    } catch (error) {
      return new BoxedError(`Failed to fetch transaction ${transactionId}: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }

  async esplora_getrawtransaction(
    transactionId: string,
  ): Promise<BoxedResponse<string, EsploraFetchError>> {
    try {
      const requestUrl = `${this.electrumApiUrl}/tx/${transactionId}/hex`;
      const httpResponse = await fetch(requestUrl);

      if (!httpResponse.ok) {
        return new BoxedError(`Failed to fetch raw transaction ${transactionId} from ${requestUrl}: ${httpResponse.statusText}`, EsploraFetchError.UnknownError);
      }

      const rawHex = await httpResponse.text();
      return new BoxedSuccess(rawHex);
    } catch (error) {
      return new BoxedError(`Failed to fetch raw transaction ${transactionId}: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }

  async esplora_getspendableinputs(
    utxoList: EsploraUtxo[],
  ): Promise<BoxedResponse<IEsploraSpendableUtxo[], EsploraFetchError>> {
    const bulkResponse = await this.esplora_getbulktransactions(
      utxoList.map((input) => input.txid),
    );
    if (isBoxedError(bulkResponse)) return bulkResponse;

    const transactionMap = new Map(
      bulkResponse.data.map((tx) => [tx.txid, tx]),
    );

    const spendableInputs: IEsploraSpendableUtxo[] = [];

    for (const unspentOutput of utxoList) {
      const fullTransaction = transactionMap.get(unspentOutput.txid);
      if (!fullTransaction) {
        return new BoxedError(`Transaction not found for txid ${unspentOutput.txid}`, EsploraFetchError.UnknownError);
      }
      spendableInputs.push({
        ...unspentOutput,
        prevTx: getEsploraTransactionWithHex(fullTransaction),
      });
    }
    return new BoxedSuccess(spendableInputs);
  }

  esplora_getutxofromparenttx(
    transaction: IEsploraTransaction,
    voutIndex: number,
  ): BoxedResponse<EsploraUtxo, EsploraFetchError> {
    const output = transaction.vout[voutIndex];
    if (!output) {
      return new BoxedError(`Vout index ${voutIndex} not found in transaction ${transaction.txid}`, EsploraFetchError.UnknownError);
    }

    return new BoxedSuccess({
      txid: transaction.txid,
      vout: voutIndex,
      value: output.value,
      status: transaction.status,
    } as EsploraUtxo);
  }

  async esplora_getutxo(
    utxoString: string,
  ): Promise<BoxedResponse<EsploraUtxo, EsploraFetchError>> {
    try {
      if (!utxoString || !utxoString.includes(":")) {
        return new BoxedError(`Invalid UTXO format: ${utxoString}. Expected format is "txid:vout".`, EsploraFetchError.UnknownError);
      }

      const [transactionId, voutString] = utxoString.split(":");
      const transactionResponse =
        await this.esplora_gettransaction(transactionId);
      if (isBoxedError(transactionResponse)) return transactionResponse;

      const voutIndex = Number(voutString);
      return this.esplora_getutxofromparenttx(
        transactionResponse.data,
        voutIndex,
      );
    } catch (error) {
      return new BoxedError(`Failed to get UTXO: ${(error as Error).message}`, EsploraFetchError.UnknownError);
    }
  }
}

export * from "./types";
