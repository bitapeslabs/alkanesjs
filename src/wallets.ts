/*
  Standalone entrypoint for the browser wallet connectors. Contains no
  bitcoinjs-lib / native-module code, so UI packages (eg alkanesjs-react) can
  import wallet connect functionality without dragging the full library —
  and its node-only dependency graph — into an SSR bundle.
*/
export * from "./browser-wallets";
