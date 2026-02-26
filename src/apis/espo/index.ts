import { Provider } from "@/provider";
import { Espo } from "./espo";

export class EspoRpcProvider extends Espo {
  constructor(providerOrUrl: Provider | string) {
    const url =
      typeof providerOrUrl === "string"
        ? providerOrUrl
        : providerOrUrl.espoUrl;

    if (!url) {
      throw new Error("EspoRpcProvider requires an Espo RPC URL (espoUrl).");
    }

    super(url);
  }
}
