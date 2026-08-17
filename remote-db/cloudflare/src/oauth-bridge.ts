import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { createOauthProvider, type OAuthEnv } from "./auth/oauth-provider";

const INTERNAL_ERROR = "Internal server error.";

const OAUTH_PATHS = [
  "/mcp",
  "/authorize",
  "/callback",
  "/token",
  "/register",
];

export type OAuthResources = {
  readonly d1: { readonly raw: Effect.Effect<unknown, never, RuntimeContext> };
  readonly vectorize: { readonly raw: Effect.Effect<unknown, never, RuntimeContext> };
  readonly ai: { readonly raw: Effect.Effect<unknown, never, RuntimeContext> };
  readonly oauthKv: { readonly raw: Effect.Effect<unknown, never, RuntimeContext> };
  readonly githubClientId: string;
  readonly githubClientSecret: string;
  readonly cookieEncryptionKey: string;
};

export function isOAuthPath(url: string): boolean {
  return (
    OAUTH_PATHS.some((path) => url === path || url.startsWith(`${path}/`)) ||
    url.startsWith("/.well-known/oauth-")
  );
}

export function handleOAuthPath(
  resources: OAuthResources,
  request: HttpServerRequest.HttpServerRequest,
) {
  const buildOAuthEnv = Effect.gen(function* () {
    const [rawD1, rawVectorize, rawAi, rawKv] = yield* Effect.all([
      resources.d1.raw,
      resources.vectorize.raw,
      resources.ai.raw,
      resources.oauthKv.raw,
    ]);
    return {
      DB: rawD1 as D1Database,
      VECTORIZE: rawVectorize as Vectorize,
      AI: rawAi as Ai,
      OAUTH_KV: rawKv as KVNamespace,
      GITHUB_CLIENT_ID: resources.githubClientId,
      GITHUB_CLIENT_SECRET: resources.githubClientSecret,
      COOKIE_ENCRYPTION_KEY: resources.cookieEncryptionKey,
    } satisfies OAuthEnv;
  });

  const buildProviderResponse = Effect.gen(function* () {
    const oauthEnv = yield* buildOAuthEnv;
    const execCtx = yield* Cloudflare.WorkerExecutionContext;
    const provider = createOauthProvider();
    const webRequest = yield* HttpServerRequest.toWeb(request);
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

