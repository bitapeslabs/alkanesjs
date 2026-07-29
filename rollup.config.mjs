import dts from "rollup-plugin-dts";

// `input` is where tsc emitted the declarations; `output` is the flattened
// single file the exports map points at. They differ when the specifier is
// nested (alkanesjs/utils/amm) but the artifact lives flat (dist/utils-amm.d.ts).
const flatten = (input, output = input) => ({
  input: `dist/${input}.d.ts`,
  output: {
    file: `dist/${output}.d.ts`, // flattened output
    format: "es",
  },
  plugins: [dts()],
  preserveSymlinks: true,
});

// One row per public entry — keep in step with package.json#exports and the
// entry list in esbuild.config.mjs.
export default [
  flatten("index"),
  flatten("wallets"),
  flatten("boxed"),
  flatten("traces"),
  flatten("abi"),
  flatten("debug"),
  flatten("utils/amm", "utils-amm"),
  flatten("utils/frbtc", "utils-frbtc"),
];
