import { Hono, type Handler } from "hono";

/** Minimal service-binding fetch surface (avoids dual Request type friction). */
export type ServiceFetcher = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};

/**
 * Public edge router. Sole owner of the custom domain (or workers.dev URL).
 * API, MCP, and optional docs workers are private and reached via service bindings.
 */
export interface Env {
  readonly API: ServiceFetcher;
  readonly MCP: ServiceFetcher;
  readonly DOCS_WORKER?: ServiceFetcher;
}

type App = { Bindings: Env };

const forwardBinding =
  (binding: "API" | "MCP"): Handler<App> =>
  async (c) =>
    c.env[binding].fetch(c.req.raw);

const forwardDocs: Handler<App> = async (c) => {
  const docs = c.env.DOCS_WORKER;
  if (docs === undefined) {
    return c.json({ error: "Not found" }, 404);
  }
  return docs.fetch(c.req.raw);
};

export const app = new Hono<App>()
  // MCP protocol + anything under /mcp (docs content lives under /docs/mcp)
  .all("/mcp", forwardBinding("MCP"))
  .all("/mcp/*", forwardBinding("MCP"))
  // OAuth companions owned by the MCP worker
  .all("/authorize", forwardBinding("MCP"))
  .all("/authorize/*", forwardBinding("MCP"))
  .all("/callback", forwardBinding("MCP"))
  .all("/callback/*", forwardBinding("MCP"))
  .all("/token", forwardBinding("MCP"))
  .all("/token/*", forwardBinding("MCP"))
  .all("/register", forwardBinding("MCP"))
  .all("/register/*", forwardBinding("MCP"))
  .all("/.well-known/oauth-authorization-server", forwardBinding("MCP"))
  .all("/.well-known/oauth-authorization-server/*", forwardBinding("MCP"))
  .all("/.well-known/oauth-protected-resource", forwardBinding("MCP"))
  .all("/.well-known/oauth-protected-resource/*", forwardBinding("MCP"))
  // REST API
  .all("/query", forwardBinding("API"))
  .all("/migrate", forwardBinding("API"))
  .all("/migrate/*", forwardBinding("API"))
  .all("/vectorize/*", forwardBinding("API"))
  // Root + docs site (or 404 when docs are not deployed)
  .all("*", forwardDocs);

export default app;
