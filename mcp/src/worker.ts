import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import ApiWorker from "../../api/src/worker";
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
 * binding, authorized with the same bearer token the API enforces. References
 * the shared stack API resource (same module object alchemy.run.ts
 * instantiates — the Database/OAuthKv module-scope pattern), so alchemy
 * deploys a single API worker plus the `mcp/API` service binding.
 */
export default Cloudflare.Worker<{ API: Cloudflare.Worker }>()(
  "machine-memory-mcp",
  {
    main: import.meta.url,
    name: mcpName,
    workersDev: false,
    env: {
      // SAFETY: alchemy yields worker resources referenced in env at deploy
      // (bindWorker accepts classes and Effects, like Database in Init
      // effects, deduped by ID — plans show a single [machine-memory-api]).
      // The double assertion bridges Effect's invariant success type, which
      // cannot express factory-yields-ResourceLike vs env-wants-Resource.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- justified above: alchemy worker-resource reference, not a domain type narrowing.
      API: ApiWorker as unknown as Cloudflare.Worker,
    },
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
