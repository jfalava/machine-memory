import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { createOauthProvider, type OAuthEnv } from "./auth/oauth-provider";

const INTERNAL_ERROR = "Internal server error.";

export type OAuthResources = {
  readonly api: Fetcher;
  readonly apiToken: string;
  readonly oauthKv: {
    readonly raw: Effect.Effect<unknown, never, RuntimeContext>;
  };
  readonly oauthDevices: {
    readonly raw: Effect.Effect<unknown, never, RuntimeContext>;
  };
  readonly githubClientId: string | undefined;
  readonly githubClientSecret: string | undefined;
  readonly githubAllowedUserId: string | undefined;
  readonly cookieEncryptionKey: string | undefined;
};

type OAuthConfig = Pick<
  OAuthEnv,
  | "MACHINE_MEMORY_GITHUB_CLIENT_ID"
  | "MACHINE_MEMORY_GITHUB_CLIENT_SECRET"
  | "MACHINE_MEMORY_GITHUB_ALLOWED_USER_ID"
  | "MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY"
>;

type OAuthConfigResolution =
  | { readonly config: OAuthConfig; readonly missing: [] }
  | { readonly config: undefined; readonly missing: string[] };

function resolveOAuthConfig(resources: OAuthResources): OAuthConfigResolution {
  const missing: string[] = [];
  const required = (name: string, value: string | undefined): string => {
    if (value === undefined) {
      missing.push(name);
    }
    return value ?? "";
  };
  const allowedUserId = resources.githubAllowedUserId;
  const config = {
    MACHINE_MEMORY_GITHUB_CLIENT_ID: required(
      "MACHINE_MEMORY_GITHUB_CLIENT_ID",
      resources.githubClientId,
    ),
    MACHINE_MEMORY_GITHUB_CLIENT_SECRET: required(
      "MACHINE_MEMORY_GITHUB_CLIENT_SECRET",
      resources.githubClientSecret,
    ),
    MACHINE_MEMORY_GITHUB_ALLOWED_USER_ID: required(
      "MACHINE_MEMORY_GITHUB_ALLOWED_USER_ID",
      allowedUserId?.trim() === "" ? undefined : allowedUserId,
    ),
    MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY: required(
      "MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY",
      resources.cookieEncryptionKey,
    ),
  };
  return missing.length === 0
    ? { config, missing: [] }
    : { config: undefined, missing };
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
    const [rawKv, rawDevices] = yield* Effect.all([
      resources.oauthKv.raw,
      resources.oauthDevices.raw,
    ]);
    // SAFETY: worker.ts provides this resource from the real Cloudflare
    // binding; alchemy's RuntimeContext types raw values as unknown only.
    return {
      api: resources.api,
      apiToken: resources.apiToken,
      OAUTH_KV: rawKv as KVNamespace,
      // SAFETY: worker.ts supplies the dedicated D1 binding through Alchemy.
      OAUTH_DEVICES: rawDevices as D1Database,
      ...config,
    } satisfies OAuthEnv;
  });

  const buildProviderResponse = Effect.gen(function* () {
    const oauthEnv = yield* buildOAuthEnv;
    const execCtx = yield* Cloudflare.WorkerExecutionContext;
    const webRequest = yield* HttpServerRequest.toWeb(request);
    // The private MCP worker receives the original public URL from the router.
    const provider = yield* Effect.promise(() =>
      createOauthProvider(new URL("/mcp", webRequest.url).href),
    );
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
