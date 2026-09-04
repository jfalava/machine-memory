import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  composeEmbeddingText,
  decodeRequest,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embeddingSizeReport,
  encodeResponse,
  ErrorBodySchema,
  isJsonArray,
  jsonNumber,
  jsonObject,
  ListRepositoriesArgsInputSchema,
  ListRepositoriesSuccessSchema,
  MemoryAddArgsInputSchema,
  MemoryDeleteArgsSchema,
  MemoryDeleteSuccessSchema,
  MemoryDiffArgsSchema,
  MemoryDiffSuccessSchema,
  MemoryGetArgsSchema,
  MemoryGetSuccessSchema,
  MemoryListArgsInputSchema,
  MemoryListSuccessSchema,
  MemoryQueryArgsInputSchema,
  MemoryQuerySuccessSchema,
  MemorySizeArgsInputSchema,
  MemorySizeSuccessSchema,
  MemorySuggestArgsInputSchema,
  MemorySuggestSuccessSchema,
  MemoryUpdateArgsSchema,
  MemoryVerifyArgsSchema,
  MemoryVerifySuccessSchema,
  MemoryWriteSuccessSchema,
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
  type MigrationRequest,
  type QueryRequest,
  type VectorizeSearchRequest,
  type VectorizeUpsertRequest,
} from "@machine-memory/contract";
import {
  buildFtsQuery,
  compareMemoryFact,
  contentHead,
  deriveFileNeighborhood,
  embeddingTextForMemory,
  extractPathTerms,
  extractTerms,
  parseSuggestFilesParam,
  scoredResultRow,
  scoreMemoryRows,
  toProductRow,
  toRankedRow,
  uniqueLowerPreserveOrder,
  UPSERT_MIN_SIMILARITY,
} from "./product-logic";
import {
  distinctRepositoriesSelect,
  ftsSelect,
  INSERT_SQL,
  insertParams,
  listSelect,
  neighborhoodSelect,
  rowByIdSelect,
  updateSets,
  vectorFilter,
  type InsertInput,
} from "./product-api";
import { Database } from "../../iac/src/database";
import { apiName } from "../../iac/src/config";
import { VectorIndex } from "../../iac/src/vectorize";
import { handleRestRequest, type RestHandlers } from "./rest-handlers";

const INTERNAL_ERROR = "Internal server error.";
const RATE_LIMIT_ERROR = "Too Many Requests";

function isRateLimitedVectorizeCause(cause: unknown): boolean {
  return /(?:too many requests|rate[ -]?limit|\b429\b|40041)/i.test(
    String(cause),
  );
}

function badRequest(error: string) {
  return HttpServerResponse.json(
    encodeResponse(ErrorBodySchema, { ok: false, error }),
    { status: 400 },
  );
}

function parseEmbedding(value: JsonValue): number[] {
  const data = jsonObject(value)?.data;
  if (!isJsonArray(data) || data.length !== 1) {
    throw new Error("Workers AI returned an invalid embedding response.");
  }
  const embedding = data[0];
  if (embedding === undefined || !isJsonArray(embedding)) {
    throw new Error("Workers AI returned an invalid embedding response.");
  }
  const numericEmbedding = embedding.flatMap((component) => {
    const number = jsonNumber(component);
    return number === undefined ? [] : [number];
  });
  if (
    numericEmbedding.length !== EMBEDDING_DIMENSIONS ||
    numericEmbedding.length !== embedding.length
  ) {
    throw new Error(
      `Workers AI returned an embedding with an invalid dimension; expected ${EMBEDDING_DIMENSIONS}.`,
    );
  }
  return numericEmbedding;
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

type MigrationItem = {
  readonly source_id: number;
  readonly target_id: number;
  readonly status: "inserted" | "duplicate";
};

type MigrationBatchAccumulator = {
  readonly items: MigrationItem[];
  readonly inserted: number;
  readonly duplicates: number;
};

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

export default Cloudflare.Worker<{}>()(
  "machine-memory-api",
  { main: import.meta.url, name: apiName, workersDev: false },
  // oxlint-disable-next-line max-statements -- worker wires low-level SQL/migrate/vectorize plus product handlers
  Effect.gen(function* () {
    const vectorIndex = yield* VectorIndex;
    const d1 = yield* Cloudflare.D1.QueryDatabase(Database);
    const sql = yield* SQL.D1(d1);
    const vectorize = yield* Cloudflare.Vectorize.SearchIndex(vectorIndex);
    const ai = yield* Cloudflare.Workers.AI();
    const expectedToken = yield* Config.redacted(
      "MACHINE_MEMORY_DB_TOKEN",
    ).pipe(Effect.orDie);
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

    const migrateOneRow = (
      request: MigrationRequest,
      row: MigrationRequest["rows"][number],
      batch: MigrationBatchAccumulator,
    ) =>
      Effect.gen(function* () {
        const existing = yield* sql.unsafe<{ id: number }>(
          `SELECT id FROM memories
           WHERE repository = ?
             AND status = 'active'
             AND content = ?
             AND tags = ?
             AND context = ?
           LIMIT 1`,
          [request.repository, row.content, row.tags, row.context],
        );
        const duplicate = existing[0];
        if (duplicate) {
          batch.items.push(
            migrationDuplicateItem(row.source_id, Number(duplicate.id)),
          );
          return {
            items: batch.items,
            inserted: batch.inserted,
            duplicates: batch.duplicates + 1,
          } satisfies MigrationBatchAccumulator;
        }

        const result = yield* d1
          .prepare(
            `INSERT INTO memories (
               repository, content, tags, context, memory_type, status,
               superseded_by, source_agent, last_updated_by, update_count,
               certainty, refs, expires_after_days, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
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
          )
          .run();
        batch.items.push(
          migrationInsertedItem(row.source_id, Number(result.meta.last_row_id)),
        );
        return {
          items: batch.items,
          inserted: batch.inserted + 1,
          duplicates: batch.duplicates,
        } satisfies MigrationBatchAccumulator;
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
        let batch: MigrationBatchAccumulator = {
          items: [],
          inserted: 0,
          duplicates: 0,
        };
        for (const row of request.rows) {
          batch = yield* migrateOneRow(request, row, batch);
        }
        return yield* HttpServerResponse.json(
          encodeResponse(MigrationSuccessSchema, {
            ok: true,
            result: {
              processed: request.rows.length,
              inserted: batch.inserted,
              duplicates: batch.duplicates,
              items: batch.items,
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

        let updated = 0;
        for (const link of input.value.links) {
          const result = yield* d1
            .prepare(
              `UPDATE memories
               SET superseded_by = ?
               WHERE repository = ? AND id = ?`,
            )
            .bind(
              link.superseded_by_target_id,
              input.value.repository,
              link.target_id,
            )
            .run();
          updated += result.meta.changes;
        }

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
        const values = yield* embed(embeddingTextForDocument(document));
        const result = yield* vectorize
          .upsert([
            {
              id,
              namespace: document.repository,
              values,
              metadata: {
                status: document.status,
                memory_type: document.memory_type,
                certainty: document.certainty,
              },
            },
          ])
          .pipe(
            Effect.map((mutation) => ({
              ok: true as const,
              mutation,
            })),
            Effect.catchCause((cause) =>
              Effect.succeed({
                ok: false as const,
                rateLimited: isRateLimitedVectorizeCause(cause),
              }),
            ),
          );
        if (!result.ok) {
          return yield* HttpServerResponse.json(
            encodeResponse(ErrorBodySchema, {
              ok: false,
              error: result.rateLimited ? RATE_LIMIT_ERROR : INTERNAL_ERROR,
            }),
            { status: result.rateLimited ? 429 : 500 },
          );
        }
        const mutation = result.mutation;
        return yield* HttpServerResponse.json(
          encodeResponse(VectorizeUpsertSuccessSchema, {
            ok: true,
            result: {
              id,
              namespace: document.repository,
              mutationId: mutation.mutationId,
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
        // VectorizeMatches is a structural CF type; re-enter as JSON for the wire schema.
        const result = Schema.decodeUnknownSync(Schema.Json)(matches);
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
        const mutation = yield* vectorize.deleteByIds([id]);
        return yield* HttpServerResponse.json(
          encodeResponse(VectorizeDeleteSuccessSchema, {
            ok: true,
            result: { id, mutationId: mutation.mutationId },
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
      filters: { status?: string; memory_type?: string; certainty?: string; tags?: string },
      limit: number,
    ) =>
      Effect.gen(function* () {
        const query = ftsSelect(ftsQuery, repository, filters, limit);
        const rows = yield* sql.unsafe<JsonObject>(query.sql, query.params);
        return rows.map(toRankedRow);
      });

    const syncProductVector = (row: {
      id: number;
      repository: string;
      content: string;
      tags: string;
      context: string;
      memory_type: string;
      status: string;
      certainty: string;
    }) =>
      Effect.gen(function* () {
        const values = yield* embed(embeddingTextForMemory(row));
        yield* vectorize
          .upsert([
            {
              id: String(row.id),
              namespace: row.repository,
              values,
              metadata: {
                status: row.status,
                memory_type: row.memory_type,
                certainty: row.certainty,
              },
            },
          ])
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                console.error(
                  `product memory ${row.id} saved but vector sync failed: ${String(cause)}`,
                );
              }),
            ),
          );
      });

    const findBestProductMatch = (repository: string, query: string) =>
      Effect.gen(function* () {
        const terms = extractTerms(query);
        const ftsQuery = buildFtsQuery(terms);
        if (ftsQuery === undefined) {
          return null;
        }
        const rows = yield* fetchRankedProductRows(ftsQuery, repository, {}, 5);
        const scored = scoreMemoryRows(rows, terms);
        const best = scored[0];
        if (!best) {
          return null;
        }
        return { row: scoredResultRow(best), score: best.score };
      });

    const handleProductListRepositories = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(ListRepositoriesArgsInputSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const args = normalizeListRepositoriesArgs(input.value);
        const query = distinctRepositoriesSelect(args.limit);
        const rows = yield* sql.unsafe<JsonObject>(query.sql, query.params);
        const repositories = rows
          .map((row) => String(row.repository ?? ""))
          .filter((repo) => repo.length > 0);
        return yield* HttpServerResponse.json(
          encodeResponse(ListRepositoriesSuccessSchema, {
            ok: true,
            result: { repositories, count: repositories.length },
          }),
        );
      });

    const handleProductGet = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(MemoryGetArgsSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const row = yield* fetchProductRow(input.value.repository, input.value.id);
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
          encodeResponse(MemoryGetSuccessSchema, { ok: true, result: row }),
        );
      });

    const handleProductList = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(MemoryListArgsInputSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const args = normalizeMemoryListArgs(input.value);
        const query = listSelect(
          args.repository,
          {
            status: args.status,
            memory_type: args.memory_type,
            certainty: args.certainty,
            tags: args.tags,
          },
          args.limit,
        );
        const rows = yield* sql.unsafe<JsonObject>(query.sql, query.params);
        const results = rows.map(toProductRow);
        return yield* HttpServerResponse.json(
          encodeResponse(MemoryListSuccessSchema, {
            ok: true,
            result: { count: results.length, results },
          }),
        );
      });

    const handleProductSize = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(MemorySizeArgsInputSchema, body);
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
          encodeResponse(MemorySizeSuccessSchema, {
            ok: true,
            result: { size },
          }),
        );
      });

    const handleProductVerify = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(MemoryVerifyArgsSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const row = yield* fetchProductRow(input.value.repository, input.value.id);
        if (!row) {
          return yield* notFoundProduct(input.value.id, input.value.repository);
        }
        const result = compareMemoryFact(row.content, input.value.fact);
        return yield* HttpServerResponse.json(
          encodeResponse(MemoryVerifySuccessSchema, {
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
      Effect.gen(function* () {
        return yield* HttpServerResponse.json(
          encodeResponse(ErrorBodySchema, {
            ok: false,
            error: `No memory found with id ${id} in repository '${repository}'.`,
          }),
          { status: 404 },
        );
      });

    const handleProductDiff = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(MemoryDiffArgsSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const row = yield* fetchProductRow(input.value.repository, input.value.id);
        if (!row) {
          return yield* notFoundProduct(input.value.id, input.value.repository);
        }
        const result = compareMemoryFact(row.content, input.value.content);
        return yield* HttpServerResponse.json(
          encodeResponse(MemoryDiffSuccessSchema, {
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
        const input = decodeRequest(MemoryDeleteArgsSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const existing = yield* fetchProductRow(
          input.value.repository,
          input.value.id,
        );
        const result = yield* d1
          .prepare(`DELETE FROM memories WHERE repository = ? AND id = ?`)
          .bind(input.value.repository, input.value.id)
          .run();
        yield* cleanupProductVector(input.value.id);
        return yield* HttpServerResponse.json(
          encodeResponse(MemoryDeleteSuccessSchema, {
            ok: true,
            result: {
              deleted_from: input.value.repository,
              id: input.value.id,
              deleted: result.meta.changes > 0,
              existed: existing !== undefined,
            },
          }),
        );
      });

    const cleanupProductVector = (id: number) =>
      vectorize.deleteByIds([String(id)]).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error(
              `product memory ${id} deleted but vector cleanup failed: ${String(cause)}`,
            );
          }),
        ),
      );

    const fetchKeywordScored = (
      ftsQuery: string,
      repository: string,
      filters: { status?: string; memory_type?: string; certainty?: string; tags?: string },
      limit: number,
      terms: string[],
    ) =>
      Effect.gen(function* () {
        const rows = yield* fetchRankedProductRows(ftsQuery, repository, filters, 100);
        return scoreMemoryRows(rows, terms).slice(0, limit).map(scoredResultRow);
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
        // SAFETY: vectorize.query expects Cloudflare VectorizeQueryOptions; shape matches.
        const matches = yield* vectorize.query(values, options as never);
        // SAFETY: Vectorize matches payload is opaque JSON with id/score entries.
        const list = (matches as { matches?: Array<{ id: string; score: number }> }).matches ?? [];
        return yield* resolveSemanticRows(repository, list, tags);
      });

    const resolveSemanticRows = (
      repository: string,
      matches: Array<{ id: string; score: number }>,
      tags: string | undefined,
    ) =>
      Effect.gen(function* () {
        const collected: Array<ReturnType<typeof scoredResultRow>> = [];
        for (const match of matches) {
          const row = yield* resolveSemanticMatch(repository, match, tags);
          if (row) {
            collected.push(row);
          }
        }
        return collected;
      });

    const resolveSemanticMatch = (
      repository: string,
      match: { id: string; score: number },
      tags: string | undefined,
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
        if (tags !== undefined && !row.tags.toLowerCase().includes(tags.toLowerCase())) {
          return undefined;
        }
        return { ...row, score: match.score };
      });

    const handleProductQuery = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(MemoryQueryArgsInputSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const args = normalizeMemoryQueryArgs(input.value);
        if (args.mode === "keyword") {
          return yield* keywordProductResponse(args);
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
          encodeResponse(MemoryQuerySuccessSchema, {
            ok: true,
            result: { count: results.length, results },
          }),
        );
      });

    const emptyQueryResponse = () =>
      Effect.gen(function* () {
        return yield* HttpServerResponse.json(
          encodeResponse(MemoryQuerySuccessSchema, {
            ok: true,
            result: { count: 0, results: [] },
          }),
        );
      });

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
        const topK = Math.min(args.limit * 3, 50);
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
          encodeResponse(MemoryQuerySuccessSchema, {
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
        const byId = new Map<number, (typeof keyword)[number]>();
        for (const row of keyword) {
          byId.set(row.id, row);
        }
        for (const row of semantic) {
          if (!byId.has(row.id)) {
            byId.set(row.id, row);
          }
        }
        const results = [...byId.values()].slice(0, args.limit);
        return yield* HttpServerResponse.json(
          encodeResponse(MemoryQuerySuccessSchema, {
            ok: true,
            result: { count: results.length, results },
          }),
        );
      });

    const fetchSuggestNeighborhood = (
      repository: string,
      filters: { status?: string; memory_type?: string; certainty?: string; tags?: string },
      tagHints: string[],
      pathHints: string[],
    ) =>
      Effect.gen(function* () {
        const select = neighborhoodSelect({ repository, filters, tagHints, pathHints });
        if (select === undefined) {
          return [];
        }
        const rows = yield* sql.unsafe<JsonObject>(select.sql, select.params);
        return rows.map(toRankedRow);
      });

    const handleProductSuggest = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(MemorySuggestArgsInputSchema, body);
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
            : yield* fetchRankedProductRows(ftsQuery, args.repository, filters, 100);
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
        const secondary = scoreMemoryRows(input.neighborhoodRows, input.scoreTerms);
        const results = mergeSuggestScored(primary, secondary)
          .slice(0, input.limit)
          .map(scoredResultRow);
        return yield* HttpServerResponse.json(
          encodeResponse(MemorySuggestSuccessSchema, {
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
          byId.set(row.id, { ...row, score: Number((row.score + 12).toFixed(3)) });
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
        const result = yield* d1.prepare(INSERT_SQL).bind(...insertParams(input)).run();
        const id = Number(result.meta.last_row_id);
        const row = yield* fetchProductRow(input.repository, id);
        const memory = row ?? {
          id,
          repository: input.repository,
          content: input.content,
          tags: input.tags,
          context: input.context,
          memory_type: input.memory_type,
          status: input.status,
          certainty: input.certainty,
        };
        yield* syncProductVector(memory);
        return { id, row: memory };
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
        const rows = yield* fetchRankedProductRows(ftsQuery, repository, {}, 5);
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
      memory_type: "convention" | "decision" | "gotcha" | "preference" | "constraint" | "reference" | "status";
      status: "active" | "deprecated" | "superseded_by";
      certainty: "verified" | "inferred" | "speculative";
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
          return yield* badRequest(`Document text must be at most 512 tokens for embedding.`);
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
          encodeResponse(MemoryWriteSuccessSchema, {
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
      memory_type: "convention" | "decision" | "gotcha" | "preference" | "constraint" | "reference" | "status";
      status: "active" | "deprecated" | "superseded_by";
      certainty: "verified" | "inferred" | "speculative";
      expires_after_days?: number;
      force?: boolean;
      upsert_threshold: number;
      upsertQuery: string;
    }) =>
      Effect.gen(function* () {
        const tags = args.tags ?? "";
        const context = args.context ?? "";
        const best = yield* findBestProductMatch(args.repository, args.upsertQuery);
        if (!best) {
          return yield* simpleProductAdd({ ...args, tags, context });
        }
        const check = compareMemoryFact(
          [best.row.content, best.row.tags, best.row.context].join(" "),
          [args.content, tags, context].join(" "),
        );
        const strong =
          check.similarity >= UPSERT_MIN_SIMILARITY && best.score >= args.upsert_threshold;
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
        return yield* applyStrongUpsert(args, tags, context, best, info);
      });

    const forceCreateWithMatch = (
      args: {
        repository: string;
        content: string;
        memory_type: "convention" | "decision" | "gotcha" | "preference" | "constraint" | "reference" | "status";
        status: "active" | "deprecated" | "superseded_by";
        certainty: "verified" | "inferred" | "speculative";
        expires_after_days?: number;
      },
      tags: string,
      context: string,
      info: { id: number; score: number; similarity: number; memory_type: string; status: string; content_head: string },
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
          return yield* badRequest(`Document text must be at most 512 tokens for embedding.`);
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
          encodeResponse(MemoryWriteSuccessSchema, {
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
        memory_type?: "convention" | "decision" | "gotcha" | "preference" | "constraint" | "reference" | "status";
        certainty?: "verified" | "inferred" | "speculative";
        expires_after_days?: number;
      },
      tags: string,
      context: string,
      best: { row: ReturnType<typeof scoredResultRow>; score: number },
      info: { id: number; score: number; similarity: number; memory_type: string; status: string; content_head: string },
    ) =>
      Effect.gen(function* () {
        const prospective = {
          content: args.content,
          tags: args.tags ?? best.row.tags,
          context: args.context ?? best.row.context,
          memory_type: args.memory_type ?? best.row.memory_type,
          status: best.row.status,
          certainty: args.certainty ?? best.row.certainty,
        };
        const size = embeddingSizeReport(embeddingTextForMemory(prospective));
        if (!size.within_budget) {
          return yield* badRequest(`Document text must be at most 512 tokens for embedding.`);
        }
        const update = updateSets({
          content: args.content,
          tags: args.tags,
          context: args.context,
          memory_type: args.memory_type,
          certainty: args.certainty,
          expires_after_days: args.expires_after_days,
        });
        if (update === undefined) {
          return yield* HttpServerResponse.json(
            encodeResponse(MemoryWriteSuccessSchema, {
              ok: true,
              // SAFETY: upsert info carries contract string enums from the matched row.
              result: {
                mode: "updated",
                written_to: args.repository,
                id: best.row.id,
                memory: best.row,
                size,
                upsert_match: info,
              },
            }),
          );
        }
        yield* d1
          .prepare(`UPDATE memories SET ${update.sql} WHERE repository = ? AND id = ?`)
          .bind(...update.params, args.repository, best.row.id)
          .run();
        const row = (yield* fetchProductRow(args.repository, best.row.id)) ?? best.row;
        void tags;
        void context;
        yield* syncProductVector(row);
        return yield* HttpServerResponse.json(
          encodeResponse(MemoryWriteSuccessSchema, {
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
        const input = decodeRequest(MemoryAddArgsInputSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const args = normalizeMemoryAddArgs(input.value);
        if (args.expires_after_days !== undefined && args.memory_type !== "status") {
          return yield* badRequest("expires_after_days is only valid for status memories.");
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
        return yield* upsertProductAdd({ ...args, upsertQuery });
      });

    const handleProductUpdate = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = decodeRequest(MemoryUpdateArgsSchema, body);
        if (!input.ok) {
          return yield* badRequest(input.error);
        }
        const args = input.value;
        const matchQuery = args.match?.trim() || undefined;
        if (args.id !== undefined && matchQuery !== undefined) {
          return yield* badRequest("Provide either the numeric id or a match query, not both.");
        }
        const resolved = yield* resolveUpdateTarget(args.repository, args.id, matchQuery);
        if (!resolved.ok) {
          return resolved.response;
        }
        return yield* applyProductUpdate(args.repository, resolved.targetId, {
          content: args.content,
          tags: args.tags,
          context: args.context,
          memory_type: args.memory_type,
          certainty: args.certainty,
          status: args.status,
          expires_after_days: args.expires_after_days,
          superseded_by: args.superseded_by,
        });
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
          return { ok: true as const, targetId: best.row.id };
        }
        if (id === undefined) {
          const response = yield* badRequest("Provide either the numeric id or a match query.");
          return { ok: false as const, response };
        }
        return { ok: true as const, targetId: id };
      });

    const validateUpdateFields = (
      existing: ReturnType<typeof toProductRow>,
      targetId: number,
      fields: {
        superseded_by?: number;
        memory_type?: "convention" | "decision" | "gotcha" | "preference" | "constraint" | "reference" | "status";
        expires_after_days?: number;
      },
    ): string | undefined => {
      if (fields.superseded_by !== undefined && fields.superseded_by === targetId) {
        return "A memory cannot supersede itself.";
      }
      const prospectiveType = fields.memory_type ?? existing.memory_type;
      if (fields.expires_after_days !== undefined && prospectiveType !== "status") {
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
        memory_type?: "convention" | "decision" | "gotcha" | "preference" | "constraint" | "reference" | "status";
        certainty?: "verified" | "inferred" | "speculative";
        status?: "active" | "deprecated" | "superseded_by";
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
        memory_type?: "convention" | "decision" | "gotcha" | "preference" | "constraint" | "reference" | "status";
        certainty?: "verified" | "inferred" | "speculative";
        status?: "active" | "deprecated" | "superseded_by";
        expires_after_days?: number;
        superseded_by?: number;
      },
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
        const size = embeddingSizeReport(prospectiveUpdateText(existing, fields));
        if (!size.within_budget) {
          return yield* badRequest(`Document text must be at most 512 tokens for embedding.`);
        }
        return yield* persistProductUpdate(repository, targetId, existing, fields, size);
      });

    const persistProductUpdate = (
      repository: string,
      targetId: number,
      existing: ReturnType<typeof toProductRow>,
      fields: {
        content?: string;
        tags?: string;
        context?: string;
        memory_type?: "convention" | "decision" | "gotcha" | "preference" | "constraint" | "reference" | "status";
        certainty?: "verified" | "inferred" | "speculative";
        status?: "active" | "deprecated" | "superseded_by";
        expires_after_days?: number;
        superseded_by?: number;
      },
      size: ReturnType<typeof embeddingSizeReport>,
    ) =>
      Effect.gen(function* () {
        const update = updateSets(fields);
        if (update === undefined) {
          return yield* HttpServerResponse.json(
            encodeResponse(MemoryWriteSuccessSchema, {
              ok: true,
              result: { written_to: repository, id: targetId, memory: existing, size },
            }),
          );
        }
        yield* d1
          .prepare(`UPDATE memories SET ${update.sql} WHERE repository = ? AND id = ?`)
          .bind(...update.params, repository, targetId)
          .run();
        const row = (yield* fetchProductRow(repository, targetId)) ?? existing;
        yield* syncProductVector(row);
        return yield* HttpServerResponse.json(
          encodeResponse(MemoryWriteSuccessSchema, {
            ok: true,
            result: { written_to: repository, id: targetId, memory: row, size },
          }),
        );
      });

    // oxlint-disable-next-line max-statements -- product route dispatcher maps 11 operations
    const handleProduct = (route: string, body: JsonValue) => {
      const normalized =
        route === "/product/list_repositories" ? "/product/list-repositories" : route;
      if (normalized === "/product/query") {
        return handleProductQuery(body);
      }
      if (normalized === "/product/get") {
        return handleProductGet(body);
      }
      if (normalized === "/product/list") {
        return handleProductList(body);
      }
      if (normalized === "/product/suggest") {
        return handleProductSuggest(body);
      }
      if (normalized === "/product/add") {
        return handleProductAdd(body);
      }
      if (normalized === "/product/update") {
        return handleProductUpdate(body);
      }
      if (normalized === "/product/delete") {
        return handleProductDelete(body);
      }
      if (normalized === "/product/verify") {
        return handleProductVerify(body);
      }
      if (normalized === "/product/diff") {
        return handleProductDiff(body);
      }
      if (normalized === "/product/size") {
        return handleProductSize(body);
      }
      return handleProductListRepositories(body);
    };

    const restHandlers = {
      expectedToken,
      handleQuery,
      handleMigration,
      handleMigrationLinks,
      handleVectorizeUpsert,
      handleVectorizeSearch,
      handleVectorizeDelete,
      handleProduct,
    } satisfies RestHandlers;

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
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
    Effect.provide(Cloudflare.Vectorize.SearchIndexBinding),
    Effect.provide(Cloudflare.Workers.AIBinding),
  ),
);
