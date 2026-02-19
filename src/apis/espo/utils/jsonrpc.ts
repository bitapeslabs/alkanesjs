import { string, z } from "zod";
import { BoxedResponse, Err, Ok } from "bxrs";
/*
  These error types are to be propagated throughout the backend. Every consumer of a function that returns
  a BoxedResponse needs to properly handle the consumed functions error types. This pattern is one of the
  hardcoded rules of our code structure design patterns, this MUST be followed.
*/

/** Represents just the error shape (status: false) */

type IJsonRpcErrorMember = {
  code: number;
  message: string;
  data?: unknown;
};

export interface IJsonRpcError {
  jsonrpc: "2.0";
  error: IJsonRpcErrorMember;
  id: string | number | null;
}

/** Represents just the success shape (status: true) */
export interface IJsonRpcSuccess<T> {
  jsonrpc: "2.0";
  result: T;
  id: string | number | null;
}

/** A union that can be either an error or a success */
export type IJsonRpcResponse<T> = IJsonRpcSuccess<T> | IJsonRpcError; //C represents available error codes

/** A class implementing the error shape */
export class JsonRpcError implements IJsonRpcError {
  public jsonrpc: "2.0" = "2.0";
  public error: IJsonRpcErrorMember;
  public id: string | number | null;

  constructor(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown
  ) {
    this.error = {
      code,
      message,
      data,
    };
    this.id = id;
  }
}

/** A class implementing the success shape */
export class JsonRpcSuccess<T> implements IJsonRpcSuccess<T> {
  public jsonrpc: "2.0" = "2.0";
  public result: T;
  public id: string | number | null;

  constructor(result: T, id: string | number | null) {
    this.result = result;
    this.id = id;
  }
}

/**
 * Type guard checking if a BoxedResponse is a BoxedError
 */
export function isJsonRpcError<T>(
  response: IJsonRpcResponse<T>
): response is IJsonRpcError {
  return !!(response as IJsonRpcError)?.error as boolean;
}

export const JsonRpcAcceptedParamsSchema = z.union([
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
  z.undefined(),
  z.string(),
  z.number(),
  z.null(),
]);

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"), // Must be exactly "2.0"
  method: z.string(), // Method name (string)
  params: JsonRpcAcceptedParamsSchema.optional(), // Optional params (array or object)

  id: z.union([
    // Required id (string, number, or null)
    z.string(),
    z.number(),
    z.null(),
  ]),
});

export type IJsonUnsafeParams = z.infer<typeof JsonRpcAcceptedParamsSchema>;

// Infer the TypeScript type from the schema too (for free!)
export type IJsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export type IBaseJsonRpcCall = {
  url: string;
  method: string;
  params: unknown[] | Record<string, unknown>;
};

const rpcCallSingle = async <T>(
  url: string,
  method: string,
  params: unknown[]
): Promise<BoxedResponse<T, string>> => {
  let httpResponse, rpcResponse: IJsonRpcResponse<T>;
  try {
    httpResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id: 1,
      }),
    });
    rpcResponse = (await httpResponse.json()) as IJsonRpcResponse<T>;
  } catch (err) {
    return Err(`Fetch Error: ${(err as Error).message}`);
  }

  if (isJsonRpcError(rpcResponse)) {
    return Err(
      `RPC Error ${rpcResponse.error.code}: ${rpcResponse.error.message}`
    );
  }

  return Ok(rpcResponse.result);
};

export type IJsonRpcBatchResponse<T> = IJsonRpcSuccess<T> | IJsonRpcError;
interface IJsonRpcBatchItem {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

export async function rpcCallBatch<
  Calls extends readonly JsonRpcInteraction<any>[]
>(
  url: string,
  calls: Calls
): Promise<{
  [K in keyof Calls]: BoxedResponse<InferInteraction<Calls[K]>, string>;
}> {
  // Assign stable ids and remember index -> id and id -> index
  const idByIndex = new Map<number, number>();
  const indexById = new Map<number, number>();

  const batch: IJsonRpcBatchItem[] = calls.map((c, idx) => {
    const id = idx + 1; // any stable unique mapping
    idByIndex.set(idx, id);
    indexById.set(id, idx);
    return {
      jsonrpc: "2.0",
      id,
      method: c.method,
      // only include params if provided (JSON-RPC allows omission)
      ...(c.params !== undefined ? { params: c.params } : {}),
    };
  });

  // If there are no calls, short-circuit
  if (batch.length === 0) {
    return [] as unknown as {
      [K in keyof Calls]: BoxedResponse<InferInteraction<Calls[K]>, string>;
    };
  }

  let httpResponse: Response;
  try {
    httpResponse = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
  } catch (err) {
    // If the network request failed, return Err for each call
    const e = `Fetch Error: ${(err as Error).message}`;
    return calls.map(() => Err(e)) as any;
  }

  let raw: unknown;
  try {
    raw = await httpResponse.json();
  } catch (err) {
    const e = `Fetch Error: ${(err as Error).message}`;
    return calls.map(() => Err(e)) as any;
  }
  if (!Array.isArray(raw)) {
    // Server didn’t return an array for a batch request
    const e =
      "RPC Error: non-array batch response. Got: " + JSON.stringify(raw);
    return calls.map(() => Err(e)) as any;
  }

  // Prepare results array seeded with Errs (in case something is missing)
  const results: BoxedResponse<any, string>[] = calls.map(() =>
    Err("RPC Error: missing response for call")
  );

  // Place each response into the correct index
  for (const r of raw as IJsonRpcBatchResponse<unknown>[]) {
    if (
      !r ||
      typeof r !== "object" ||
      !("jsonrpc" in r) ||
      (r as any).jsonrpc !== "2.0" ||
      typeof (r as any).id !== "number"
    ) {
      continue;
    }

    const id = (r as any).id as number;
    const idx = indexById.get(id);
    if (idx === undefined) continue;

    if (isJsonRpcError(r)) {
      results[idx] = Err(`RPC Error ${r.error.code}: ${r.error.message}`);
    } else {
      // Success: result type matches the corresponding interaction’s T
      results[idx] = Ok(r.result as InferInteraction<Calls[typeof idx]>);
    }
  }

  return results as {
    [K in keyof Calls]: BoxedResponse<InferInteraction<Calls[K]>, string>;
  };
}
type InferInteraction<T> = T extends JsonRpcInteraction<infer U> ? U : never;

export class JsonRpcInteraction<T> {
  public method: string;
  public params: unknown[] | Record<string, unknown>;
  public url: string;

  constructor({ method, params, url }: IBaseJsonRpcCall) {
    this.method = method;
    this.params = params;
    this.url = url;
  }

  call(): Promise<BoxedResponse<T, string>> {
    return rpcCallSingle<T>(this.url, this.method, this.params as unknown[]);
  }
}

export const RpcCall = <T>(
  url: string,
  method: string,
  params: unknown[] | Record<string, unknown> = []
) => {
  return new JsonRpcInteraction<T>({
    url,
    method,
    params,
  });
};
