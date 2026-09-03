/**
 * Thin docs worker in front of StaticSite assets.
 * Alchemy injects the ASSETS binding; public traffic reaches this only
 * through the edge router catch-all (DOCS_WORKER service binding).
 */
export interface Env {
  readonly ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return env.ASSETS.fetch(new Request(request));
  },
};
