/*
  Entry: `alkanesjs/abis` — ABI documents for widely-deployed contracts.

  These are alkabi-generated documents shipped as a convenience, so common
  integrations don't start with an extraction step:

    OylAMMAbi       the Oyl AMM factory (the router)
    OylAMMPoolAbi   one Oyl AMM pool
    FrBTCAbi        frBTC, the synthetic-BTC alkane
    TokenAbi        the plain mintable-token interface most tokens speak

  Documents only — no ids. Which deployment you talk to is always yours to
  say (`new Contract(FrBTCAbi, id, provider)`), which is what keeps these
  data rather than bindings. Each file is generated output; never hand-edit
  one — regenerate from the wasm, or correct at the consuming end with
  `withOverrides` (alkanesjs/abi).
*/

export { OylAMMAbi } from "./oyl-amm";
export { OylAMMPoolAbi } from "./oyl-amm-pool";
export { FrBTCAbi } from "./frbtc";
export { TokenAbi } from "./token";
