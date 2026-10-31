import {
  EMBEDDING_MODEL,
  type JsonObject,
  type ProductRequest,
  type ProductResponse,
  type ProductRoute,
} from "@machine-memory/contract";
import type { RuntimeContext } from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ftsSelect, rowByIdSelect, type ProductFilters } from "./product-api";
import { toProductRow, toRankedRow } from "./product-logic";
import { parseEmbedding } from "./vector-sync";

/** Bindings shared by every route module. */
export const createApiContext = (
  d1: Cloudflare.D1.QueryDatabaseClient,
  vectorize: Cloudflare.Vectorize.SearchIndexClient,
  ai: Cloudflare.Workers.AIClient,
) =>
  Effect.gen(function* () {
    const sql = yield* SQL.D1(d1);
    const embed = (text: string) =>
      ai
        .run(EMBEDDING_MODEL, { text: [text] })
        .pipe(
          Effect.map((output) =>
            parseEmbedding(Schema.decodeUnknownSync(Schema.Json)(output)),
          ),
        );
    return { d1, sql, vectorize, embed };
  });

export type ApiContext = Effect.Success<ReturnType<typeof createApiContext>>;

export type ProductResult<R extends ProductRoute> =
  ProductResponse<R>["result"];

/**
 * Takes the decoded request and returns the success result; expected client
 * errors fail with `HttpFailure`.
 */
export type ProductHandlers = {
  readonly [R in ProductRoute]: (
    input: ProductRequest<R>,
  ) => Effect.Effect<ProductResult<R>, unknown, RuntimeContext>;
};

export const fetchProductRow = (
  ctx: ApiContext,
  repository: string,
  id: number,
) =>
  Effect.gen(function* () {
    const query = rowByIdSelect(repository, id);
    const rows = yield* ctx.sql.unsafe<JsonObject>(query.sql, query.params);
    const first = rows[0];
    if (first === undefined) {
      return undefined;
    }
    return toProductRow(first);
  });

export const fetchRankedProductRows = (
  ctx: ApiContext,
  ftsQuery: string,
  repository: string,
  filters: ProductFilters,
  limit: number,
) =>
  Effect.gen(function* () {
    const query = ftsSelect(ftsQuery, repository, filters, limit);
    const rows = yield* ctx.sql.unsafe<JsonObject>(query.sql, query.params);
    return rows.map(toRankedRow);
  });
