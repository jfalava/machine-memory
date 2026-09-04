import { Hono, type Handler } from "hono";

/** Minimal service-binding fetch surface (avoids dual Request type friction). */
export type ServiceFetcher = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};

/**
 * Public edge router. Sole owner of the custom domain (or workers.dev URL).
 * API, MCP, and optional docs workers are private and reached via service bindings.
 *
 * Only declared mounts are served. Anything else returns 418 so bots probing
 * WordPress/php paths etc. do not burn docs/API compute (same idea as jfa.dev).
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

/**
 * Docs site path prefixes (content + generated asset trees under the site root).
 * Keep in sync with docs/dist top-level dirs after a docs build.
 */
export const DOCS_MOUNTS = [
  "/docs",
  "/human",
  "/infrastructure",
  "/installation",
  "/machine",
  "/troubleshooting",
  "/og",
  "/pagefind",
  "/_astro",
  "/_nimbus",
  "/fonts",
] as const;

/** Exact root-level docs files (not directory mounts). */
export const DOCS_EXACT = new Set<string>([
  "/",
  "/llms.txt",
  "/llms-full.txt",
  "/robots.txt",
  "/og.png",
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
  "/site.webmanifest",
  "/sitemap-0.xml",
  "/sitemap-index.xml",
  "/install",
  "/install.ps1",
  "/init-mcp",
  "/init-mcp.ps1",
  "/404",
  "/404.html",
]);

/** True when pathname is a path we intentionally forward to the docs worker. */
export function isDocsPath(pathname: string): boolean {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;

  if (DOCS_EXACT.has(path)) {
    return true;
  }

  return DOCS_MOUNTS.some(
    (mount) => path === mount || path.startsWith(`${mount}/`),
  );
}

const forwardDocs: Handler<App> = async (c) => {
  const pathname = new URL(c.req.url).pathname;
  if (!isDocsPath(pathname)) {
    return c.text("I'm a teapot", 418);
  }

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
  .all("/product/*", forwardBinding("API"))
  // Known docs mounts only; everything else is 418
  .all("*", forwardDocs);

export default app;
