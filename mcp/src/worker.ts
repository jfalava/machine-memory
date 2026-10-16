import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import ApiWorker from "../../api/src/worker";
import { mcpName } from "../../iac/src/config";
import { OAuthDevices, OAuthKv } from "../../iac/src/database";
import { readStoredSecret } from "../../iac/src/secrets";
import { handleOAuthPath, isOAuthPath } from "./oauth-bridge";

const INTERNAL_ERROR = "Internal server error.";

/**
 * API-only gateway MCP + OAuth worker. Reached only via the edge router
 * service binding. Owns /mcp, OAuth endpoints, and /.well-known/oauth-*.
 *
 * Holds a dedicated D1 database for device approvals, but no project-memory
 * database, Vectorize, or Workers AI bindings: every MCP tool
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
    const oauthKv = yield* Cloudflare.KV.ReadWriteNamespace(OAuthKv);
    const oauthDevices = yield* Cloudflare.D1.QueryDatabase(OAuthDevices);
    const optionalSecret = (name: string) =>
      Effect.suspend(() =>
        env[name] === undefined
          ? Effect.succeed(undefined)
          : readStoredSecret(name).pipe(Effect.map(Redacted.value)),
      );
    const oauthResources = Effect.gen(function* () {
      const apiToken = yield* readStoredSecret("MACHINE_MEMORY_DB_TOKEN");
      const oauthConfig = yield* Effect.all({
        githubClientId: optionalSecret("MACHINE_MEMORY_GITHUB_CLIENT_ID"),
        githubClientSecret: optionalSecret(
          "MACHINE_MEMORY_GITHUB_CLIENT_SECRET",
        ),
        githubAllowedUserId: optionalSecret(
          "MACHINE_MEMORY_GITHUB_ALLOWED_USER_ID",
        ),
        cookieEncryptionKey: optionalSecret(
          "MACHINE_MEMORY_COOKIE_ENCRYPTION_KEY",
        ),
      });
      return {
        api: apiFetcher,
        apiToken: Redacted.value(apiToken),
        oauthKv,
        oauthDevices,
        ...oauthConfig,
      };
    }).pipe(Effect.provideService(Cloudflare.WorkerEnvironment, env));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (isOAuthPath(request.url)) {
          return yield* handleOAuthPath(yield* oauthResources, request);
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
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.KV.ReadWriteNamespaceBinding,
        Cloudflare.D1.QueryDatabaseBinding,
      ),
    ),
  ),
);
