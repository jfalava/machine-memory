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
  encodeResponse,
  ErrorBodySchema,
  isJsonArray,
  jsonNumber,
  jsonObject,
  MigrationLinksRequestSchema,
  MigrationLinksSuccessSchema,
  MigrationRequestInputSchema,
  MigrationSuccessSchema,
  memoryDocumentId,
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

    const restHandlers = {
      expectedToken,
      handleQuery,
      handleMigration,
      handleMigrationLinks,
      handleVectorizeUpsert,
      handleVectorizeSearch,
      handleVectorizeDelete,
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
