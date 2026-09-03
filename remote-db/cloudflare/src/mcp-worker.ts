import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Database, OAuthKv } from "./database";
import { mcpName } from "./config";
import { handleOAuthPath, isOAuthPath } from "./oauth-bridge";
import { VectorIndex } from "./vectorize";

const INTERNAL_ERROR = "Internal server error.";

/**
 * Independent MCP + OAuth worker. Reached only via the edge router service binding.
 * Owns /mcp, OAuth endpoints, and /.well-known/oauth-*.
 */
export default Cloudflare.Worker<{}>()(
  "machine-memory-mcp",
  {
    main: import.meta.url,
    name: mcpName,
    workersDev: false,
  },
  Effect.gen(function* () {
    const vectorIndex = yield* VectorIndex;
    const d1 = yield* Cloudflare.D1.QueryDatabase(Database);
    const vectorize = yield* Cloudflare.Vectorize.SearchIndex(vectorIndex);
    const ai = yield* Cloudflare.Workers.AI();
    const oauthKv = yield* Cloudflare.KV.ReadWriteNamespace(OAuthKv);
    const oauthConfig = yield* Effect.all({
      githubClientId: Config.string("GITHUB_CLIENT_ID").pipe(Effect.option),
      githubClientSecret: Config.redacted("GITHUB_CLIENT_SECRET").pipe(
        Effect.option,
      ),
      cookieEncryptionKey: Config.redacted("COOKIE_ENCRYPTION_KEY").pipe(
        Effect.option,
      ),
    });
    const oauthResources = {
      d1,
      vectorize,
      ai,
      oauthKv,
      githubClientId: Option.getOrUndefined(oauthConfig.githubClientId),
      githubClientSecret: Option.map(
        oauthConfig.githubClientSecret,
        Redacted.value,
      ).pipe(Option.getOrUndefined),
      cookieEncryptionKey: Option.map(
        oauthConfig.cookieEncryptionKey,
        Redacted.value,
      ).pipe(Option.getOrUndefined),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (isOAuthPath(request.url)) {
          return yield* handleOAuthPath(oauthResources, request);
        }
        return HttpServerResponse.jsonUnsafe(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { ok: false, error: INTERNAL_ERROR },
              { status: 500 },
            ),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
    Effect.provide(Cloudflare.Vectorize.SearchIndexBinding),
    Effect.provide(Cloudflare.Workers.AIBinding),
    Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding),
  ),
);
