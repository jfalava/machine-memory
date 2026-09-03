import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Database } from "../../iac/src/database";
import { apiName } from "../../iac/src/config";
import { validateEmbeddingText } from "./embedding";
import { VectorIndex } from "../../iac/src/vectorize";
import {
  isJsonArray,
  jsonNumber,
  jsonObject,
  jsonString,
  type JsonObject,
  type JsonValue,
} from "./json";
import { handleRestRequest, type RestHandlers } from "./rest-handlers";

type QueryOperation = "run" | "get" | "all";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5" as const;
const EMBEDDING_DIMENSIONS = 768;
const MAX_NAMESPACE_BYTES = 64;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 50;
const MAX_MIGRATION_ROWS = 50;
const MAX_MIGRATION_LINKS = 100;
const INTERNAL_ERROR = "Internal server error.";
const RATE_LIMIT_ERROR = "Too Many Requests";

function isRateLimitedVectorizeCause(cause: unknown): boolean {
  return /(?:too many requests|rate[ -]?limit|\b429\b|40041)/i.test(
    String(cause),
  );
}

type QueryRequest = {
  readonly operation: QueryOperation;
  readonly sql: string;
  readonly params: ReadonlyArray<string | number | null>;
  readonly repository: string;
};

type MemoryDocument = {
  readonly id: string;
  readonly repository: string;
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memoryType: string;
  readonly status: string;
  readonly certainty: string;
};

type SemanticSearchRequest = {
  readonly repository: string;
  readonly query: string;
  readonly topK: number;
  readonly status: string | undefined;
  readonly memoryType: string | undefined;
  readonly certainty: string | undefined;
};

type MigrationRow = {
  readonly sourceId: number;
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memoryType: string;
  readonly status: string;
  readonly supersededBySourceId: number | null;
  readonly sourceAgent: string;
  readonly lastUpdatedBy: string;
  readonly updateCount: number;
  readonly certainty: string;
  readonly refs: string;
  readonly expiresAfterDays: number | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
};

type MigrationRequest = {
  readonly repository: string;
  readonly rows: MigrationRow[];
};

type MigrationLink = {
  readonly targetId: number;
  readonly supersededByTargetId: number;
};

type MigrationLinksRequest = {
  readonly repository: string;
  readonly links: MigrationLink[];
};

type ParseResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

function objectValue(value: JsonValue, message: string): JsonObject {
  const candidate = jsonObject(value);
  if (candidate === undefined) {
    throw new Error(message);
  }
  return candidate;
}

function parseRequiredString(candidate: JsonObject, field: string): string {
  const value = candidate[field];
  const parsed = jsonString(value);
  if (parsed === undefined || parsed.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return parsed.trim();
}

function parseOptionalString(
  candidate: JsonObject,
  field: string,
  fallback: string,
): string {
  const value = candidate[field];
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = jsonString(value);
  if (parsed === undefined) {
    throw new Error(`${field} must be a string.`);
  }
  return parsed.trim();
}

function parseMemoryId(candidate: JsonObject): string {
  const value = candidate.id;
  const stringId = jsonString(value);
  const numberId = jsonNumber(value);
  const normalized = stringId ?? numberId?.toString();
  if (normalized === undefined || normalized.trim().length === 0) {
    throw new Error("id must be a non-empty string or number.");
  }
  return normalized.trim();
}

function validateNamespace(repository: string): string {
  if (new TextEncoder().encode(repository).byteLength > MAX_NAMESPACE_BYTES) {
    throw new Error(
      `repository must be at most ${MAX_NAMESPACE_BYTES} UTF-8 bytes.`,
    );
  }
  return repository;
}

function parseRepository(candidate: JsonObject): string {
  return validateNamespace(parseRequiredString(candidate, "repository"));
}

function parseMemoryDocument(value: JsonValue): MemoryDocument {
  const candidate = objectValue(
    value,
    "The request body must be a JSON object.",
  );
  const document = {
    id: parseMemoryId(candidate),
    repository: parseRepository(candidate),
    content: parseRequiredString(candidate, "content"),
    tags: parseOptionalString(candidate, "tags", ""),
    context: parseOptionalString(candidate, "context", ""),
    memoryType: parseOptionalString(candidate, "memory_type", "convention"),
    status: parseOptionalString(candidate, "status", "active"),
    certainty: parseOptionalString(candidate, "certainty", "inferred"),
  };
  validateEmbeddingText(buildEmbeddingText(document), "Document text");
  return document;
}

function parseSemanticSearchRequest(value: JsonValue): SemanticSearchRequest {
  const candidate = objectValue(
    value,
    "The request body must be a JSON object.",
  );
  const rawTopKValue = candidate.top_k;
  const rawTopK =
    rawTopKValue === undefined
      ? DEFAULT_SEARCH_LIMIT
      : jsonNumber(rawTopKValue);
  if (
    rawTopK === undefined ||
    !Number.isInteger(rawTopK) ||
    rawTopK < 1 ||
    rawTopK > MAX_SEARCH_LIMIT
  ) {
    throw new Error(
      `top_k must be an integer between 1 and ${MAX_SEARCH_LIMIT}.`,
    );
  }
  const query = validateEmbeddingText(
    parseRequiredString(candidate, "query"),
    "Query",
  );
  return {
    repository: parseRepository(candidate),
    query,
    topK: rawTopK,
    status: parseOptionalString(candidate, "status", "") || undefined,
    memoryType: parseOptionalString(candidate, "memory_type", "") || undefined,
    certainty: parseOptionalString(candidate, "certainty", "") || undefined,
  };
}

function parseVectorDeleteRequest(value: JsonValue): string {
  return parseMemoryId(
    objectValue(value, "The request body must be a JSON object."),
  );
}

function parseNullableInteger(
  candidate: JsonObject,
  field: string,
): number | null {
  const value = candidate[field];
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = jsonNumber(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed)) {
    throw new Error(`${field} must be a safe integer or null.`);
  }
  return parsed;
}

function parseMigrationInteger(candidate: JsonObject, field: string): number {
  const value = candidate[field];
  const parsed = jsonNumber(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed)) {
    throw new Error(`${field} must be a safe integer.`);
  }
  return parsed;
}

function parseMigrationText(
  candidate: JsonObject,
  field: string,
  fallback = "",
): string {
  const value = candidate[field];
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = jsonString(value);
  if (parsed === undefined) {
    throw new Error(`${field} must be a string.`);
  }
  return parsed;
}

function validateMigrationEnums(
  memoryType: string,
  status: string,
  certainty: string,
): void {
  if (
    ![
      "decision",
      "convention",
      "gotcha",
      "preference",
      "constraint",
      "reference",
      "status",
    ].includes(memoryType)
  ) {
    throw new Error(`Invalid memory_type '${memoryType}'.`);
  }
  if (!["active", "deprecated", "superseded_by"].includes(status)) {
    throw new Error(`Invalid status '${status}'.`);
  }
  if (!["verified", "inferred", "speculative"].includes(certainty)) {
    throw new Error(`Invalid certainty '${certainty}'.`);
  }
}

function parseMigrationRow(value: JsonValue): MigrationRow {
  const candidate = objectValue(value, "Each migration row must be an object.");
  const sourceId = parseMigrationInteger(candidate, "source_id");
  if (sourceId < 1) {
    throw new Error("source_id must be greater than zero.");
  }
  const content = parseMigrationText(candidate, "content");
  if (!content) {
    throw new Error("content must be a non-empty string.");
  }
  const memoryType = parseMigrationText(candidate, "memory_type", "convention");
  const status = parseMigrationText(candidate, "status", "active");
  const certainty = parseMigrationText(candidate, "certainty", "inferred");
  validateMigrationEnums(memoryType, status, certainty);
  const updateCount = parseMigrationInteger(candidate, "update_count");
  if (updateCount < 0) {
    throw new Error("update_count must not be negative.");
  }
  return {
    sourceId,
    content,
    tags: parseMigrationText(candidate, "tags"),
    context: parseMigrationText(candidate, "context"),
    memoryType,
    status,
    supersededBySourceId: parseNullableInteger(
      candidate,
      "superseded_by_source_id",
    ),
    sourceAgent: parseMigrationText(candidate, "source_agent"),
    lastUpdatedBy: parseMigrationText(candidate, "last_updated_by"),
    updateCount,
    certainty,
    refs: parseMigrationText(candidate, "refs", "[]"),
    expiresAfterDays: parseNullableInteger(candidate, "expires_after_days"),
    createdAt: parseMigrationText(candidate, "created_at") || null,
    updatedAt: parseMigrationText(candidate, "updated_at") || null,
  };
}

function parseMigrationRequest(value: JsonValue): MigrationRequest {
  const candidate = objectValue(
    value,
    "The migration request body must be an object.",
  );
  const repository = parseRepository(candidate);
  const rawRows = candidate.rows;
  if (!isJsonArray(rawRows) || rawRows.length > MAX_MIGRATION_ROWS) {
    throw new Error(
      `rows must be an array with at most ${MAX_MIGRATION_ROWS} entries.`,
    );
  }
  const rows = rawRows.map(parseMigrationRow);
  const sourceIds = new Set<number>();
  for (const row of rows) {
    if (sourceIds.has(row.sourceId)) {
      throw new Error(`Duplicate source_id ${row.sourceId}.`);
    }
    sourceIds.add(row.sourceId);
  }
  return { repository, rows };
}

function parseMigrationLinksRequest(value: JsonValue): MigrationLinksRequest {
  const candidate = objectValue(
    value,
    "The migration links request body must be an object.",
  );
  const repository = parseRepository(candidate);
  const rawLinks = candidate.links;
  if (!isJsonArray(rawLinks) || rawLinks.length > MAX_MIGRATION_LINKS) {
    throw new Error(
      `links must be an array with at most ${MAX_MIGRATION_LINKS} entries.`,
    );
  }
  const links = rawLinks.map((linkValue) => {
    const link = objectValue(
      linkValue,
      "Each migration link must be an object.",
    );
    const targetId = parseMigrationInteger(link, "target_id");
    const supersededByTargetId = parseMigrationInteger(
      link,
      "superseded_by_target_id",
    );
    if (targetId < 1 || supersededByTargetId < 1) {
      throw new Error("Migration link IDs must be greater than zero.");
    }
    return { targetId, supersededByTargetId };
  });
  return { repository, links };
}

function safeParse<A>(parse: () => A): ParseResult<A> {
  try {
    return { ok: true, value: parse() };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "Invalid request.",
    };
  }
}

function buildEmbeddingText(document: MemoryDocument): string {
  return [
    document.content,
    document.tags ? `Tags: ${document.tags}` : undefined,
    document.context ? `Context: ${document.context}` : undefined,
    `Memory type: ${document.memoryType}`,
    `Status: ${document.status}`,
    `Certainty: ${document.certainty}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n");
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

function parseQueryRequest(value: JsonValue): QueryRequest {
  const candidate = objectValue(
    value,
    "The request body must be a JSON object.",
  );
  const operation = jsonString(candidate.operation);
  if (operation !== "run" && operation !== "get" && operation !== "all") {
    throw new Error("The request operation must be run, get, or all.");
  }
  const sql = jsonString(candidate.sql);
  if (sql === undefined || sql.length === 0) {
    throw new Error("The request must contain a SQL statement.");
  }
  const rawParams = candidate.params;
  if (!isJsonArray(rawParams)) {
    throw new Error("The request params must be SQLite JSON values.");
  }
  const params = rawParams.map((param) => {
    if (param === null) {
      return null;
    }
    const string = jsonString(param);
    if (string !== undefined) {
      return string;
    }
    const number = jsonNumber(param);
    if (number !== undefined) {
      return number;
    }
    throw new Error("The request params must be SQLite JSON values.");
  });
  const repository = parseRepository(candidate);
  return {
    operation,
    sql,
    params,
    repository,
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
        const input = safeParse(() => parseQueryRequest(body));
        if (!input.ok) {
          return yield* HttpServerResponse.json(
            { ok: false, error: input.error },
            { status: 400 },
          );
        }

        if (input.value.operation === "run") {
          const response = yield* d1
            .prepare(input.value.sql)
            .bind(...input.value.params)
            .run();
          return yield* HttpServerResponse.json({
            ok: true,
            result: {
              changes: response.meta.changes,
              lastInsertRowid: response.meta.last_row_id,
            },
          });
        }

        const rows = yield* sql.unsafe<JsonObject>(
          input.value.sql,
          input.value.params,
        );
        const result =
          input.value.operation === "all" ? rows : (rows[0] ?? null);
        return yield* HttpServerResponse.json({ ok: true, result });
      });

    const handleMigration = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = safeParse(() => parseMigrationRequest(body));
        if (!input.ok) {
          return yield* HttpServerResponse.json(
            { ok: false, error: input.error },
            { status: 400 },
          );
        }

        const items: {
          source_id: number;
          target_id: number;
          status: "inserted" | "duplicate";
        }[] = [];
        let inserted = 0;
        let duplicates = 0;

        for (const row of input.value.rows) {
          const existing = yield* sql.unsafe<{ id: number }>(
            `SELECT id FROM memories
             WHERE repository = ?
               AND status = 'active'
               AND content = ?
               AND tags = ?
               AND context = ?
             LIMIT 1`,
            [input.value.repository, row.content, row.tags, row.context],
          );
          const duplicate = existing[0];
          if (duplicate) {
            duplicates += 1;
            items.push({
              source_id: row.sourceId,
              target_id: Number(duplicate.id),
              status: "duplicate",
            });
            continue;
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
              input.value.repository,
              row.content,
              row.tags,
              row.context,
              row.memoryType,
              row.status,
              row.sourceAgent,
              row.lastUpdatedBy,
              row.updateCount,
              row.certainty,
              row.refs,
              row.expiresAfterDays,
              row.createdAt,
              row.updatedAt,
            )
            .run();
          const targetId = Number(result.meta.last_row_id);
          inserted += 1;
          items.push({
            source_id: row.sourceId,
            target_id: targetId,
            status: "inserted",
          });
        }

        return yield* HttpServerResponse.json({
          ok: true,
          result: {
            processed: input.value.rows.length,
            inserted,
            duplicates,
            items,
          },
        });
      });

    const handleMigrationLinks = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = safeParse(() => parseMigrationLinksRequest(body));
        if (!input.ok) {
          return yield* HttpServerResponse.json(
            { ok: false, error: input.error },
            { status: 400 },
          );
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
              link.supersededByTargetId,
              input.value.repository,
              link.targetId,
            )
            .run();
          updated += result.meta.changes;
        }

        return yield* HttpServerResponse.json({
          ok: true,
          result: { updated },
        });
      });

    const handleVectorizeUpsert = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = safeParse(() => parseMemoryDocument(body));
        if (!input.ok) {
          return yield* HttpServerResponse.json(
            { ok: false, error: input.error },
            { status: 400 },
          );
        }
        const document = input.value;
        const values = yield* embed(buildEmbeddingText(document));
        const result = yield* vectorize
          .upsert([
            {
              id: document.id,
              namespace: document.repository,
              values,
              metadata: {
                status: document.status,
                memory_type: document.memoryType,
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
            {
              ok: false,
              error: result.rateLimited ? RATE_LIMIT_ERROR : INTERNAL_ERROR,
            },
            { status: result.rateLimited ? 429 : 500 },
          );
        }
        const mutation = result.mutation;
        return yield* HttpServerResponse.json({
          ok: true,
          result: {
            id: document.id,
            namespace: document.repository,
            mutationId: mutation.mutationId,
          },
        });
      });

    const handleVectorizeSearch = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = safeParse(() => parseSemanticSearchRequest(body));
        if (!input.ok) {
          return yield* HttpServerResponse.json(
            { ok: false, error: input.error },
            { status: 400 },
          );
        }
        const values = yield* embed(input.value.query);
        const filter = Object.fromEntries(
          [
            ["status", input.value.status],
            ["memory_type", input.value.memoryType],
            ["certainty", input.value.certainty],
          ].filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        const queryOptions = {
          namespace: input.value.repository,
          topK: input.value.topK,
          returnMetadata: "all" as const,
        };
        if (Object.keys(filter).length > 0) {
          Object.assign(queryOptions, { filter });
        }
        const matches = yield* vectorize.query(values, queryOptions);
        return yield* HttpServerResponse.json({ ok: true, result: matches });
      });

    const handleVectorizeDelete = (body: JsonValue) =>
      Effect.gen(function* () {
        const input = safeParse(() => parseVectorDeleteRequest(body));
        if (!input.ok) {
          return yield* HttpServerResponse.json(
            { ok: false, error: input.error },
            { status: 400 },
          );
        }
        const mutation = yield* vectorize.deleteByIds([input.value]);
        return yield* HttpServerResponse.json({
          ok: true,
          result: { id: input.value, mutationId: mutation.mutationId },
        });
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
  ),
);
