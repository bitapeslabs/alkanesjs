// esbuild.config.mjs -----------------------------------------------------------
import { build } from "esbuild";
import { execSync } from "child_process";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module"; // <-- needed for require.resolve in ESM

import * as acorn from "acorn";
import * as walk from "acorn-walk";
import MagicString from "magic-string";

// Polyfill helpers
import { NodeGlobalsPolyfillPlugin } from "@esbuild-plugins/node-globals-polyfill";
import { NodeModulesPolyfillPlugin } from "@esbuild-plugins/node-modules-polyfill";

// We need a CommonJS-style resolver for the helper shim path
const require = createRequire(import.meta.url);
const stdlibShim = require.resolve("node-stdlib-browser/helpers/esbuild/shim");
// Optionally shrink bundle: pick a lighter path polyfill
const pathBrowserify = require.resolve("path-browserify");

/*──────────────────────────────────────────────────────────────*
 | CLI build mode parsing                                        |
 *──────────────────────────────────────────────────────────────*/
const args = process.argv.slice(2);
const wantNode = args.includes("--node") || !args.includes("--browser");
const wantBrowser = args.includes("--browser") || !args.includes("--node");

/*──────────────────────────────────────────────────────────────*
 | 1.  Clean dist                                                |
 *──────────────────────────────────────────────────────────────*/
const distDir = path.resolve("dist");
if (fs.existsSync(distDir))
  fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

/*──────────────────────────────────────────────────────────────*
 | 2.  Generate .d.ts & rewrite aliases                          |
 *──────────────────────────────────────────────────────────────*/
execSync("tsc --emitDeclarationOnly --declaration --outDir dist", {
  stdio: "inherit",
});
execSync("tsc-alias -p tsconfig.json", { stdio: "inherit" });

/*──────────────────────────────────────────────────────────────*
 | 3.  Rollup type-only entrypoints (if any)                     |
 *──────────────────────────────────────────────────────────────*/
execSync("rollup -c rollup.config.mjs", { stdio: "inherit" });

/*──────────────────────────────────────────────────────────────*
 | 4.  Prune stray d.ts / subdirs                               |
 *──────────────────────────────────────────────────────────────*/
fs.readdirSync(distDir, { withFileTypes: true }).forEach((entry) => {
  const fullPath = path.join(distDir, entry.name);
  if (entry.isDirectory()) {
    fs.rmSync(fullPath, { recursive: true, force: true });
  } else if (
    entry.name !== "index.d.ts" &&
    entry.name !== "wallets.d.ts" &&
    entry.name.endsWith(".d.ts")
  ) {
    fs.rmSync(fullPath);
  }
});

/*──────────────────────────────────────────────────────────────*
 | 5.  Custom remove -0 plugin                                   |
 *──────────────────────────────────────────────────────────────*/
const removeNegZeroPlugin = {
  name: "remove-negative-zero",
  setup(buildCtx) {
    buildCtx.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
      const code = await readFile(args.path, "utf8");
      if (!code.includes("-0"))
        return { contents: code, loader: pickLoader(args.path) };

      const ms = new MagicString(code);
      const ast = acorn.parse(code, {
        ecmaVersion: "latest",
        sourceType: "module",
      });
      walk.simple(ast, {
        UnaryExpression(node) {
          if (
            node.operator === "-" &&
            node.argument.type === "Literal" &&
            node.argument.value === 0
          ) {
            ms.overwrite(node.start, node.end, "0");
          }
        },
      });
      return { contents: ms.toString(), loader: pickLoader(args.path) };
    });
  },
};

/*──────────────────────────────────────────────────────────────*
 | Utility: pick loader                                          |
 *──────────────────────────────────────────────────────────────*/
function pickLoader(file) {
  return file.endsWith(".ts") || file.endsWith(".mts")
    ? "ts"
    : file.endsWith(".cts")
      ? "cts"
      : "js";
}

/*──────────────────────────────────────────────────────────────*
 | Build configs                                                 |
 *──────────────────────────────────────────────────────────────*/
async function buildNodeCJS() {
  return build({
    entryPoints: ["src/index.ts"],
    outfile: path.join(distDir, "index.js"),
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    sourcemap: true,
    plugins: [removeNegZeroPlugin],
  });
}

async function buildBrowserESM() {
  return build({
    entryPoints: ["src/index.ts"],
    outfile: path.join(distDir, "index.browser.mjs"),
    bundle: true,
    platform: "browser",
    target: ["es2020"],
    format: "esm",
    sourcemap: true,
    mainFields: ["browser", "module", "main"],
    conditions: ["browser", "import", "default"],
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV || "production",
      ),
      global: "globalThis",
    },
    inject: [stdlibShim], // injects process & Buffer globals from node-stdlib-browser
    plugins: [
      // Alias just 'path' to smaller browser shim (optional but nice)
      {
        name: "alias-path-browserify",
        setup(buildCtx) {
          buildCtx.onResolve({ filter: /^path$/ }, () => ({
            path: pathBrowserify,
          }));
        },
      },
      NodeGlobalsPolyfillPlugin({
        process: true,
        buffer: true,
      }),
      NodeModulesPolyfillPlugin(),
      removeNegZeroPlugin,
    ],
    treeShaking: true,
    minify: false, // flip for prod if desired
  });
}

/*──────────────────────────────────────────────────────────────*
 | Wallet connectors entry — pure DOM code with no node deps, so |
 | it bundles the same for every platform. Ships as CJS + ESM.   |
 *──────────────────────────────────────────────────────────────*/
async function buildWallets(format, outfile) {
  return build({
    entryPoints: ["src/wallets.ts"],
    outfile: path.join(distDir, outfile),
    bundle: true,
    platform: "neutral",
    target: ["es2020"],
    format,
    sourcemap: true,
    plugins: [removeNegZeroPlugin],
  });
}

/*──────────────────────────────────────────────────────────────*
 | Run builds                                                    |
 *──────────────────────────────────────────────────────────────*/
if (wantNode) {
  console.log("→ Building Node (CJS) bundle…");
  await buildNodeCJS();
  await buildWallets("cjs", "wallets.js");
}
if (wantBrowser) {
  console.log("→ Building Browser (ESM) bundle…");
  await buildBrowserESM();
  await buildWallets("esm", "wallets.mjs");
}
console.log("✓ Done.");
