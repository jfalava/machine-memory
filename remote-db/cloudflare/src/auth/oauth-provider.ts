import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { createMemoryServer, type McpBindings } from "../mcp";
import { githubHandler } from "./github-handler";

export const AUTHORIZE_ENDPOINT = "/authorize";
export const TOKEN_ENDPOINT = "/token";
export const CLIENT_REGISTRATION_ENDPOINT = "/register";

/**
 * Runtime bindings required by the OAuth provider and the MCP tools it
 * protects. `OAUTH_KV` is provider-owned; the remaining keys are the raw
 * D1, Vectorize, and Workers AI bindings the MCP tools operate on.
 * `OAUTH_PROVIDER` is injected by the provider at request time before
 * handlers run.
 */
export type OAuthEnv = McpBindings & {
  readonly OAUTH_KV: KVNamespace;
  readonly GITHUB_CLIENT_ID: string;
  readonly GITHUB_CLIENT_SECRET: string;
  readonly COOKIE_ENCRYPTION_KEY: string;
  readonly OAUTH_PROVIDER?: OAuthHelpers;
};

/**
 * Builds the OAuth 2.1 provider protecting the `/mcp` route.
 *
 * The OAuth provider owns token issuance, refresh, revocation, client
 * registration, and RFC 9728 discovery. The `apiHandler` delegates to the
 * stateless MCP handler; the `defaultHandler` owns GitHub authentication
 * and the consent page at `/authorize`.
 *
 * The provider is a plain handler, not an Effect, so it is composed inside
 * the Alchemy worker's Effect fetch handler via the `toWeb`/`fromWeb` bridge.
 */
export function createOauthProvider(): OAuthProvider<OAuthEnv> {
  return new OAuthProvider<OAuthEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      fetch: (request, env, ctx) =>
        createMcpHandler(() => createMemoryServer(env))(
          request,
          env,
          ctx,
        ),
    },
    defaultHandler: githubHandler,
    authorizeEndpoint: AUTHORIZE_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientRegistrationEndpoint: CLIENT_REGISTRATION_ENDPOINT,
    scopesSupported: ["mcp:read", "mcp:write"],
    resourceMetadata: {
      scopes_supported: ["mcp:read", "mcp:write"],
      resource_name: "Machine Memory MCP",
    },
  });
}
