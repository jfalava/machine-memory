import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as SQL from "@alchemy.run/cloudflare/D1/SQL";
import {
  EMBEDDING_MODEL,
  type JsonObject,
  type ProductRequest,
  type ProductResponse,
  type ProductRoute,
} from "@machine-memory/contract";
import type { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { notFound } from "./http-failure";
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

/**
 * 404 for an id missing from `repository`. Ids are unique across repositories,
 * so the error names the repository that does hold the id.
 */
export const memoryNotFound = (
  ctx: ApiContext,
  id: number,
  repository: string,
) =>
  Effect.gen(function* () {
    const rows = yield* ctx.sql.unsafe<{ repository: string }>(
      `SELECT repository FROM memories WHERE id = ?`,
      [id],
    );
    const holder = rows[0]?.repository;
    return yield* notFound(
      `No memory found with id ${id} in repository '${repository}'.${
        holder === undefined
          ? ""
          : ` Memory ${id} belongs to repository '${holder}'.`
      }`,
    );
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
