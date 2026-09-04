import type {
  OAuthHelpers,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { createMemoryServer, type McpBindings } from "../mcp";
import { githubHandler } from "./github-handler";

export const AUTHORIZE_ENDPOINT = "/authorize";
export const TOKEN_ENDPOINT = "/token";
export const CLIENT_REGISTRATION_ENDPOINT = "/register";

/**
 * Runtime bindings required by the OAuth provider and the MCP tools it
 * protects. `OAUTH_KV` is provider-owned; `api`/`apiToken` are the API
 * service binding and bearer token the gateway tools POST `/product/*`
 * through. `OAUTH_PROVIDER` is injected by the provider at request time
 * before handlers run.
 */
export type OAuthEnv = McpBindings & {
  readonly OAUTH_KV: KVNamespace;
  readonly MACHINE_MEMORY_GITHUB_CLIENT_ID: string;
  readonly MACHINE_MEMORY_GITHUB_CLIENT_SECRET: string;
  readonly MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY: string;
  readonly OAUTH_PROVIDER?: OAuthHelpers;
};

/**
 * The provider package top-level imports `cloudflare:workers`, which only
 * workerd resolves. Load it lazily so importing this module outside the
 * Worker runtime (the Alchemy CLI stack import under Bun, typechecking)
 * never trips on the builtin specifier; the import rejects there and the
 * fallback `undefined` keeps the module graph loadable.
 */
const providerModule: Promise<
  typeof import("@cloudflare/workers-oauth-provider") | undefined
> = import("@cloudflare/workers-oauth-provider").catch(() => undefined);

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
 * Construction is async because the provider package is loaded lazily at
 * request time, inside the Worker runtime.
 */
export function createOauthProvider(): Promise<OAuthProvider<OAuthEnv>> {
  return providerModule.then((mod) => {
    if (mod === undefined) {
      throw new Error(
        "The OAuth provider is only available inside the Worker runtime.",
      );
    }
    // SAFETY: completeAuthorization stored GitHubAuthProps, so ctx.props always carries login.
    return new mod.OAuthProvider<OAuthEnv>({
      apiRoute: "/mcp",
      apiHandler: {
        fetch: (request, env, ctx) =>
          createMcpHandler(() =>
            createMemoryServer(
              env,
              (ctx.props as { login?: string } | undefined)?.login,
            ),
          )(request, env, ctx),
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
  });
}
