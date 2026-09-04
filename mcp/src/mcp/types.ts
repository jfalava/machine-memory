import type { ApiFetcher } from "./product-client";

/**
 * API-only gateway bindings. The MCP worker holds no D1, Vectorize, or
 * Workers AI bindings of its own — every tool POSTs to the API worker's
 * `/product/*` routes over the `api` service binding, authorized with the
 * same bearer token the API enforces on all routes.
 */
export type McpBindings = {
  readonly api: ApiFetcher;
  readonly apiToken: string;
};

export type TextToolResult = {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
};

export type ErrorToolResult = TextToolResult & { readonly isError: true };
