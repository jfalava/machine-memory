import {
  decodeResponse,
  PRODUCT_OPERATIONS,
  productRoutePath,
  type ProductRoute,
  type ProductRequest,
  type ProductResponse,
  ErrorBodySchema,
  SimpleErrorBodySchema,
  type JsonValue,
} from "@machine-memory/contract";
export {
  PRODUCT_ROUTES,
  productRoutePath,
  type ProductRoute,
} from "@machine-memory/contract";

/** Minimal fetch surface over the API worker (service binding at runtime). */
export type ApiFetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export class ProductApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProductApiError";
    this.status = status;
  }
}

function failureMessage(status: number, body: JsonValue): string {
  // SAFETY: failure bodies are small JSON objects; decode is total.
  const failure = decodeResponse(ErrorBodySchema, body, "mcp/product");
  if (failure !== undefined) {
    return failure.error;
  }
  const simple = decodeResponse(SimpleErrorBodySchema, body, "mcp/product");
  if (simple !== undefined) {
    return simple.error;
  }
  return `API product route returned HTTP ${status}.`;
}

async function readProductBody(response: Response): Promise<JsonValue> {
  const text = await response.text();
  try {
    // SAFETY: parsed payload is validated against the contract success or
    // failure schema before any field is read.
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new ProductApiError(
      response.status,
      `API product route returned non-JSON HTTP ${response.status}.`,
    );
  }
}

/**
 * POST a wire-shaped body to an API product route and decode the success
 * envelope. Throws ProductApiError carrying the HTTP status so callers can
 * map 404s to not-found messages and everything else to tool errors.
 */
export async function postProduct<R extends ProductRoute>(
  api: ApiFetcher,
  token: string,
  route: R,
  body: ProductRequest<NoInfer<R>>,
): Promise<ProductResponse<R>> {
  const label = `mcp/product/${route}`;
  const operation = PRODUCT_OPERATIONS[route];
  let response: Response;
  try {
    response = await api.fetch(
      `https://product.internal${productRoutePath(route)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    );
  } catch (cause) {
    throw new ProductApiError(
      500,
      cause instanceof Error
        ? `API product route unreachable: ${cause.message}`
        : "API product route unreachable.",
    );
  }
  const json = await readProductBody(response);
  if (!response.ok) {
    throw new ProductApiError(
      response.status,
      failureMessage(response.status, json),
    );
  }
  const success = decodeResponse(operation.response, json, label);
  if (success === undefined) {
    throw new ProductApiError(
      response.status,
      "API product route returned an invalid response.",
    );
  }
  // SAFETY: TypeScript loses the indexed route/response correlation when decoding the union.
  // The schema selected above belongs to this exact route.
  return success as ProductResponse<R>;
}
