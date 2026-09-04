import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { createOauthProvider, type OAuthEnv } from "./auth/oauth-provider";

const INTERNAL_ERROR = "Internal server error.";

const OAUTH_PATHS = ["/mcp", "/authorize", "/callback", "/token", "/register"];

export type OAuthResources = {
  readonly api: Fetcher;
  readonly apiToken: string;
  readonly oauthKv: {
    readonly raw: Effect.Effect<unknown, never, RuntimeContext>;
  };
  readonly githubClientId: string | undefined;
  readonly githubClientSecret: string | undefined;
  readonly cookieEncryptionKey: string | undefined;
};

export function isOAuthPath(url: string): boolean {
  const pathname = url.split("?")[0];
  return (
    OAUTH_PATHS.some(
      (path) => pathname === path || pathname.startsWith(`${path}/`),
    ) || pathname.startsWith("/.well-known/oauth-")
  );
}

type OAuthConfig = {
  readonly githubClientId: string;
  readonly githubClientSecret: string;
  readonly cookieEncryptionKey: string;
};

type OAuthConfigResolution =
  | { readonly config: OAuthConfig; readonly missing: [] }
  | { readonly config: undefined; readonly missing: string[] };

function resolveOAuthConfig(resources: OAuthResources): OAuthConfigResolution {
  const { githubClientId, githubClientSecret, cookieEncryptionKey } = resources;
  if (
    githubClientId === undefined ||
    githubClientSecret === undefined ||
    cookieEncryptionKey === undefined
  ) {
    const missing = [
      githubClientId === undefined ? "MACHINE_MEMORY_GITHUB_CLIENT_ID" : "",
      githubClientSecret === undefined
        ? "MACHINE_MEMORY_GITHUB_CLIENT_SECRET"
        : "",
      cookieEncryptionKey === undefined
        ? "MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY"
        : "",
    ].filter((name) => name !== "");
    return { config: undefined, missing };
  }
  return {
    config: { githubClientId, githubClientSecret, cookieEncryptionKey },
    missing: [],
  };
}

export function handleOAuthPath(
  resources: OAuthResources,
  request: HttpServerRequest.HttpServerRequest,
) {
  const { config, missing } = resolveOAuthConfig(resources);
  if (config === undefined) {
    return Effect.succeed(
      HttpServerResponse.jsonUnsafe(
        {
          ok: false,
          error: `MCP is not configured. Set ${missing.join(", ")} and redeploy the stack.`,
        },
        { status: 503 },
      ),
    );
  }

  const buildOAuthEnv = Effect.gen(function* () {
    const [rawKv] = yield* Effect.all([resources.oauthKv.raw]);
    // SAFETY: worker.ts provides this resource from the real Cloudflare
    // binding; alchemy's RuntimeContext types raw values as unknown only.
    return {
      api: resources.api,
      apiToken: resources.apiToken,
      OAUTH_KV: rawKv as KVNamespace,
      MACHINE_MEMORY_GITHUB_CLIENT_ID: config.githubClientId,
      MACHINE_MEMORY_GITHUB_CLIENT_SECRET: config.githubClientSecret,
      MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY: config.cookieEncryptionKey,
    } satisfies OAuthEnv;
  });

  const buildProviderResponse = Effect.gen(function* () {
    const oauthEnv = yield* buildOAuthEnv;
    const execCtx = yield* Cloudflare.WorkerExecutionContext;
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const provider = yield* Effect.promise(() => createOauthProvider());
    return yield* Effect.promise(() =>
      provider.fetch(webRequest, oauthEnv, execCtx.raw),
    );
  });

  return buildProviderResponse.pipe(
    Effect.catchCause(() =>
      Effect.succeed(new Response(INTERNAL_ERROR, { status: 500 })),
    ),
    Effect.map((response) => HttpServerResponse.fromWeb(response)),
  );
}
