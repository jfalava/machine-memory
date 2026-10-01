import {
  composeEmbeddingText,
  PRODUCT_OPERATIONS,
  SEARCH_LIMIT_MAX,
  VectorizeSearchResultSchema,
  type ProductRoute,
  type MemoryType,
  type MemoryStatus,
  type Certainty,
  type MemoryWriteResult,
  type UpsertMatchInfo,
  decodeRequest,
  EMBEDDING_MODEL,
  embeddingSizeReport,
  encodeResponse,
  ErrorBodySchema,
  jsonNumber,
  jsonString,
  MigrationLinksRequestSchema,
  MigrationLinksSuccessSchema,
  MigrationRequestInputSchema,
  MigrationSuccessSchema,
  memoryDocumentId,
  normalizeListRepositoriesArgs,
  normalizeMemoryAddArgs,
  normalizeMemoryListArgs,
  normalizeMemoryQueryArgs,
  normalizeMemorySizeArgs,
  normalizeMemorySuggestArgs,
  normalizeMigrationRequest,
  normalizeVectorizeSearchRequest,
  normalizeVectorizeUpsertRequest,
  QueryRequestSchema,
  QuerySuccessSchema,
  validateEmbeddingText,
  VectorizeDeleteRequestSchema,
  VectorizeDeleteSuccessSchema,
  VectorizeSearchRequestInputSchema,
  VectorizeSearchSuccessSchema,
  VectorizeUpsertRequestInputSchema,
  VectorizeUpsertSuccessSchema,
  type JsonObject,
  type JsonValue,
  type MigrationItem,
  type QueryRequest,
  type VectorizeSearchRequest,
  type VectorizeUpsertRequest,
} from "@machine-memory/contract";
import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { apiName } from "../../iac/src/config";
import { Database } from "../../iac/src/database";
import { VectorIndex } from "../../iac/src/vectorize";
import {
  ftsSelect,
  INSERT_SQL,
  insertParams,
  listCountSelect,
  listSelect,
  neighborhoodSelect,
  REPOSITORY_COUNT_SQL,
  repositoryStatsSelect,
  rowByIdSelect,
  updateSets,
  vectorFilter,
  type InsertInput,
} from "./product-api";
import {
  buildFtsQuery,
  analyzeMemoryDoctor,
  compareMemoryFact,
  contentHead,
  deriveFileNeighborhood,
  embeddingTextForMemory,
  extractPathTerms,
  extractTerms,
  parseSuggestFilesParam,
  scoredResultRow,
  scoreMemoryRows,
  summarizeMemoryStats,
  toProductRow,
  toRankedRow,
  uniqueLowerPreserveOrder,
  UPSERT_MIN_SIMILARITY,
} from "./product-logic";
import {
  handleRestRequest,
  type RestHandlers,
  type RestHandlerFn,
} from "./rest-handlers";
import { VectorCoordinator } from "./vector-coordinator";
import { parseEmbedding } from "./vector-sync";

const INTERNAL_ERROR = "Internal server error.";

function badRequest(error: string) {
  return HttpServerResponse.json(
    encodeResponse(ErrorBodySchema, { ok: false, error }),
    { status: 400 },
  );
}

function embeddingTextForDocument(document: VectorizeUpsertRequest): string {
  return composeEmbeddingText({
    content: document.content,
    tags: document.tags,
    context: document.context,
    memory_type: document.memory_type,
    status: document.status,
    certainty: document.certainty,
  });
}

function parseUpsertDocument(body: JsonValue) {
  const parsed = decodeRequest(VectorizeUpsertRequestInputSchema, body);
  if (!parsed.ok) {
    return parsed;
  }
  const document = normalizeVectorizeUpsertRequest(parsed.value);
  try {
    validateEmbeddingText(embeddingTextForDocument(document), "Document text");
  } catch (cause) {
    return {
      ok: false as const,
      error: cause instanceof Error ? cause.message : "Invalid document.",
    };
  }
  return { ok: true as const, value: document };
}

function parseSearchRequest(body: JsonValue) {
  const parsed = decodeRequest(VectorizeSearchRequestInputSchema, body);
  if (!parsed.ok) {
    return parsed;
  }
  const request = normalizeVectorizeSearchRequest(parsed.value);
  try {
    validateEmbeddingText(request.query, "Query");
  } catch (cause) {
    return {
      ok: false as const,
      error: cause instanceof Error ? cause.message : "Invalid query.",
    };
  }
  return { ok: true as const, value: request };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function migrationDuplicateItem(
  sourceId: number,
  targetId: number,
): MigrationItem {
  return {
    source_id: sourceId,
    target_id: targetId,
    status: "duplicate",
  };
}

function migrationInsertedItem(
  sourceId: number,
  targetId: number,
): MigrationItem {
  return {
    source_id: sourceId,
    target_id: targetId,
    status: "inserted",
  };
}

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
  expectedToken: Redacted.Redacted<string>;
  wake: Effect.Effect<void, never, RuntimeContext>;
}) =>
  // oxlint-disable-next-line max-statements -- assemble route handlers over shared bindings
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

    const handleQuery = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(QueryRequestSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const request: QueryRequest = input.value;

        if (request.operation === "run") {
          const response = yield* d1
            .prepare(request.sql)
            .bind(...request.params)
            .run();
          return yield* HttpServerResponse.json(
            encodeResponse(QuerySuccessSchema, {
              ok: true,
              result: {
                changes: response.meta.changes,
                lastInsertRowid: response.meta.last_row_id,
              },
            }),
          );
        }

        const rows = yield* sql.unsafe<JsonObject>(request.sql, request.params);
        const result = request.operation === "all" ? rows : (rows[0] ?? null);
        return yield* HttpServerResponse.json(
          encodeResponse(QuerySuccessSchema, { ok: true, result }),
        );
      });

    const handleMigration = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(MigrationRequestInputSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const normalized = normalizeMigrationRequest(input.value);
        if (!normalized.ok) {
          return yield* badRequest(normalized.error);
        }
        const request = normalized.value;
        // One D1 transaction: source identity, not content similarity, provides
        // retry safety for every status and preserves distinct metadata.
        const statements = request.rows.flatMap((row) => [
          d1
            .prepare(`INSERT INTO memories (repository, content, tags, context, memory_type, status,
            superseded_by, source_agent, last_updated_by, update_count, certainty, refs,
            expires_after_days, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, coalesce(?, datetime('now')), coalesce(?, datetime('now'))
            WHERE NOT EXISTS (SELECT 1 FROM memory_migration_sources WHERE repository = ? AND source = ? AND source_id = ?)
            RETURNING id`)
            .bind(
              request.repository,
              row.content,
              row.tags,
              row.context,
              row.memory_type,
              row.status,
              row.source_agent,
              row.last_updated_by,
              row.update_count,
              row.certainty,
              row.refs,
              row.expires_after_days,
              row.created_at,
              row.updated_at,
              request.repository,
              request.source,
              row.source_id,
            ),
          d1
            .prepare(`INSERT INTO memory_migration_sources (repository, source, source_id, target_id)
            SELECT ?, ?, ?, last_insert_rowid() WHERE NOT EXISTS
            (SELECT 1 FROM memory_migration_sources WHERE repository = ? AND source = ? AND source_id = ?)`)
            .bind(
              request.repository,
              request.source,
              row.source_id,
              request.repository,
              request.source,
              row.source_id,
            ),
          d1
            .prepare(
              `SELECT target_id AS id FROM memory_migration_sources WHERE repository = ? AND source = ? AND source_id = ?`,
            )
            .bind(request.repository, request.source, row.source_id),
        ]);
        const results =
          statements.length === 0
            ? []
            : yield* d1.batch<{ id: number }>(statements);
        const items = request.rows.map((row, i) => {
          const target = results[i * 3 + 2].results[0].id;
          return results[i * 3].results.length > 0
            ? migrationInsertedItem(row.source_id, target)
            : migrationDuplicateItem(row.source_id, target);
        });
        const inserted = items.filter(
          (item) => item.status === "inserted",
        ).length;
        return yield* HttpServerResponse.json(
          encodeResponse(MigrationSuccessSchema, {
            ok: true,
            result: {
              processed: request.rows.length,
              inserted,
              duplicates: items.length - inserted,
              items,
            },
          }),
        );
      });

    const handleMigrationLinks = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(MigrationLinksRequestSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }

        for (const link of input.value.links) {
          if (
            link.target_id === link.superseded_by_target_id ||
            !(yield* fetchProductRow(input.value.repository, link.target_id)) ||
            !(yield* fetchProductRow(
              input.value.repository,
              link.superseded_by_target_id,
            ))
          ) {
            return yield* badRequest(
              "Migration links require distinct memories in the same repository.",
            );
          }
        }
        const statements = input.value.links.map((link) =>
          d1
            .prepare(`UPDATE memories
          SET superseded_by = ?, update_count = update_count + 1
          WHERE repository = ? AND id = ? RETURNING id`)
            .bind(
              link.superseded_by_target_id,
              input.value.repository,
              link.target_id,
            ),
        );
        const results =
          statements.length === 0 ? [] : yield* d1.batch(statements);
        const updated = results.reduce(
          (count, result) => count + result.results.length,
          0,
        );

        return yield* HttpServerResponse.json(
          encodeResponse(MigrationLinksSuccessSchema, {
            ok: true,
            result: { updated },
          }),
        );
      });

    const handleVectorizeUpsert = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = parseUpsertDocument(body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const document = input.value;
        const id = memoryDocumentId(document);
        const queued = yield* d1
          .prepare(`UPDATE memory_vector_sync SET generation = generation + 1,
          next_attempt_at = 0, attempts = 0 WHERE memory_id = ? AND repository = ?`)
          .bind(Number(id), document.repository)
          .run();
        if (queued.meta.changes === 0) {
          return yield* badRequest("Memory does not exist in this repository.");
        }
        return yield* HttpServerResponse.json(
          encodeResponse(VectorizeUpsertSuccessSchema, {
            ok: true,
            result: {
              id,
              namespace: document.repository,
              indexing: "queued",
            },
          }),
        );
      });

    const handleVectorizeSearch = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = parseSearchRequest(body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const request: VectorizeSearchRequest = input.value;
        const values = yield* embed(request.query);
        const filter = Object.fromEntries(
          [
            ["status", emptyToUndefined(request.status)],
            ["memory_type", emptyToUndefined(request.memory_type)],
            ["certainty", emptyToUndefined(request.certainty)],
          ].filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        const queryOptions = {
          namespace: request.repository,
          topK: request.top_k,
          returnMetadata: "all" as const,
        };
        if (Object.keys(filter).length > 0) {
          Object.assign(queryOptions, { filter });
        }
        const matches = yield* vectorize.query(values, queryOptions);
        const result = Schema.decodeUnknownSync(VectorizeSearchResultSchema)(
          matches,
        );
        return yield* HttpServerResponse.json(
          encodeResponse(VectorizeSearchSuccessSchema, {
            ok: true,
            result,
          }),
        );
      });

    const handleVectorizeDelete = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(VectorizeDeleteRequestSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const id = String(input.value.id).trim();
        if (id.length === 0) {
          return yield* badRequest("id must be a non-empty string or number.");
        }
        // Reconcile canonical state; a client cannot delete an active row's vector.
        const queued = yield* d1
          .prepare(`UPDATE memory_vector_sync SET generation = generation + 1,
          next_attempt_at = 0, attempts = 0 WHERE memory_id = ?`)
          .bind(Number(id))
          .run();
        if (queued.meta.changes === 0) {
          return yield* badRequest("Unknown memory id.");
        }
        return yield* HttpServerResponse.json(
          encodeResponse(VectorizeDeleteSuccessSchema, {
            ok: true,
            result: { id, indexing: "queued" },
          }),
        );
      });

    const fetchProductRow = (repository: string, id: number) =>
      Effect.gen(function* () {
        const query = rowByIdSelect(repository, id);
        const rows = yield* sql.unsafe<JsonObject>(query.sql, query.params);
        const first = rows[0];
        if (first === undefined) {
          return undefined;
        }
        return toProductRow(first);
      });

    const fetchRankedProductRows = (
      ftsQuery: string,
      repository: string,
      filters: {
        status?: string;
        memory_type?: string;
        certainty?: string;
        tags?: string;
      },
      limit: number,
    ) =>
      Effect.gen(function* () {
        const query = ftsSelect(ftsQuery, repository, filters, limit);
        const rows = yield* sql.unsafe<JsonObject>(query.sql, query.params);
        return rows.map(toRankedRow);
      });

    const findBestProductMatch = (repository: string, query: string) =>
      Effect.gen(function* () {
        const terms = extractTerms(query);
        const ftsQuery = buildFtsQuery(terms);
        if (ftsQuery === undefined) {
          return null;
        }
        const rows = yield* fetchRankedProductRows(
          ftsQuery,
          repository,
          { status: "active" },
          5,
        );
        const scored = scoreMemoryRows(rows, terms);
        const best = scored[0];
        if (!best) {
          return null;
        }
        return { row: scoredResultRow(best), score: best.score };
      });

    const handleProductListRepositories = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(
          PRODUCT_OPERATIONS["list-repositories"].request,
          body,
        );
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const args = normalizeListRepositoriesArgs(input.value);
        const query = repositoryStatsSelect(args.limit, args.offset);
        const rows = yield* sql.unsafe<JsonObject>(query.sql, query.params);
        const countRows = yield* sql.unsafe<JsonObject>(REPOSITORY_COUNT_SQL);
        const totalCount = jsonNumber(countRows[0]?.total_count) ?? 0;
        const repositories = rows.flatMap((row) => {
          const slug = jsonString(row.repository);
          if (!slug) {
            return [];
          }
          return [
            {
              slug,
              total: jsonNumber(row.total) ?? 0,
              active: jsonNumber(row.active) ?? 0,
              deprecated: jsonNumber(row.deprecated) ?? 0,
              superseded: jsonNumber(row.superseded) ?? 0,
            },
          ];
        });
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["list-repositories"].response, {
            ok: true,
            result: {
              repositories,
              count: repositories.length,
              total_count: totalCount,
              offset: args.offset,
              limit: args.limit,
              has_more: args.offset + repositories.length < totalCount,
            },
          }),
        );
      });

    const handleProductGet = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS["get"].request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const row = yield* fetchProductRow(
          input.value.repository,
          input.value.id,
        );
        if (!row) {
          return yield* HttpServerResponse.json(
            encodeResponse(ErrorBodySchema, {
              ok: false,
              error: `No memory found with id ${input.value.id} in repository '${input.value.repository}'.`,
            }),
            { status: 404 },
          );
        }
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["get"].response, {
            ok: true,
            result: row,
          }),
        );
      });

    const handleProductList = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS["list"].request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const args = normalizeMemoryListArgs(input.value);
        const filters = {
          status: args.status,
          memory_type: args.memory_type,
          certainty: args.certainty,
          tags: args.tags,
        };
        const query = listSelect(
          args.repository,
          filters,
          args.limit,
          args.offset,
        );
        const rows = yield* sql.unsafe<JsonObject>(query.sql, query.params);
        const countQuery = listCountSelect(args.repository, filters);
        const countRows = yield* sql.unsafe<JsonObject>(
          countQuery.sql,
          countQuery.params,
        );
        const totalCount = jsonNumber(countRows[0]?.total_count) ?? 0;
        const results = rows.map(toProductRow);
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["list"].response, {
            ok: true,
            result: {
              count: results.length,
              total_count: totalCount,
              offset: args.offset,
              limit: args.limit,
              has_more: args.offset + results.length < totalCount,
              results,
            },
          }),
        );
      });

    const handleProductDoctor = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS.doctor.request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const rows = yield* sql.unsafe<JsonObject>(
          `SELECT * FROM memories WHERE repository = ? AND status = 'active' ORDER BY updated_at DESC, id DESC`,
          [input.value.repository],
        );
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS.doctor.response, {
            ok: true,
            result: analyzeMemoryDoctor(input.value.repository, rows),
          }),
        );
      });

    const handleProductStats = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS.stats.request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const rows = yield* sql.unsafe<JsonObject>(
          "SELECT * FROM memories WHERE repository = ?",
          [input.value.repository],
        );
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS.stats.response, {
            ok: true,
            result: summarizeMemoryStats(input.value.repository, rows),
          }),
        );
      });

    const handleProductGc = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS.gc.request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const rows = yield* sql.unsafe<JsonObject>(
          `SELECT * FROM memories
           WHERE repository = ?
             AND status = 'active'
             AND expires_after_days IS NOT NULL
             AND datetime(updated_at, '+' || expires_after_days || ' days') <= datetime('now')
           ORDER BY updated_at ASC`,
          [input.value.repository],
        );
        const expired = rows.map(toProductRow);
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS.gc.response, {
            ok: true,
            result: {
              repository: input.value.repository,
              dry_run: true,
              count: expired.length,
              ids: expired.map((row) => row.id),
              expired,
            },
          }),
        );
      });

    const handleProductSize = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS["size"].request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const args = normalizeMemorySizeArgs(input.value);
        const size = embeddingSizeReport(
          embeddingTextForMemory({
            content: args.content,
            tags: args.tags ?? "",
            context: args.context ?? "",
            memory_type: args.memory_type,
            status: args.status,
            certainty: args.certainty,
          }),
        );
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["size"].response, {
            ok: true,
            result: { size },
          }),
        );
      });

    const handleProductVerify = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS["verify"].request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const row = yield* fetchProductRow(
          input.value.repository,
          input.value.id,
        );
        if (!row) {
          return yield* notFoundProduct(input.value.id, input.value.repository);
        }
        const result = compareMemoryFact(row.content, input.value.fact);
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["verify"].response, {
            ok: true,
            result: result.conflict
              ? {
                  id: input.value.id,
                  ok: false,
                  result: "conflict" as const,
                  similarity: result.similarity,
                  warning: "Conflict",
                }
              : {
                  id: input.value.id,
                  ok: true,
                  result: "consistent" as const,
                  similarity: result.similarity,
                },
          }),
        );
      });

    const notFoundProduct = (id: number, repository: string) =>
      HttpServerResponse.json(
        encodeResponse(ErrorBodySchema, {
          ok: false,
          error: `No memory found with id ${id} in repository '${repository}'.`,
        }),
        { status: 404 },
      );

    const handleProductDiff = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS["diff"].request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const row = yield* fetchProductRow(
          input.value.repository,
          input.value.id,
        );
        if (!row) {
          return yield* notFoundProduct(input.value.id, input.value.repository);
        }
        const result = compareMemoryFact(row.content, input.value.content);
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["diff"].response, {
            ok: true,
            result: {
              id: input.value.id,
              conflict: result.conflict,
              similarity: result.similarity,
              added_terms: result.added_terms,
              removed_terms: result.removed_terms,
            },
          }),
        );
      });

    const handleProductDelete = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS["delete"].request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const result = yield* d1
          .prepare(
            `DELETE FROM memories WHERE repository = ? AND id = ? RETURNING id`,
          )
          .bind(input.value.repository, input.value.id)
          .first<{ id: number }>();
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["delete"].response, {
            ok: true,
            result: {
              deleted_from: input.value.repository,
              id: input.value.id,
              deleted: result !== null,
              existed: result !== null,
            },
          }),
        );
      });

    const handleProductDeleteMany = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(
          PRODUCT_OPERATIONS["delete-many"].request,
          body,
        );
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const requestedIds = [...new Set(input.value.ids)];
        const rows = yield* d1
          .prepare(
            `DELETE FROM memories WHERE repository = ? AND id IN (SELECT value FROM json_each(?)) RETURNING id`,
          )
          .bind(input.value.repository, JSON.stringify(requestedIds))
          .all<{ id: number }>();
        const deleted = new Set(rows.results.map((row) => row.id));
        const deletedIds = requestedIds.filter((id) => deleted.has(id));
        const notFound = requestedIds.filter((id) => !deleted.has(id));
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["delete-many"].response, {
            ok: true,
            result: {
              deleted_from: input.value.repository,
              requested_ids: requestedIds,
              deleted_ids: deletedIds,
              not_found: notFound,
              count: deletedIds.length,
            },
          }),
        );
      });

    const deprecateProductRows = (
      repository: string,
      ids: readonly number[],
      status: "deprecated" | "superseded_by",
      supersededBy: number | null,
    ) =>
      Effect.gen(function* () {
        const rows = yield* d1
          .prepare(
            `UPDATE memories SET status = ?, superseded_by = ?, last_updated_by = 'api', updated_at = datetime('now'), update_count = COALESCE(update_count, 0) + 1 WHERE repository = ? AND id IN (SELECT value FROM json_each(?)) RETURNING *`,
          )
          .bind(status, supersededBy, repository, JSON.stringify(ids))
          .all<JsonObject>();
        const deprecated = rows.results.map(toProductRow);
        const changed = new Set(deprecated.map((row) => row.id));
        const notFound = ids.filter((id) => !changed.has(id));
        return { deprecated, notFound };
      });

    const handleProductDeprecate = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS.deprecate.request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const requestedIds = [...new Set(input.value.ids)];
        if (
          input.value.superseded_by !== undefined &&
          requestedIds.includes(input.value.superseded_by)
        ) {
          return yield* badRequest("A memory cannot supersede itself.");
        }
        const status =
          input.value.superseded_by === undefined
            ? ("deprecated" as const)
            : ("superseded_by" as const);
        const supersededBy = input.value.superseded_by ?? null;
        if (
          supersededBy !== null &&
          !(yield* fetchProductRow(input.value.repository, supersededBy))
        ) {
          return yield* badRequest(
            "Replacement must exist in the same repository.",
          );
        }
        const { deprecated, notFound } = yield* deprecateProductRows(
          input.value.repository,
          requestedIds,
          status,
          supersededBy,
        );
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS.deprecate.response, {
            ok: true,
            result: {
              written_to: input.value.repository,
              status,
              superseded_by: supersededBy,
              requested_ids: requestedIds,
              deprecated,
              not_found: notFound,
              count: deprecated.length,
            },
          }),
        );
      });

    const fetchKeywordScored = (
      ftsQuery: string,
      repository: string,
      filters: {
        status?: string;
        memory_type?: string;
        certainty?: string;
        tags?: string;
      },
      limit: number,
      terms: string[],
    ) =>
      Effect.gen(function* () {
        const rows = yield* fetchRankedProductRows(
          ftsQuery,
          repository,
          filters,
          100,
        );
        return scoreMemoryRows(rows, terms)
          .slice(0, limit)
          .map(scoredResultRow);
      });

    const fetchSemanticScored = (
      repository: string,
      query: string,
      topK: number,
      filters: { status?: string; memory_type?: string; certainty?: string },
      tags: string | undefined,
    ) =>
      Effect.gen(function* () {
        const values = yield* embed(query);
        const filter = vectorFilter(filters);
        const options = {
          namespace: repository,
          topK,
          returnMetadata: "all" as const,
        };
        if (Object.keys(filter).length > 0) {
          Object.assign(options, { filter });
        }
        const matches = yield* vectorize.query(values, options);
        const list = Schema.decodeUnknownSync(VectorizeSearchResultSchema)(
          matches,
        ).matches;
        return yield* resolveSemanticRows(repository, list, {
          ...filters,
          tags,
        });
      });

    const resolveSemanticRows = (
      repository: string,
      matches: ReadonlyArray<{ id: string; score: number }>,
      filters: {
        status?: string;
        memory_type?: string;
        certainty?: string;
        tags?: string;
      },
    ) =>
      Effect.gen(function* () {
        const collected: Array<ReturnType<typeof scoredResultRow>> = [];
        for (const match of matches) {
          const row = yield* resolveSemanticMatch(repository, match, filters);
          if (row) {
            collected.push(row);
          }
        }
        return collected;
      });

    const resolveSemanticMatch = (
      repository: string,
      match: { id: string; score: number },
      filters: {
        status?: string;
        memory_type?: string;
        certainty?: string;
        tags?: string;
      },
    ) =>
      Effect.gen(function* () {
        const id = Number(match.id);
        if (!Number.isInteger(id)) {
          return undefined;
        }
        const row = yield* fetchProductRow(repository, id);
        if (!row) {
          return undefined;
        }
        if (
          (filters.status !== undefined && row.status !== filters.status) ||
          (filters.memory_type !== undefined &&
            row.memory_type !== filters.memory_type) ||
          (filters.certainty !== undefined &&
            row.certainty !== filters.certainty) ||
          (filters.tags !== undefined &&
            !row.tags.toLowerCase().includes(filters.tags.toLowerCase()))
        ) {
          return undefined;
        }
        return { ...row, score: match.score };
      });

    const handleProductQuery = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS["query"].request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const args = normalizeMemoryQueryArgs(input.value);
        if (args.mode === "keyword") {
          return yield* keywordProductResponse(args);
        }
        try {
          validateEmbeddingText(args.query, "Query");
        } catch (error) {
          return yield* badRequest(
            error instanceof Error ? error.message : "Invalid query.",
          );
        }
        if (args.mode === "semantic") {
          return yield* semanticProductResponse(args);
        }
        return yield* hybridProductResponse(args);
      });

    const keywordProductResponse = (args: {
      repository: string;
      query: string;
      limit: number;
      status?: string;
      memory_type?: string;
      certainty?: string;
      tags?: string;
    }) =>
      Effect.gen(function* () {
        const terms = extractTerms(args.query);
        const ftsQuery = buildFtsQuery(terms);
        if (ftsQuery === undefined) {
          return yield* emptyQueryResponse();
        }
        const results = yield* fetchKeywordScored(
          ftsQuery,
          args.repository,
          {
            status: args.status,
            memory_type: args.memory_type,
            certainty: args.certainty,
            tags: args.tags,
          },
          args.limit,
          terms,
        );
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["query"].response, {
            ok: true,
            result: { count: results.length, results },
          }),
        );
      });

    const emptyQueryResponse = () =>
      HttpServerResponse.json(
        encodeResponse(PRODUCT_OPERATIONS["query"].response, {
          ok: true,
          result: { count: 0, results: [] },
        }),
      );

    const semanticProductResponse = (args: {
      repository: string;
      query: string;
      limit: number;
      status?: string;
      memory_type?: string;
      certainty?: string;
      tags?: string;
    }) =>
      Effect.gen(function* () {
        const topK = Math.min(args.limit * 3, SEARCH_LIMIT_MAX);
        const results = yield* fetchSemanticScored(
          args.repository,
          args.query,
          topK,
          {
            status: args.status,
            memory_type: args.memory_type,
            certainty: args.certainty,
          },
          args.tags,
        );
        const sliced = results.slice(0, args.limit);
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["query"].response, {
            ok: true,
            result: { count: sliced.length, results: sliced },
          }),
        );
      });

    const hybridProductResponse = (args: {
      repository: string;
      query: string;
      limit: number;
      status?: string;
      memory_type?: string;
      certainty?: string;
      tags?: string;
    }) =>
      Effect.gen(function* () {
        const terms = extractTerms(args.query);
        const ftsQuery = buildFtsQuery(terms);
        const keyword =
          ftsQuery === undefined
            ? []
            : yield* fetchKeywordScored(
                ftsQuery,
                args.repository,
                {
                  status: args.status,
                  memory_type: args.memory_type,
                  certainty: args.certainty,
                  tags: args.tags,
                },
                100,
                terms,
              );
        const semantic = yield* fetchSemanticScored(
          args.repository,
          args.query,
          args.limit,
          {
            status: args.status,
            memory_type: args.memory_type,
            certainty: args.certainty,
          },
          args.tags,
        );
        // Reciprocal-rank fusion compares ranks rather than unrelated lexical
        // and cosine score scales. Overlapping results receive both contributions.
        const byId = new Map<number, (typeof keyword)[number]>();
        for (const list of [keyword, semantic]) {
          for (const [rank, row] of list.entries()) {
            const previous = byId.get(row.id);
            byId.set(row.id, {
              ...row,
              score: (previous?.score ?? 0) + 1 / (60 + rank + 1),
            });
          }
        }
        const results = [...byId.values()]
          .sort((a, b) => b.score - a.score || a.id - b.id)
          .slice(0, args.limit);
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["query"].response, {
            ok: true,
            result: { count: results.length, results },
          }),
        );
      });

    const fetchSuggestNeighborhood = (
      repository: string,
      filters: {
        status?: string;
        memory_type?: string;
        certainty?: string;
        tags?: string;
      },
      tagHints: string[],
      pathHints: string[],
    ) =>
      Effect.gen(function* () {
        const select = neighborhoodSelect({
          repository,
          filters,
          tagHints,
          pathHints,
        });
        if (select === undefined) {
          return [];
        }
        const rows = yield* sql.unsafe<JsonObject>(select.sql, select.params);
        return rows.map(toRankedRow);
      });

    const handleProductSuggest = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(
          PRODUCT_OPERATIONS["suggest"].request,
          body,
        );
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const args = normalizeMemorySuggestArgs(input.value);
        return yield* suggestProductResponse(args);
      });

    const suggestProductResponse = (args: {
      repository: string;
      files: string;
      query?: string;
      limit: number;
      status?: string;
      memory_type?: string;
      certainty?: string;
      tags?: string;
    }) =>
      Effect.gen(function* () {
        const files = parseSuggestFilesParam(args.files);
        if (files.length === 0) {
          return yield* badRequest(
            "Provide at least one file path in files, e.g. 'src/auth/jwt.ts,src/middleware/session.ts'.",
          );
        }
        const pathTerms = extractPathTerms(files);
        const neighborhood = deriveFileNeighborhood(files);
        const queryTerms = args.query ? extractTerms(args.query) : [];
        const scoreTerms = uniqueLowerPreserveOrder([
          ...pathTerms,
          ...neighborhood.terms,
          ...queryTerms,
        ]);
        const ftsQuery = buildFtsQuery(
          uniqueLowerPreserveOrder([...pathTerms, ...queryTerms]),
        );
        const filters = {
          status: args.status,
          memory_type: args.memory_type,
          certainty: args.certainty,
          tags: args.tags,
        };
        const ftsRows =
          ftsQuery === undefined
            ? []
            : yield* fetchRankedProductRows(
                ftsQuery,
                args.repository,
                filters,
                100,
              );
        const neighborhoodRows = yield* fetchSuggestNeighborhood(
          args.repository,
          filters,
          neighborhood.tagHints,
          neighborhood.pathHints,
        );
        return yield* suggestJson({
          files,
          pathTerms,
          scoreTerms,
          neighborhood,
          ftsRows,
          neighborhoodRows,
          limit: args.limit,
        });
      });

    const suggestJson = (input: {
      files: string[];
      pathTerms: string[];
      scoreTerms: string[];
      neighborhood: { tagHints: string[]; pathHints: string[] };
      ftsRows: ReturnType<typeof toRankedRow>[];
      neighborhoodRows: ReturnType<typeof toRankedRow>[];
      limit: number;
    }) =>
      Effect.gen(function* () {
        const primary = scoreMemoryRows(input.ftsRows, input.scoreTerms);
        const secondary = scoreMemoryRows(
          input.neighborhoodRows,
          input.scoreTerms,
        );
        const results = mergeSuggestScored(primary, secondary)
          .slice(0, input.limit)
          .map(scoredResultRow);
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["suggest"].response, {
            ok: true,
            result: {
              files: input.files,
              normalized_path_terms: input.pathTerms,
              derived_terms: input.scoreTerms,
              neighborhood: {
                tags: input.neighborhood.tagHints,
                paths: input.neighborhood.pathHints,
              },
              count: results.length,
              results,
            },
          }),
        );
      });

    const mergeSuggestScored = (
      primary: ReturnType<typeof scoreMemoryRows>,
      secondary: ReturnType<typeof scoreMemoryRows>,
    ) => {
      const byId = new Map<number, (typeof primary)[number]>();
      for (const row of primary) {
        byId.set(row.id, row);
      }
      for (const row of secondary) {
        const existing = byId.get(row.id);
        if (!existing) {
          byId.set(row.id, {
            ...row,
            score: Number((row.score + 12).toFixed(3)),
          });
          continue;
        }
        byId.set(row.id, {
          ...existing,
          score: Number(Math.max(existing.score, row.score + 12).toFixed(3)),
        });
      }
      return [...byId.values()].sort((left, right) => right.score - left.score);
    };

    const insertProductRow = (input: InsertInput) =>
      Effect.gen(function* () {
        const result = yield* d1
          .prepare(`${INSERT_SQL} RETURNING *`)
          .bind(...insertParams(input))
          .first<JsonObject>();
        if (result === null) {
          return yield* Effect.die(
            new Error("Insert did not return a memory."),
          );
        }
        const row = toProductRow(result);
        return { id: row.id, row };
      });

    const fetchProductConflicts = (
      repository: string,
      content: string,
      tags: string,
      context: string,
      excludeId: number,
    ) =>
      Effect.gen(function* () {
        const terms = extractTerms([content, tags, context].join(" "));
        const ftsQuery = buildFtsQuery(terms);
        if (ftsQuery === undefined) {
          return [];
        }
        const rows = yield* fetchRankedProductRows(
          ftsQuery,
          repository,
          { status: "active" },
          5,
        );
        return scoreMemoryRows(rows, terms)
          .filter((candidate) => candidate.id !== excludeId)
          .slice(0, 5)
          .map(scoredResultRow);
      });

    const simpleProductAdd = (args: {
      repository: string;
      content: string;
      tags: string;
      context: string;
      memory_type: MemoryType;
      status: MemoryStatus;
      certainty: Certainty;
      expires_after_days?: number;
    }) =>
      Effect.gen(function* () {
        const size = embeddingSizeReport(
          embeddingTextForMemory({
            content: args.content,
            tags: args.tags,
            context: args.context,
            memory_type: args.memory_type,
            status: args.status,
            certainty: args.certainty,
          }),
        );
        if (!size.within_budget) {
          return yield* badRequest(
            `Document text must be at most 512 tokens for embedding.`,
          );
        }
        const inserted = yield* insertProductRow({
          repository: args.repository,
          content: args.content,
          tags: args.tags,
          context: args.context,
          memory_type: args.memory_type,
          status: args.status,
          certainty: args.certainty,
          expires_after_days: args.expires_after_days ?? null,
        });
        const conflicts = yield* fetchProductConflicts(
          args.repository,
          args.content,
          args.tags,
          args.context,
          inserted.id,
        );
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["add"].response, {
            ok: true,
            result: {
              written_to: args.repository,
              id: inserted.id,
              memory: inserted.row,
              size,
              potential_conflicts: conflicts,
            },
          }),
        );
      });

    // oxlint-disable-next-line max-statements -- upsert branches: strong update, weak refuse, weak force-create
    const upsertProductAdd = (args: {
      repository: string;
      content: string;
      tags?: string;
      context?: string;
      memory_type: MemoryType;
      status: MemoryStatus;
      certainty: Certainty;
      expires_after_days?: number;
      force?: boolean;
      upsert_threshold: number;
      upsertQuery: string;
      provided: { memory_type?: MemoryType; certainty?: Certainty };
    }) =>
      Effect.gen(function* () {
        const tags = args.tags ?? "";
        const context = args.context ?? "";
        const best = yield* findBestProductMatch(
          args.repository,
          args.upsertQuery,
        );
        if (!best) {
          return yield* simpleProductAdd({ ...args, tags, context });
        }
        const check = compareMemoryFact(
          [best.row.content, best.row.tags, best.row.context].join(" "),
          [args.content, tags, context].join(" "),
        );
        const strong =
          check.similarity >= UPSERT_MIN_SIMILARITY &&
          best.score >= args.upsert_threshold;
        const info = {
          id: best.row.id,
          score: best.score,
          similarity: check.similarity,
          memory_type: best.row.memory_type,
          status: best.row.status,
          content_head: contentHead(best.row.content),
        };
        if (!strong && !args.force) {
          return yield* badRequest(
            `Best match #${info.id} is not a strong upsert match (score ${info.score}, similarity ${info.similarity}; needs score >= ${args.upsert_threshold} AND similarity >= ${UPSERT_MIN_SIMILARITY}). Inspect it with product/get, rerun with force true, or lower upsert_threshold.`,
          );
        }
        if (!strong) {
          return yield* forceCreateWithMatch(args, tags, context, info);
        }
        return yield* applyStrongUpsert(
          {
            ...args,
            memory_type: args.provided.memory_type,
            certainty: args.provided.certainty,
          },
          best,
          info,
        );
      });

    const forceCreateWithMatch = (
      args: {
        repository: string;
        content: string;
        memory_type: MemoryType;
        status: MemoryStatus;
        certainty: Certainty;
        expires_after_days?: number;
      },
      tags: string,
      context: string,
      info: UpsertMatchInfo,
    ) =>
      Effect.gen(function* () {
        const size = embeddingSizeReport(
          embeddingTextForMemory({
            content: args.content,
            tags,
            context,
            memory_type: args.memory_type,
            status: args.status,
            certainty: args.certainty,
          }),
        );
        if (!size.within_budget) {
          return yield* badRequest(
            `Document text must be at most 512 tokens for embedding.`,
          );
        }
        const inserted = yield* insertProductRow({
          repository: args.repository,
          content: args.content,
          tags,
          context,
          memory_type: args.memory_type,
          status: args.status,
          certainty: args.certainty,
          expires_after_days: args.expires_after_days ?? null,
        });
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["add"].response, {
            ok: true,
            // SAFETY: upsert info carries contract string enums from the matched row.
            result: {
              written_to: args.repository,
              id: inserted.id,
              memory: inserted.row,
              size,
              upsert_match: info,
            },
          }),
        );
      });

    const applyStrongUpsert = (
      args: {
        repository: string;
        content: string;
        tags?: string;
        context?: string;
        memory_type?: MemoryType;
        certainty?: Certainty;
        expires_after_days?: number;
      },
      best: { row: ReturnType<typeof scoredResultRow>; score: number },
      info: UpsertMatchInfo,
    ) =>
      Effect.gen(function* () {
        const existing = yield* fetchProductRow(args.repository, best.row.id);
        if (!existing || existing.status !== "active") {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "Match changed; retry." },
            { status: 409 },
          );
        }
        const prospective = {
          content: args.content,
          tags: args.tags ?? existing.tags,
          context: args.context ?? existing.context,
          memory_type: args.memory_type ?? existing.memory_type,
          status: existing.status,
          certainty: args.certainty ?? existing.certainty,
        };
        if (
          args.expires_after_days !== undefined &&
          prospective.memory_type !== "status"
        ) {
          return yield* badRequest(
            "expires_after_days is only valid for status memories.",
          );
        }
        const size = embeddingSizeReport(embeddingTextForMemory(prospective));
        if (!size.within_budget) {
          return yield* badRequest(
            `Document text must be at most 512 tokens for embedding.`,
          );
        }
        const update = updateSets({
          content: args.content,
          tags: args.tags,
          context: args.context,
          memory_type: args.memory_type,
          certainty: args.certainty,
          expires_after_days:
            prospective.memory_type !== "status"
              ? null
              : args.expires_after_days,
        })!; // Content is required, so updateSets always has a field.
        const rowData = yield* d1
          .prepare(
            `UPDATE memories SET ${update.sql} WHERE repository = ? AND id = ? AND status = 'active' AND update_count = ? RETURNING *`,
          )
          .bind(
            ...update.params,
            args.repository,
            best.row.id,
            existing.update_count,
          )
          .first<JsonObject>();
        if (rowData === null) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "Memory changed concurrently; retry." },
            { status: 409 },
          );
        }
        const row = toProductRow(rowData);
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["add"].response, {
            ok: true,
            // SAFETY: upsert info carries contract string enums from the matched row.
            result: {
              mode: "updated",
              written_to: args.repository,
              id: best.row.id,
              memory: row,
              size,
              upsert_match: info,
            },
          }),
        );
      });

    const handleProductAdd = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS["add"].request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const args = normalizeMemoryAddArgs(input.value);
        if (
          args.expires_after_days !== undefined &&
          args.memory_type !== "status" &&
          args.upsert_match === undefined
        ) {
          return yield* badRequest(
            "expires_after_days is only valid for status memories.",
          );
        }
        const upsertQuery = args.upsert_match?.trim() || undefined;
        if (upsertQuery === undefined) {
          return yield* simpleProductAdd({
            repository: args.repository,
            content: args.content,
            tags: args.tags ?? "",
            context: args.context ?? "",
            memory_type: args.memory_type,
            status: args.status,
            certainty: args.certainty,
            expires_after_days: args.expires_after_days,
          });
        }
        return yield* upsertProductAdd({
          ...args,
          upsertQuery,
          provided: input.value,
        });
      });

    const handleProductUpdate = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(PRODUCT_OPERATIONS["update"].request, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const args = input.value;
        const matchQuery = args.match?.trim() || undefined;
        if (args.id !== undefined && matchQuery !== undefined) {
          return yield* badRequest(
            "Provide either the numeric id or a match query, not both.",
          );
        }
        const resolved = yield* resolveUpdateTarget(
          args.repository,
          args.id,
          matchQuery,
        );
        if (!resolved.ok) {
          return resolved.response;
        }
        return yield* applyProductUpdate(
          args.repository,
          resolved.targetId,
          {
            content: args.content,
            tags: args.tags,
            context: args.context,
            memory_type: args.memory_type,
            certainty: args.certainty,
            status: args.status,
            expires_after_days: args.expires_after_days,
            superseded_by: args.superseded_by,
          },
          resolved.matched,
        );
      });

    const resolveUpdateTarget = (
      repository: string,
      id: number | undefined,
      match: string | undefined,
    ) =>
      Effect.gen(function* () {
        if (match !== undefined) {
          const best = yield* findBestProductMatch(repository, match);
          if (!best) {
            const response = yield* HttpServerResponse.json(
              encodeResponse(ErrorBodySchema, {
                ok: false,
                error: `No active memory matched '${match}' in repository '${repository}'.`,
              }),
              { status: 404 },
            );
            return { ok: false as const, response };
          }
          return {
            ok: true as const,
            targetId: best.row.id,
            matched: { query: match, id: best.row.id, score: best.score },
          };
        }
        if (id === undefined) {
          const response = yield* badRequest(
            "Provide either the numeric id or a match query.",
          );
          return { ok: false as const, response };
        }
        return { ok: true as const, targetId: id, matched: undefined };
      });

    const validateUpdateFields = (
      existing: ReturnType<typeof toProductRow>,
      targetId: number,
      fields: {
        superseded_by?: number;
        memory_type?: MemoryType;
        expires_after_days?: number;
      },
    ): string | undefined => {
      if (
        fields.superseded_by !== undefined &&
        fields.superseded_by === targetId
      ) {
        return "A memory cannot supersede itself.";
      }
      const prospectiveType = fields.memory_type ?? existing.memory_type;
      if (
        fields.expires_after_days !== undefined &&
        prospectiveType !== "status"
      ) {
        return "expires_after_days is only valid for status memories.";
      }
      return undefined;
    };

    const prospectiveUpdateText = (
      existing: ReturnType<typeof toProductRow>,
      fields: {
        content?: string;
        tags?: string;
        context?: string;
        memory_type?: MemoryType;
        certainty?: Certainty;
        status?: MemoryStatus;
      },
    ) =>
      embeddingTextForMemory({
        content: fields.content ?? existing.content,
        tags: fields.tags ?? existing.tags,
        context: fields.context ?? existing.context,
        memory_type: fields.memory_type ?? existing.memory_type,
        status: fields.status ?? existing.status,
        certainty: fields.certainty ?? existing.certainty,
      });

    const applyProductUpdate = (
      repository: string,
      targetId: number,
      fields: {
        content?: string;
        tags?: string;
        context?: string;
        memory_type?: MemoryType;
        certainty?: Certainty;
        status?: MemoryStatus;
        expires_after_days?: number;
        superseded_by?: number;
      },
      matched: { query: string; id: number; score: number } | undefined,
    ) =>
      Effect.gen(function* () {
        const existing = yield* fetchProductRow(repository, targetId);
        if (!existing) {
          return yield* HttpServerResponse.json(
            encodeResponse(ErrorBodySchema, {
              ok: false,
              error: `No memory found with id ${targetId} in repository '${repository}'.`,
            }),
            { status: 404 },
          );
        }
        const invalid = validateUpdateFields(existing, targetId, fields);
        if (invalid !== undefined) {
          return yield* badRequest(invalid);
        }
        if (matched !== undefined && existing.status !== "active") {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "Match is no longer active; retry." },
            { status: 409 },
          );
        }
        if (
          fields.superseded_by !== undefined &&
          !(yield* fetchProductRow(repository, fields.superseded_by))
        ) {
          return yield* badRequest(
            "Replacement must exist in the same repository.",
          );
        }
        const size = embeddingSizeReport(
          prospectiveUpdateText(existing, fields),
        );
        if (
          (fields.status ?? existing.status) === "active" &&
          !size.within_budget
        ) {
          return yield* badRequest(
            `Document text must be at most 512 tokens for embedding.`,
          );
        }
        return yield* persistProductUpdate(
          repository,
          targetId,
          existing,
          fields,
          { size, matched },
        );
      });

    const persistProductUpdate = (
      repository: string,
      targetId: number,
      existing: ReturnType<typeof toProductRow>,
      fields: {
        content?: string;
        tags?: string;
        context?: string;
        memory_type?: MemoryType;
        certainty?: Certainty;
        status?: MemoryStatus;
        expires_after_days?: number;
        superseded_by?: number;
      },
      outcome: {
        size: ReturnType<typeof embeddingSizeReport>;
        matched: { query: string; id: number; score: number } | undefined;
      },
    ) =>
      Effect.gen(function* () {
        const update = updateSets({
          ...fields,
          expires_after_days:
            (fields.memory_type ?? existing.memory_type) !== "status" &&
            existing.expires_after_days !== null
              ? null
              : fields.expires_after_days,
        });
        let row = existing;
        if (update !== undefined) {
          const rowData = yield* d1
            .prepare(
              `UPDATE memories SET ${update.sql} WHERE repository = ? AND id = ? AND update_count = ?${outcome.matched !== undefined ? " AND status = 'active'" : ""} RETURNING *`,
            )
            .bind(...update.params, repository, targetId, existing.update_count)
            .first<JsonObject>();
          if (rowData === null) {
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: "Memory changed concurrently; retry." },
              { status: 409 },
            );
          }
          row = toProductRow(rowData);
        }
        const result: MemoryWriteResult = {
          written_to: repository,
          id: targetId,
          memory: row,
          size: outcome.size,
        };
        if (outcome.matched !== undefined) {
          Object.assign(result, { matched: outcome.matched });
        }
        return yield* HttpServerResponse.json(
          encodeResponse(PRODUCT_OPERATIONS["update"].response, {
            ok: true,
            result,
          }),
        );
      });

    const productHandlers = {
      query: handleProductQuery,
      get: handleProductGet,
      list: handleProductList,
      suggest: handleProductSuggest,
      add: handleProductAdd,
      update: handleProductUpdate,
      delete: handleProductDelete,
      "delete-many": handleProductDeleteMany,
      deprecate: handleProductDeprecate,
      doctor: handleProductDoctor,
      stats: handleProductStats,
      gc: handleProductGc,
      verify: handleProductVerify,
      diff: handleProductDiff,
      size: handleProductSize,
      "list-repositories": handleProductListRepositories,
    } satisfies Record<ProductRoute, RestHandlerFn>;
    const wakeSafely = wake.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Vector wake failed; cron will retry.", cause),
      ),
    );
    const handleProduct = (route: ProductRoute, body: JsonValue) =>
      productHandlers[route](body).pipe(Effect.tap(() => wakeSafely));

    const restHandlers = {
      expectedToken,
      handleQuery: (body) =>
        handleQuery(body).pipe(Effect.tap(() => wakeSafely)),
      handleMigration: (body) =>
        handleMigration(body).pipe(Effect.tap(() => wakeSafely)),
      handleMigrationLinks: (body) =>
        handleMigrationLinks(body).pipe(Effect.tap(() => wakeSafely)),
      handleVectorizeUpsert: (body) =>
        handleVectorizeUpsert(body).pipe(Effect.tap(() => wakeSafely)),
      handleVectorizeSearch,
      handleVectorizeDelete: (body) =>
        handleVectorizeDelete(body).pipe(Effect.tap(() => wakeSafely)),
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
    const expectedToken = yield* Config.Redacted(
      "MACHINE_MEMORY_DB_TOKEN",
    ).pipe(Effect.orDie);
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
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* handleRestRequest(restHandlers, request);
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              encodeResponse(ErrorBodySchema, {
                ok: false,
                error: INTERNAL_ERROR,
              }),
              { status: 500 },
            ),
          ),
        ),
      ),
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
