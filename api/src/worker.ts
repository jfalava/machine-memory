import {
  decodeRequest,
  encodeResponse,
  PRODUCT_OPERATIONS,
  type JsonValue,
  type ProductResponse,
  type ProductRoute,
} from "@machine-memory/contract";
import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

import { apiName } from "../../iac/src/config";
import { Database } from "../../iac/src/database";
import { readStoredSecret } from "../../iac/src/secrets";
import { VectorIndex } from "../../iac/src/vectorize";
import {
  handleMigration,
  handleMigrationLinks,
  handleQuery,
} from "./admin-routes";
import { createApiContext, type ProductHandlers } from "./api-context";
import { badRequest, recoverHttpFailure } from "./http-failure";
import { productReadHandlers } from "./product-reads";
import { productSearchHandlers } from "./product-search";
import { productWriteHandlers } from "./product-writes";
import { handleRestRequest, type RestHandlers } from "./rest-handlers";
import { VectorCoordinator } from "./vector-coordinator";
import { handleVectorizeSearch } from "./vector-search";

export const createApiHandlers = ({
  d1,
  vectorize,
  ai,
  expectedToken,
  wake,
}: {
  d1: Cloudflare.D1.QueryDatabaseClient;
  vectorize: Cloudflare.Vectorize.SearchIndexClient;
  ai: Cloudflare.Workers.AIClient;
  expectedToken: Effect.Effect<
    Redacted.Redacted<string>,
    Error,
    RuntimeContext
  >;
  /** Runs after every handled request; must log its own failures and defects. */
  wake: Effect.Effect<void, never, RuntimeContext>;
}) =>
  Effect.gen(function* () {
    const ctx = yield* createApiContext(d1, vectorize, ai);
    const productHandlers: ProductHandlers = {
      ...productReadHandlers(ctx),
      ...productSearchHandlers(ctx),
      ...productWriteHandlers(ctx),
    };

    /** Decodes the route's request, runs its handler, and encodes its result. */
    const handleProduct = <R extends ProductRoute>(route: R, body: JsonValue) =>
      Effect.gen(function* () {
        const operation = PRODUCT_OPERATIONS[route];
        const input = decodeRequest(operation.request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const result = yield* productHandlers[route](input.value);
        // SAFETY: productHandlers[route] returns ProductResult<R>; TypeScript
        // does not correlate the generic route with the response union.
        const success = { ok: true, result } as ProductResponse<R>;
        return yield* HttpServerResponse.json(
          encodeResponse(operation.response, success),
        );
      }).pipe(
        recoverHttpFailure,
        Effect.tap(() => wake),
      );

    const restHandlers = {
      expectedToken,
      handleQuery: (body) =>
        handleQuery(ctx, body).pipe(
          recoverHttpFailure,
          Effect.tap(() => wake),
        ),
      handleMigration: (body) =>
        handleMigration(ctx, body).pipe(
          recoverHttpFailure,
          Effect.tap(() => wake),
        ),
      handleMigrationLinks: (body) =>
        handleMigrationLinks(ctx, body).pipe(
          recoverHttpFailure,
          Effect.tap(() => wake),
        ),
      handleVectorizeSearch: (body) =>
        handleVectorizeSearch(ctx, body).pipe(recoverHttpFailure),
      handleProduct,
    } satisfies RestHandlers;

    return restHandlers;
  });

export default Cloudflare.Worker<{}>()(
  "machine-memory-api",
  { main: import.meta.url, name: apiName, workersDev: false },
  Effect.gen(function* () {
    const vectorIndex = yield* VectorIndex;
    const d1 = yield* Cloudflare.D1.QueryDatabase(Database);
    const vectorize = yield* Cloudflare.Vectorize.SearchIndex(vectorIndex);
    const ai = yield* Cloudflare.Workers.AI();
    const env = yield* Cloudflare.WorkerEnvironment;
    const expectedToken = readStoredSecret("MACHINE_MEMORY_DB_TOKEN").pipe(
      Effect.provideService(Cloudflare.WorkerEnvironment, env),
    );
    const coordinator = yield* VectorCoordinator;
    const wake = Effect.suspend(() =>
      coordinator.getByName("memory-index").wake(),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          "Vector coordinator wake failed; cron will retry.",
          cause,
        ),
      ),
    );
    yield* Cloudflare.Workers.cron("*/5 * * * *", () => wake);
    const restHandlers = yield* createApiHandlers({
      d1,
      vectorize,
      ai,
      expectedToken,
      wake,
    });
    return {
      // handleRestRequest turns every failure and defect into a response.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* handleRestRequest(restHandlers, request);
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Vectorize.SearchIndexBinding,
        Cloudflare.Workers.AIBinding,
        Cloudflare.Workers.CronEventSourceLive,
      ),
    ),
  ),
);
