import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { mcpName } from "../../iac/src/config";
import { OAuthKv } from "../../iac/src/database";
import { handleOAuthPath, isOAuthPath } from "./oauth-bridge";

const INTERNAL_ERROR = "Internal server error.";

/**
 * API-only gateway MCP + OAuth worker. Reached only via the edge router
 * service binding. Owns /mcp, OAuth endpoints, and /.well-known/oauth-*.
 *
 * Holds no D1, Vectorize, or Workers AI bindings of its own: every MCP tool
 * POSTs to the API worker's `/product/*` routes over the `API` service
 * binding, authorized with the same bearer token the API enforces. Takes
 * the instantiated stack API worker (same object alchemy.run.ts deploys —
 * like the router's `env: { API: api }`), so no worker is deployed twice.
 */
export function createMcpWorker<
  const A extends Cloudflare.WorkerBindingResource,
>(api: A) {
  return Cloudflare.Worker<{ API: A }>()(
    "machine-memory-mcp",
    {
      main: import.meta.url,
      name: mcpName,
      workersDev: false,
      env: { API: api },
    },
    Effect.gen(function* () {
      const env = yield* Cloudflare.WorkerEnvironment;
      // SAFETY: alchemy lowers env.API to a service binding for the API worker.
      const apiFetcher = env.API as Fetcher;
      const apiToken = yield* Config.redacted("MACHINE_MEMORY_DB_TOKEN").pipe(
        Effect.orDie,
      );
      const oauthKv = yield* Cloudflare.KV.ReadWriteNamespace(OAuthKv);
      const oauthConfig = yield* Effect.all({
        githubClientId: Config.string("MACHINE_MEMORY_GITHUB_CLIENT_ID").pipe(
          Effect.option,
        ),
        githubClientSecret: Config.redacted(
          "MACHINE_MEMORY_GITHUB_CLIENT_SECRET",
        ).pipe(Effect.option),
        cookieEncryptionKey: Config.redacted(
          "MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY",
        ).pipe(Effect.option),
      });
      const oauthResources = {
        api: apiFetcher,
        apiToken: Redacted.value(apiToken),
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
    }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding)),
  );
}
