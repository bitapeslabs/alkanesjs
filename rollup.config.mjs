import dts from "rollup-plugin-dts";

const flatten = (entry) => ({
  input: `dist/${entry}.d.ts`,
  output: {
    file: `dist/${entry}.d.ts`, // flattened output
    format: "es",
  },
  plugins: [dts()],
  preserveSymlinks: true,
});

export default [flatten("index"), flatten("wallets")];
