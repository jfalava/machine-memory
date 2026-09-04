/**
 * MCP memory server barrel.
 *
 * The MCP worker is an API-only gateway: tool handlers in `./mcp/tools.ts`
 * POST to the API worker's `/product/*` routes (see
 * `./mcp/product-client.ts`) and share the wire vocabulary with
 * `@machine-memory/contract` — the same integration the API worker and the
 * CLI remote paths use. This file only re-exports the public surface so
 * existing imports (`../mcp`, `../mcp.ts`) keep working.
 */
export { MCP_SERVER_VERSION, createMemoryServer } from "./mcp/tools";
export type { ErrorToolResult, McpBindings, TextToolResult } from "./mcp/types";
export type { ApiFetcher } from "./mcp/product-client";
export { postProduct, ProductApiError } from "./mcp/product-client";
export type { ProductRoute } from "./mcp/product-client";
export { PRODUCT_ROUTES, productRoutePath } from "./mcp/product-client";
