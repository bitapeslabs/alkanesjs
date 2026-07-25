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

/**
 * 0 — silent. 1 — one line per outgoing request: transport, URL, the rpc
 * method(s) inside it, and how long it took. 2 — the JSON body as well.
 */
let debugLevel = 0;
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

/** Set the logging level (installs the wrapper on first enable). Booleans are
 *  accepted for old callers: `true` means the old full-body behavior (2). */
export function setFetchDebug(level: number | boolean): void {
  debugLevel = typeof level === "boolean" ? (level ? 2 : 0) : Math.max(0, level);
  if (debugLevel > 0) installFetchLogger();
}

export function isFetchDebugEnabled(): boolean {
  return debugLevel > 0;
}

export function fetchDebugLevel(): number {
  return debugLevel;
}

/**
 * Log something that isn't an HTTP request under the same switch and styling as
 * `[CALL]` — used by the contract-wasm runtime, whose host imports drive the
 * RPC rather than issuing it directly, so `provider.debug` shows what the
 * contract asked for alongside the calls that answered it.
 */
export function debugEvent(tag: string, line: string, detail?: string): void {
  if (debugLevel < 2) return;
  try {
    let out = chalk.bold.magenta(`[${tag}]`) + " " + line;
    if (detail) out += "\n" + chalk.gray(detail);
    console.log(out);
  } catch {
    /* logging must never break the caller */
  }
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

/**
 * The rpc method name(s) inside a request — `method` of a JSON-RPC body,
 * comma-joined for a batch; the URL path for plain REST calls.
 */
function rpcMethodNames(body: string, url: string): string {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      const names = parsed
        .map((e) => (e && typeof e === "object" ? String(e.method ?? "?") : "?"))
        .join(",");
      return `[${names}]`;
    }
    if (parsed && typeof parsed === "object" && parsed.method) {
      return String(parsed.method);
    }
  } catch {
    /* not JSON — fall through to the path */
  }
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function installFetchLogger(): void {
  if (installed) return;
  installed = true;

  const g = globalThis as unknown as { fetch: typeof fetch };
  const original = g.fetch.bind(globalThis);

  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (debugLevel === 0) return original(input, init);

    // gather what we can up front; logging must never break the request
    let url = "";
    let body = "";
    let http = "GET";
    try {
      url = requestUrl(input);
      body = await requestBody(input, init);
      http = (
        (init && typeof init === "object" && (init as RequestInit).method) ||
        "GET"
      ).toUpperCase();
    } catch {
      /* leave the placeholders */
    }

    const started = Date.now();
    const emit = (outcome: string) => {
      try {
        console.log(
          chalk.bold.cyan("[CALL]") +
            " " +
            chalk.dim(http) +
            " " +
            chalk.underline.blue(url) +
            " " +
            chalk.magenta(rpcMethodNames(body, url)) +
            " " +
            outcome,
        );
        if (debugLevel >= 2 && body) {
          console.log(chalk.gray(formatBody(body)));
        }
      } catch {
        /* never break the request */
      }
    };

    try {
      const response = await original(input, init);
      emit(chalk.gray(`${Date.now() - started}ms`));
      return response;
    } catch (error) {
      emit(chalk.red(`failed after ${Date.now() - started}ms`));
      throw error;
    }
  }) as typeof fetch;
}
