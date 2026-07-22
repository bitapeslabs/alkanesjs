/*─────────────────────────────────────────────────────────────
  FETCH DEBUG LOGGING
  -----------------------------------------------------------
  Every alkanesjs transport (sandshrew jsonrpc, espo jsonrpc,
  esplora) issues its HTTP through the global `fetch`, so a single
  wrapper captures every API call. Enabled via `new Provider({
  debug: true })` or `provider.setDebug(true)`; each request is
  logged, color-coded, as:

    [CALL] <endpoint>
    <pretty-printed body>

  The wrapper is installed once and gated by a shared flag, so
  toggling debug on any provider flips logging globally. Logging
  never throws — a formatting error must not break a request.
──────────────────────────────────────────────────────────────*/

import { Chalk } from "chalk";

/**
 * Decide the color level ourselves — bundled chalk's own auto-detection is
 * unreliable (esbuild flattens its `supports-color` env/tty checks). Standard
 * conventions: NO_COLOR disables, FORCE_COLOR forces, otherwise color only when
 * stdout is a TTY.
 */
function colorLevel(): 0 | 1 | 2 | 3 {
  // Read the *real* process off globalThis — a bundled browser build may shadow
  // the `process` binding with a polyfill, but under node globalThis.process is
  // still node's own (with the true env + tty).
  const proc = (globalThis as { process?: NodeJS.Process }).process;
  const env = proc?.env;
  if (env?.NO_COLOR) return 0;
  const force = env?.FORCE_COLOR;
  if (force === "0") return 0;
  if (force !== undefined && force !== "") return 3;
  const isTty = !!proc?.stdout && proc.stdout.isTTY === true;
  return isTty ? 3 : 0;
}

const chalk = new Chalk({ level: colorLevel() });

let debugEnabled = false;
let installed = false;

/** Pretty-print a request body: indented JSON when parseable, else as-is. */
function formatBody(body: string): string {
  const trimmed = body.trim();
  if (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      /* not JSON — fall through */
    }
  }
  return body;
}

/** Turn fetch-call logging on or off (installs the wrapper on first enable). */
export function setFetchDebug(enabled: boolean): void {
  debugEnabled = enabled;
  if (enabled) installFetchLogger();
}

export function isFetchDebugEnabled(): boolean {
  return debugEnabled;
}

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

async function requestBody(input: unknown, init: unknown): Promise<string> {
  const body =
    init && typeof init === "object" && "body" in init
      ? (init as { body?: unknown }).body
      : undefined;

  if (body != null) {
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return `<${body.length} bytes>`;
    return String(body);
  }

  // A Request object may carry the body itself.
  if (input && typeof input === "object" && "clone" in input) {
    try {
      return await (input as Request).clone().text();
    } catch {
      /* not readable — fall through */
    }
  }
  return "";
}

function installFetchLogger(): void {
  if (installed) return;
  installed = true;

  const g = globalThis as unknown as { fetch: typeof fetch };
  const original = g.fetch.bind(globalThis);

  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (debugEnabled) {
      try {
        const url = requestUrl(input);
        const body = await requestBody(input, init);
        const method =
          (init && typeof init === "object" && (init as RequestInit).method) ||
          "GET";
        let line =
          chalk.bold.cyan("[CALL]") +
          " " +
          chalk.dim(method.toUpperCase()) +
          " " +
          chalk.underline.blue(url);
        if (body) {
          line += "\n" + chalk.gray(formatBody(body));
        }
        console.log(line);
      } catch {
        /* logging must never break the request */
      }
    }
    return original(input, init);
  }) as typeof fetch;
}
