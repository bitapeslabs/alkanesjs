import * as bitcoin from "bitcoinjs-lib";
import { Provider, type ProviderConfig } from "./provider";

/*
  Predefined providers for the hosted infrastructure, so connecting is one
  property access instead of a config block:

      import { networks } from "alkanesjs";
      const me = Account.fromWIF(WIF, networks.Mainnet);

  Each entry is usable two ways. Reached as a value it IS a provider —
  quiet, with the settings below. Called, it builds a fresh one with
  whatever you want changed:

      networks.Regtest                      // the provider, debug off
      networks.Regtest({ debug: 1 })        // …the same endpoints, logging on
      networks.Mainnet({ defaultFeeRate: 8 })

  Calling always makes a NEW provider and never disturbs the shared one.
*/

/** A predefined provider that is also a factory for variants of itself. */
export type NetworkProvider = Provider &
  ((overrides?: Partial<ProviderConfig>) => Provider);

function networkProvider(config: ProviderConfig): NetworkProvider {
  /*
    Built on first use rather than at import: a Provider spins up its RPC
    clients and a pacer, and a script that only ever touches one network
    should not pay for the other.
  */
  let shared: Provider | undefined;
  const base = () => (shared ??= new Provider(config));

  const make = (overrides: Partial<ProviderConfig> = {}) =>
    new Provider({ ...config, ...overrides });

  /*
    The proxy is what lets one name be both. Reads forward to the shared
    provider — methods bound to it, so `this` is the real object however the
    call is written — while calling the target builds a variant.
  */
  return new Proxy(make, {
    get(_target, prop, receiver) {
      const value = Reflect.get(base(), prop, receiver);
      return typeof value === "function" ? value.bind(base()) : value;
    },
    set(_target, prop, value) {
      return Reflect.set(base(), prop, value);
    },
    has(_target, prop) {
      return Reflect.has(base(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(base());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const d = Reflect.getOwnPropertyDescriptor(base(), prop);
      // a proxy may only report own properties of a non-extensible target as
      // non-configurable; the target here is a function, so relax it
      return d && { ...d, configurable: true };
    },
    // so `networks.Mainnet instanceof Provider` answers honestly
    getPrototypeOf() {
      return Provider.prototype;
    },
  }) as unknown as NetworkProvider;
}

export const networks = {
  /**
   * Mainnet through the hosted kirby — simulates get the wasm fast-path and
   * everything is cached per block. Drop-in: the same metashrew/alkanes
   * contract subfrost serves, just answered faster. (espo goes direct: the
   * hosted kirby only exposes /rpc.)
   */
  Mainnet: networkProvider({
    metashrewUrl: "https://kirby.alkanode.com/rpc",
    espoUrl: "https://api.alkanode.com/rpc",
    network: bitcoin.networks.bitcoin,
    defaultFeeRate: 2,
  }),

  /** The hosted regtest — same kirby + espo pair, play money, and a faucet. */
  Regtest: networkProvider({
    metashrewUrl: "https://kirby-regtest.alkanode.com/rpc",
    espoUrl: "https://regtest.espo.sh/rpc",
    network: bitcoin.networks.regtest,
    defaultFeeRate: 3,
  }),
} as const;
