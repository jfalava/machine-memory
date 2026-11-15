import { readdir, readFile } from "node:fs/promises";

import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  EMBEDDING_DIMENSIONS,
  ErrorBodySchema,
  MigrationSuccessSchema,
  PRODUCT_OPERATIONS,
  productRoutePath,
  QuerySuccessSchema,
  StatusSuccessSchema,
  type JsonObject,
  type JsonValue,
  type ProductRoute,
} from "@machine-memory/contract";
import { RuntimeContext } from "alchemy";
import { Effect, Redacted, Schema } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import pkg from "../package.json";
import { handleRestRequest } from "../src/rest-handlers";
import {
  drainVectorSync,
  DRAIN_INTERVAL_MS,
  parseEmbedding,
  wakeAlarmAt,
} from "../src/vector-sync";
import { createApiHandlers } from "../src/worker";

let mf: Miniflare;
let db: D1Database;
const values = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.25);
const embed = vi.fn(async (_text: string) => values);
const upsert = vi.fn(async (_vectors: VectorizeVector[]) => ({
  mutationId: "test",
}));
const deleteByIds = vi.fn(async (_ids: string[]) => ({ mutationId: "test" }));
const index = { upsert, deleteByIds };
const aiRun = vi.fn(() => Effect.succeed({ data: [values] }));
const query = vi.fn((): Effect.Effect<VectorizeMatches> =>
  Effect.succeed({ count: 0, matches: [] }),
);
const wake = vi.fn(() => undefined);

beforeAll(async () => {
  mf = new Miniflare({
    host: "127.0.0.1",
    workers: [
      {
        config: {
          name: "api-test",
          manifest: {
            mainModule: "worker.mjs",
            modules: {
              "worker.mjs": {
                type: "esm",
                contents:
                  "export default { fetch() { return new Response('test'); } }",
              },
            },
          },
          compatibilityDate: "2026-07-30",
          env: {
            DB: { type: "d1", id: "DB" },
          },
        },
      },
    ],
  });
  db = await mf.getD1Database("DB");
  for (const name of [
    "0001_machine_memory",
    "0002_vector_sync",
    "0003_memory_integrity",
    "0004_memory_history",
    "0005_memory_evidence",
    "0006_memory_evidence_triggers",
    "0007_embedding_budget",
    "0008_vector_sync_queue",
  ]) {
    await applyMigration(name);
  }
});
// D1 exec splits on lines. Keep each complete trigger as one prepared statement.
async function applyMigration(name: string) {
  const sql = await readFile(
    new URL(`../../iac/migrations/${name}.sql`, import.meta.url),
    "utf8",
  );
  await db.exec(sql.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
}
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  await db.prepare("DELETE FROM memories").run();
  await db.prepare("DELETE FROM memory_history").run();
  await db.prepare("DELETE FROM memory_vector_sync").run();
  await db.prepare("DELETE FROM memory_migration_sources").run();
  vi.clearAllMocks();
  embed.mockReset().mockResolvedValue(values);
  upsert.mockReset().mockResolvedValue({ mutationId: "test" });
  deleteByIds.mockReset().mockResolvedValue({ mutationId: "test" });
  aiRun
    .mockReset()
    .mockImplementation(() => Effect.succeed({ data: [values] }));
  query
    .mockReset()
    .mockImplementation(() => Effect.succeed({ count: 0, matches: [] }));
});

function d1Client(): Cloudflare.D1.QueryDatabaseClient {
  const raw = Effect.succeed(db);
  return {
    raw,
    prepare: (sql) => new Cloudflare.D1.PreparedStatement(sql, [], raw),
    exec: (sql) => Effect.promise(() => db.exec(sql)),
    batch: (statements) =>
      Effect.promise(() => db.batch(statements.map((stmt) => stmt._build(db)))),
  };
}

type Reply = { readonly status: number; readonly body: unknown };

async function send(path: string, body: JsonValue): Promise<Reply> {
  const unused = () =>
    Effect.die(new Error("HTTP must not use this binding method"));
  // Only query/run are used by HTTP handlers. Mutation methods deliberately throw.
  const vectorize: Cloudflare.Vectorize.SearchIndexClient = {
    raw: unused(),
    describe: unused,
    query,
    queryById: unused,
    insert: unused,
    upsert: () => {
      throw new Error("HTTP must not mutate vectors");
    },
    deleteByIds: () => {
      throw new Error("HTTP must not mutate vectors");
    },
    getByIds: unused,
  };
  const ai: Cloudflare.Workers.AIClient = {
    raw: unused(),
    // SAFETY: handlers only call the embedding model, whose output shape the
    // mock returns; the generic per-model signature cannot be mocked directly.
    run: aiRun as Cloudflare.Workers.AIClient["run"],
    models: unused,
    model: () => {
      throw new Error("HTTP must not build language models");
    },
  };
  const effect = Effect.gen(function* () {
    const handlers = yield* createApiHandlers({
      d1: d1Client(),
      vectorize,
      ai,
      expectedToken: Effect.succeed(Redacted.make("test")),
      wake: Effect.sync(wake),
    });
    return yield* handleRestRequest(
      handlers,
      HttpServerRequest.fromWeb(
        new Request(`https://api.test${path}`, {
          method: "POST",
          headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      ),
    );
  });
  // The test D1 client supplies its raw binding directly; RuntimeContext is a
  // phantom requirement of PreparedStatement. Scope is still provided for SQL.
  const response = await Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provide(RuntimeContext.phantom)),
  );
  const json: unknown = await HttpServerResponse.toWeb(response).json();
  return { status: response.status, body: json };
}

/** Decode a reply with its contract schema; unknown keys fail the test. */
function decode<S extends Schema.ConstraintDecoder<object>>(
  schema: S,
  path: string,
  reply: Reply,
) {
  try {
    const body: S["Type"] = Schema.decodeUnknownSync(schema, {
      onExcessProperty: "error",
    })(reply.body);
    return { status: reply.status, ...body };
  } catch (cause) {
    throw new Error(
      `${path} returned ${reply.status}: ${JSON.stringify(reply.body)}`,
      { cause },
    );
  }
}
async function call<S extends Schema.ConstraintDecoder<object>>(
  path: string,
  schema: S,
  body: JsonValue,
) {
  return decode(schema, path, await send(path, body));
}
const productBody = (fields: Record<string, JsonValue>): JsonObject => ({
  repository: "o/r",
  ...fields,
});
/** Call a product route and decode its success response. */
const product = <R extends ProductRoute>(
  route: R,
  fields: Record<string, JsonValue> = {},
) =>
  call<(typeof PRODUCT_OPERATIONS)[R]["response"]>(
    productRoutePath(route),
    PRODUCT_OPERATIONS[route].response,
    productBody(fields),
  );
/** Call a product route that is expected to fail and decode its error body. */
const productError = (
  route: ProductRoute,
  fields: Record<string, JsonValue> = {},
) => call(productRoutePath(route), ErrorBodySchema, productBody(fields));
async function insert(content = "original", repository = "o/r") {
  const result = await db
    .prepare(
      `INSERT INTO memories (repository, content) VALUES (?, ?) RETURNING id`,
    )
    .bind(repository, content)
    .first<{ id: number }>();
  return result!.id;
}
/** The one memory `get` returns for `id`; fails the test when it is missing. */
async function getRow(id: number) {
  const fetched = await product("get", { ids: [id] });
  expect(fetched.status).toBe(200);
  const [row] = fetched.result.results;
  expect(row).toBeDefined();
  return row!;
}
const drain = (now = Date.now()) => drainVectorSync({ db, index, embed }, now);
const job = (id: number) =>
  db
    .prepare("SELECT * FROM memory_vector_sync WHERE memory_id = ?")
    .bind(id)
    .first<Record<string, number | string>>();

test("add and ID update encode successful writes without embedding or optional undefined keys", async () => {
  aiRun.mockImplementation(() => Effect.die(new Error("AI offline")));
  const added = await product("add", {
    content: "decision alpha",
    memory_type: "decision",
    certainty: "verified",
    evidence: ["observed_implementation"],
  });
  expect(added.status).toBe(200);
  const updated = await product("update", {
    id: added.result.id,
    content: "decision beta",
  });
  expect(updated.status).toBe(200);
  expect(updated.result.memory.content).toBe("decision beta");
  expect(updated.result).not.toHaveProperty("matched");
  expect(aiRun).not.toHaveBeenCalled();
  expect((await job(added.result.id))?.generation).toBe(2);
  expect(wake).toHaveBeenCalledTimes(2);
});

test("history snapshots updates without vector work and restores with optimistic concurrency", async () => {
  const added = await product("add", {
    content: "original decision",
    tags: "database",
    memory_type: "decision",
    certainty: "verified",
    evidence: ["observed_implementation"],
  });
  const id = added.result.id;
  const updated = await product("update", {
    id,
    content: "clobbered decision",
  });
  expect(updated.status).toBe(200);
  expect(
    await db.prepare("SELECT count(*) AS n FROM memory_history").first("n"),
  ).toBe(1);
  expect(await job(id)).toMatchObject({ generation: 2 });

  const history = await product("history", { id });
  expect(history.status).toBe(200);
  expect(history.result).toMatchObject({
    id,
    current_update_count: 1,
    count: 1,
  });
  expect(history.result.results[0]).toMatchObject({
    id,
    content: "original decision",
    tags: "database",
    update_count: 0,
  });
  expect(history.result.results[0].revision_id).toBeTypeOf("number");

  const revisionId = history.result.results[0].revision_id;
  const restored = await product("restore", {
    id,
    revision_id: revisionId,
    expected_update_count: 1,
  });
  expect(restored.status).toBe(200);
  expect(restored.result).toMatchObject({
    id,
    restored_revision_id: revisionId,
    memory: {
      content: "original decision",
      tags: "database",
      update_count: 2,
      last_updated_by: "restore",
    },
  });
  expect(
    await db.prepare("SELECT count(*) AS n FROM memory_history").first("n"),
  ).toBe(2);
  expect(await job(id)).toMatchObject({ generation: 3 });
  await drain();
  expect(embed).toHaveBeenCalledTimes(1);
  expect(embed.mock.calls[0]?.[0]).toContain("original decision");
  expect(embed.mock.calls[0]?.[0]).not.toContain("clobbered decision");

  const stale = await productError("restore", {
    id,
    revision_id: revisionId,
    expected_update_count: 1,
  });
  expect(stale.status).toBe(409);
  expect(
    await db
      .prepare("SELECT content FROM memories WHERE id = ?")
      .bind(id)
      .first("content"),
  ).toBe("original decision");
  expect(
    await db.prepare("SELECT count(*) AS n FROM memory_history").first("n"),
  ).toBe(2);
  expect(await job(id)).toMatchObject({
    generation: 3,
    delivered_generation: 3,
  });
});

test("history is scoped, paginated newest-first, and covers upserts, raw SQL, and deprecation", async () => {
  const id = await insert("history source alpha");
  const other = await insert("unrelated");
  expect((await product("history", { id })).result).toMatchObject({
    current_update_count: 0,
    total_count: 0,
    results: [],
  });
  const upserted = await product("add", {
    content: "history source alpha",
    upsert_match: "history source alpha",
    upsert_threshold: 0,
    tags: "upsert",
  });
  expect(upserted.result.id).toBe(id);
  const raw = await call("/query", QuerySuccessSchema, {
    operation: "run",
    repository: "o/r",
    sql: "UPDATE memories SET content = ?, update_count = update_count + 1 WHERE id = ?",
    params: ["raw sql overwrite", id],
  });
  expect(raw.status).toBe(200);
  await product("deprecate", { ids: [id] });
  const page = await product("history", { id, limit: 1, offset: 1 });
  expect(page.result).toMatchObject({
    id,
    current_update_count: 3,
    count: 1,
    total_count: 3,
    offset: 1,
    limit: 1,
    has_more: true,
    results: [
      { content: "history source alpha", tags: "upsert", update_count: 1 },
    ],
  });
  const last = await product("history", { id, limit: 1, offset: 2 });
  expect(last.result.has_more).toBe(false);
  expect(last.result.results[0]).toMatchObject({ tags: "", update_count: 0 });
  const foreign = await product("history", { id, repository: "other/repo" });
  expect(foreign.result).toMatchObject({
    current_update_count: null,
    total_count: 0,
    results: [],
  });
  const wrongMemory = await productError("restore", {
    id: other,
    revision_id: last.result.results[0].revision_id,
    expected_update_count: 0,
  });
  expect(wrongMemory.status).toBe(404);
});

test("competing restores with the same current count allow exactly one mutation", async () => {
  const id = await insert("recover this");
  await product("update", { id, content: "clobbered" });
  const history = await product("history", { id });
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      send(
        productRoutePath("restore"),
        productBody({
          id,
          revision_id: history.result.results[0].revision_id,
          expected_update_count: 1,
        }),
      ),
    ),
  );
  expect(attempts.map((result) => result.status).sort((a, b) => a - b)).toEqual(
    [200, 409, 409, 409],
  );
  expect(await getRow(id)).toMatchObject({
    content: "recover this",
    update_count: 2,
  });
  expect((await product("history", { id })).result.total_count).toBe(2);
  expect(await job(id)).toMatchObject({ generation: 3 });
});

test("/status reports the Worker version and one schema level per migration file", async () => {
  // A migration added without its marker in SCHEMA_MARKERS fails here.
  const migrations = (
    await readdir(new URL("../../iac/migrations", import.meta.url))
  ).filter((name) => name.endsWith(".sql"));
  const status = await call("/status", StatusSuccessSchema, {});
  expect(status.result).toEqual({
    version: pkg.version,
    schema_level: migrations.length,
    schema_expected: migrations.length,
  });
});

test("writes record who made them, and an update leaves the author alone", async () => {
  const added = await product("add", {
    content: "Deploy runs bun run deploy",
    source_agent: "amp:T-1",
  });
  const id = added.result.id;
  expect(added.result.memory).toMatchObject({
    source_agent: "amp:T-1",
    last_updated_by: "amp:T-1",
  });
  const updated = await product("update", {
    id,
    tags: "area:ops",
    source_agent: "codex:9",
  });
  expect(updated.result.memory).toMatchObject({
    source_agent: "amp:T-1",
    last_updated_by: "codex:9",
  });
  // A write that names nobody is the API's own.
  await product("update", { id, tags: "area:deploy" });
  expect(await getRow(id)).toMatchObject({
    source_agent: "amp:T-1",
    last_updated_by: "api",
  });
  const replaced = await product("add", {
    content: "Deploy runs bun run deploy --prod",
    update_id: id,
    source_agent: "claude-code:s1",
  });
  expect(replaced.result.memory).toMatchObject({
    source_agent: "amp:T-1",
    last_updated_by: "claude-code:s1",
  });
  const deprecated = await product("deprecate", {
    ids: [id],
    source_agent: "amp:T-2",
  });
  expect(deprecated.status).toBe(200);
  expect(await getRow(id)).toMatchObject({
    status: "deprecated",
    source_agent: "amp:T-1",
    last_updated_by: "amp:T-2",
  });
  const plain = await product("add", { content: "Lint runs oxlint" });
  expect(plain.result.memory).toMatchObject({
    source_agent: "api",
    last_updated_by: "api",
  });
});

test("restore replaces complete metadata, refreshes expiry, and can itself be undone", async () => {
  const id = await insert();
  await db
    .prepare(
      `UPDATE memories SET content = 'original status', tags = 'old-tag', context = 'old-context', memory_type = 'status', source_agent = 'author', last_updated_by = 'editor', certainty = 'verified', refs = '["docs/a.md","https://example.com/b"]', expires_after_days = 7, created_at = '2020-01-01 00:00:00', updated_at = '2020-02-01 00:00:00' WHERE id = ?`,
    )
    .bind(id)
    .run();
  const original = await getRow(id);
  await product("update", {
    id,
    content: "clobbered status",
    tags: "wrong-tag",
    context: "wrong-context",
    certainty: "speculative",
    expires_after_days: 30,
  });
  const history = await product("history", { id });
  const restored = await product("restore", {
    id,
    revision_id: history.result.results[0].revision_id,
    expected_update_count: 1,
  });
  expect(restored.status).toBe(200);
  expect(restored.result.memory).toEqual({
    ...original,
    update_count: 2,
    last_updated_by: "restore",
    updated_at: restored.result.memory.updated_at,
  });
  expect(original.created_at).toBe("2020-01-01T00:00:00Z");
  expect(restored.result.memory.updated_at).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  );
  expect(restored.result.memory.updated_at).not.toBe(original.updated_at);
  // Output adds the zone; restore must write SQLite's form back.
  expect(
    await db
      .prepare("SELECT created_at FROM memories WHERE id = ?")
      .bind(id)
      .first("created_at"),
  ).toBe("2020-01-01 00:00:00");
  expect((await product("gc")).result.ids).not.toContain(id);
  const undoHistory = await product("history", { id });
  const undo = await product("restore", {
    id,
    revision_id: undoHistory.result.results[0].revision_id,
    expected_update_count: 2,
  });
  expect(undo.result.memory).toMatchObject({
    content: "clobbered status",
    tags: "wrong-tag",
    context: "wrong-context",
    certainty: "speculative",
    expires_after_days: 30,
    update_count: 3,
  });
});

test("restoring inactive state removes its vector without embedding snapshots", async () => {
  const id = await insert();
  await product("deprecate", { ids: [id] });
  await product("update", { id, content: "reactivated", status: "active" });
  await drain();
  vi.clearAllMocks();
  const history = await product("history", { id });
  const restored = await product("restore", {
    id,
    revision_id: history.result.results[0].revision_id,
    expected_update_count: 2,
  });
  expect(restored.result.memory.status).toBe("deprecated");
  await drain();
  expect(embed).not.toHaveBeenCalled();
  expect(upsert).not.toHaveBeenCalled();
  expect(deleteByIds).toHaveBeenCalledWith([String(id)]);
});

test("replacement deletion snapshots dependents and permanently purges the deleted memory's history", async () => {
  const id = await insert("dependent");
  const replacement = await insert("replacement");
  await product("update", { id: replacement, content: "new replacement" });
  await product("deprecate", { ids: [id], superseded_by: replacement });
  await product("delete", { id: replacement });
  const history = await product("history", { id });
  expect(history.result.total_count).toBe(2);
  expect(history.result.results[0]).toMatchObject({
    status: "superseded_by",
    superseded_by: replacement,
  });
  const before = await job(id);
  const invalid = await productError("restore", {
    id,
    revision_id: history.result.results[0].revision_id,
    expected_update_count: 2,
  });
  expect(invalid.status).toBe(400);
  expect(invalid.error).toContain("replacement no longer exists");
  expect(await job(id)).toEqual(before);
  expect(
    (await product("history", { id: replacement })).result.total_count,
  ).toBe(0);
  const valid = await product("restore", {
    id,
    revision_id: history.result.results[1].revision_id,
    expected_update_count: 2,
  });
  expect(valid.result.memory).toMatchObject({
    status: "active",
    superseded_by: null,
    expires_after_days: null,
  });
});

test("failed writes and invalid legacy restores leave both history and vector intent unchanged", async () => {
  const id = await insert();
  await product("update", { id, content: "current" });
  const history = await product("history", { id });
  const revision = history.result.results[0].revision_id;
  const before = await job(id);
  await expect(
    db.batch([
      db
        .prepare("UPDATE memories SET content = 'must roll back' WHERE id = ?")
        .bind(id),
      db.prepare("UPDATE memories SET refs = 'not json' WHERE id = ?").bind(id),
    ]),
  ).rejects.toThrow();
  for (const [column, value, message] of [
    ["refs", "not json", "current schema"],
    ["refs", "[]", "over by 100 bytes of 2,000"],
  ]) {
    await db
      .prepare(
        `UPDATE memory_history SET ${column} = ?, content = ? WHERE revision_id = ?`,
      )
      .bind(value, "x".repeat(2100), revision)
      .run();
    const invalid = await productError("restore", {
      id,
      revision_id: revision,
      expected_update_count: 1,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.error).toContain(message);
  }
  expect((await getRow(id)).content).toBe("current");
  expect((await product("history", { id })).result.total_count).toBe(1);
  expect(await job(id)).toEqual(before);
});

test("wrong-repository deletion leaves both canonical data and vector intent unchanged", async () => {
  const id = await insert("belongs elsewhere", "other/repo");
  const before = await job(id);
  const result = await product("delete", { id });
  expect(result.result.deleted).toBe(false);
  expect(await job(id)).toEqual(before);
  expect(
    await db
      .prepare("SELECT content FROM memories WHERE id = ?")
      .bind(id)
      .first("content"),
  ).toBe("belongs elsewhere");
});

test("maximum-sized mutation batches scope results and honestly report missing IDs", async () => {
  const first = await insert("first");
  const second = await insert("second");
  const other = await insert("other", "other/repo");
  const missing = Array.from({ length: 97 }, (_, i) => 1_000_000 + i);
  const ids = [second, other, first, ...missing];
  const deprecated = await product("deprecate", { ids });
  expect(deprecated.status).toBe(200);
  expect(deprecated.result.count).toBe(2);
  expect(deprecated.result.not_found).toEqual([other, ...missing]);
  expect(deprecated.result.deprecated).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: first,
        status: "deprecated",
        update_count: 1,
      }),
      expect.objectContaining({
        id: second,
        status: "deprecated",
        update_count: 1,
      }),
    ]),
  );
  const deleted = await product("delete-many", { ids });
  expect(deleted.status).toBe(200);
  expect(deleted.result.deleted_ids).toEqual([second, first]);
  expect(deleted.result.not_found).toEqual([other, ...missing]);
  expect(
    await db
      .prepare("SELECT status FROM memories WHERE id = ?")
      .bind(other)
      .first("status"),
  ).toBe("active");
  expect(await job(first)).toMatchObject({
    generation: 3,
    delivered_generation: 0,
  });
});

test("a failed batch rolls back earlier canonical changes and vector intent", async () => {
  const first = await insert("first");
  const second = await insert("blocked");
  await db
    .prepare(
      `CREATE TRIGGER test_block_deprecation BEFORE UPDATE ON memories WHEN NEW.id = ${second} BEGIN SELECT RAISE(ABORT, 'blocked test row'); END`,
    )
    .run();
  try {
    expect(
      (await productError("deprecate", { ids: [first, second] })).status,
    ).toBe(500);
    expect(
      await db
        .prepare("SELECT status FROM memories WHERE id = ?")
        .bind(first)
        .first("status"),
    ).toBe("active");
    expect(await job(first)).toMatchObject({
      generation: 1,
      delivered_generation: 0,
    });
  } finally {
    await db.prepare("DROP TRIGGER test_block_deprecation").run();
  }
});

test("strong upsert preserves omitted metadata and clears expiry on type conversion", async () => {
  const content = "prefer reliable transactional database writes";
  const added = await product("add", {
    content,
    memory_type: "status",
    certainty: "verified",
    evidence: ["observed_implementation"],
    expires_after_days: 5,
  });
  const result = await product("add", {
    content,
    upsert_match: content,
    upsert_threshold: 0,
  });
  expect(result.status).toBe(200);
  expect(result.result.mode).toBe("updated");
  expect(result.result.id).toBe(added.result.id);
  expect(result.result.memory).toMatchObject({
    memory_type: "status",
    certainty: "verified",
    expires_after_days: 5,
  });
  const converted = await product("add", {
    content,
    upsert_match: content,
    upsert_threshold: 0,
    memory_type: "decision",
  });
  expect(converted.status).toBe(200);
  expect(converted.result.memory).toMatchObject({
    memory_type: "decision",
    expires_after_days: null,
  });
});

test("writes refuse missing-value content and a stale expected update count", async () => {
  const id = await insert("kept content");
  for (const content of ["null", " undefined ", "  "]) {
    expect((await productError("add", { content })).status).toBe(400);
    expect((await productError("update", { id, content })).status).toBe(400);
  }
  const stale = await productError("update", {
    id,
    content: "based on an old read",
    expected_update_count: 3,
  });
  expect(stale.status).toBe(409);
  expect(stale.error).toContain("update_count 0");
  expect(await getRow(id)).toMatchObject({
    content: "kept content",
    update_count: 0,
  });
  const fresh = await product("update", {
    id,
    content: "based on the current read",
    expected_update_count: 0,
  });
  expect(fresh.result.memory.update_count).toBe(1);
});

test("a missing id names the repository that holds it", async () => {
  const id = await insert("elsewhere", "other/repo");
  const own = await insert("here");
  // get answers a miss instead of failing: which ids, and who holds them.
  const mixed = await product("get", { ids: [id, own, id + 100, own] });
  expect(mixed.status).toBe(200);
  expect(mixed.result).toMatchObject({
    repository: "o/r",
    count: 1,
    missing_ids: [id, id + 100],
    found_elsewhere: [{ id, repository: "other/repo" }],
  });
  expect(mixed.result.results.map((row) => row.content)).toEqual(["here"]);
  expect((await product("get", { ids: [own] })).result).not.toHaveProperty(
    "missing_ids",
  );
  // Routes that act on one memory still fail, and name its repository.
  const wrongRepository = await productError("update", { id, content: "x" });
  expect(wrongRepository.status).toBe(404);
  expect(wrongRepository.error).toContain("in repository 'o/r'");
  expect(wrongRepository.error).toContain("belongs to repository 'other/repo'");
  const absent = await productError("update", { id: id + 100, content: "x" });
  expect(absent.status).toBe(404);
  expect(absent.error).not.toContain("belongs to");
});

test("a weak upsert match refuses with its candidates; create_new and update_id state the intent", async () => {
  const existing = await insert("cache invalidation uses the redis keyspace");
  const weak = {
    content: "redis connection pool size is twenty",
    upsert_match: "redis",
  };
  const refused = await productError("add", weak);
  expect(refused.status).toBe(400);
  expect(refused.error).toContain(
    `the best candidate #${existing} has rank_score`,
  );
  expect(refused.error).toContain("text_overlap 0.111 (needs 0.62)");
  expect(refused.error).toContain(
    `#${existing} convention "cache invalidation uses the redis keyspace"`,
  );
  expect(refused.error).toContain(`update_id ${existing}`);
  expect(refused.error).toContain("create_new true");

  const created = await product("add", { ...weak, create_new: true });
  expect(created.result.id).not.toBe(existing);
  expect(created.result.upsert_match).toMatchObject({
    id: existing,
    text_overlap: 0.111,
    shared_identifiers: [],
  });
  const unmatched = await product("add", {
    content: "terraform state lives in the bucket",
    upsert_match: "zzzunmatched",
  });
  expect(unmatched.result).not.toHaveProperty("upsert_match");
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM memories").first("n"),
  ).toBe(3);

  // update_id replaces the named memory and keeps the fields it does not send.
  await db
    .prepare("UPDATE memories SET tags = 'area:cache' WHERE id = ?")
    .bind(existing)
    .run();
  const updated = await product("add", {
    content: "cache invalidation uses the redis keyspace notifications",
    update_id: existing,
  });
  expect(updated.result).toMatchObject({ mode: "updated", id: existing });
  expect(updated.result.memory).toMatchObject({
    content: "cache invalidation uses the redis keyspace notifications",
    tags: "area:cache",
    update_count: 1,
  });
  expect(updated.result).not.toHaveProperty("upsert_match");
  const both = await productError("add", { ...weak, update_id: existing });
  expect(both.status).toBe(400);
  expect(both.error).toContain("cannot be combined with upsert_match");
  expect(
    (await productError("add", { content: "x y", update_id: existing + 99 }))
      .status,
  ).toBe(404);
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM memories").first("n"),
  ).toBe(3);
});

test("a plain add refuses a near-duplicate and lists only strongly related records", async () => {
  const first = await product("add", {
    content: "Deploys run from the stable branch after CI passes.",
  });
  expect(first.result).not.toHaveProperty("related");
  const duplicate = {
    content: "Deploys run from the stable branch after CI passes twice.",
  };
  const refused = await productError("add", duplicate);
  expect(refused.status).toBe(400);
  expect(refused.error).toBe(
    `Memory #${first.result.id} already states nearly the same thing (text_overlap 0.875, at or above 0.78). Nothing was written. To change that record, repeat the add with update_id ${first.result.id}. If this is a different fact, repeat it with create_new true.`,
  );
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM memories").first("n"),
  ).toBe(1);
  const second = await product("add", { ...duplicate, create_new: true });
  expect(second.result.id).not.toBe(first.result.id);

  const related = await product("add", {
    content: "Hotfix deploys also run from the stable branch.",
  });
  expect(related.result.related?.map((row) => row.match_strength)).toEqual(
    expect.arrayContaining(["strong"]),
  );
  expect(
    related.result.related?.every((row) => row.match_strength === "strong"),
  ).toBe(true);
  const unrelated = await product("add", {
    content: "Tokens rotate every ninety days.",
  });
  expect(unrelated.result).not.toHaveProperty("related");
});

test("a metadata-only update keeps the content and edits tags and gaps in place", async () => {
  const added = await product("add", {
    content: "Workers bind the D1 database as DB.",
    tags: "area:api,topic:d1",
    validation_gaps: ["untested on staging", "intent unconfirmed"],
  });
  const { id } = added.result;
  const retyped = await product("update", { id, memory_type: "decision" });
  expect(retyped.result.memory).toMatchObject({
    content: "Workers bind the D1 database as DB.",
    memory_type: "decision",
    tags: "area:api,topic:d1",
    update_count: 1,
  });
  expect(retyped.result).not.toHaveProperty("dropped");
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM memory_history WHERE memory_id = ?")
      .bind(id)
      .first("n"),
  ).toBe(1);
  expect(
    (await product("query", { query: "D1 database" })).result.results[0]?.id,
  ).toBe(id);

  const edited = await product("update", {
    id,
    add_tags: "Kind:Decision, area:api",
    remove_tags: "topic:d1",
    add_validation_gaps: ["one account only"],
    remove_validation_gaps: ["untested on staging"],
  });
  expect(edited.result.memory).toMatchObject({
    tags: "area:api,kind:decision",
    validation_gaps: ["intent unconfirmed", "one account only"],
    update_count: 2,
  });

  const missingGap = await productError("update", {
    id,
    remove_validation_gaps: ["untested on windows"],
  });
  expect(missingGap.status).toBe(400);
  expect(missingGap.error).toContain("No stored validation gap reads");
  const mixed = await productError("update", {
    id,
    tags: "area:cli",
    add_tags: "topic:d1",
  });
  expect(mixed.status).toBe(400);
  expect(mixed.error).toContain("cannot be combined with add_tags");
  expect((await getRow(id)).update_count).toBe(2);
});

test("match mutations do not select inactive rows", async () => {
  const id = await insert("inactive match needle");
  await product("deprecate", { ids: [id] });
  const result = await productError("update", {
    match: "inactive match needle",
    content: "must not change",
  });
  expect(result.status).toBe(404);
  expect(
    await db
      .prepare("SELECT content FROM memories WHERE id = ?")
      .bind(id)
      .first("content"),
  ).toBe("inactive match needle");
});

test("semantic hydration applies canonical status, type, certainty and literal tags", async () => {
  const active = await product("add", {
    content: "correct",
    tags: "tag_a%",
    memory_type: "decision",
    certainty: "verified",
    evidence: ["observed_implementation"],
  });
  const wrong = await product("add", {
    content: "incorrect",
    tags: "tagxaZ",
    memory_type: "convention",
    certainty: "inferred",
  });
  const inactive = await product("add", {
    content: "deprecated",
    tags: "tag_a%",
    memory_type: "decision",
    certainty: "verified",
    evidence: ["observed_implementation"],
  });
  await product("deprecate", { ids: [inactive.result.id] });
  query.mockImplementation(() =>
    Effect.succeed({
      count: 3,
      matches: [wrong, inactive, active].map((row) => ({
        id: String(row.result.id),
        score: 0.9,
      })),
    }),
  );
  const filters = {
    tags: "_a%",
    status: "active",
    memory_type: "decision",
    certainty: "verified",
  };
  const semantic = await product("query", {
    query: "irrelevant",
    mode: "semantic",
    ...filters,
  });
  expect(semantic.status).toBe(200);
  expect(semantic.result.results.map((row: { id: number }) => row.id)).toEqual([
    active.result.id,
  ]);
  const listed = await product("list", { tags: "_a%", status: "active" });
  expect(listed.result.results.map((row: { id: number }) => row.id)).toEqual([
    active.result.id,
  ]);
});

test("hybrid ranks agreement above a keyword-only leader before truncation", async () => {
  const first = await product("add", { content: "alpha alpha alpha alpha" });
  const both = await product("add", { content: "alpha other words" });
  query.mockImplementation(() =>
    Effect.succeed({
      count: 1,
      matches: [{ id: String(both.result.id), score: 0.95 }],
    }),
  );
  const result = await product("query", {
    query: "alpha",
    mode: "hybrid",
    limit: 1,
  });
  expect(result.status).toBe(200);
  expect(result.result.results[0].id).toBe(both.result.id);
  expect(result.result.results[0].id).not.toBe(first.result.id);
});

test("migration retries retain inactive records and distinct metadata by source identity", async () => {
  const rows: JsonObject[] = [
    {
      source_id: 10,
      content: "same content",
      update_count: 0,
      status: "deprecated",
      memory_type: "decision",
    },
    {
      source_id: 20,
      content: "same content",
      update_count: 0,
      status: "active",
      memory_type: "gotcha",
      certainty: "verified",
      refs: '["doc.md"]',
    },
  ];
  const first = await call("/migrate", MigrationSuccessSchema, {
    repository: "o/r",
    source: "db1",
    rows,
  });
  expect(first.status).toBe(200);
  expect(first.result.inserted).toBe(2);
  const retry = await call("/migrate", MigrationSuccessSchema, {
    repository: "o/r",
    source: "db1",
    rows,
  });
  expect(retry.result).toMatchObject({ inserted: 0, duplicates: 2 });
  expect(
    retry.result.items.map((row: { target_id: number }) => row.target_id),
  ).toEqual(
    first.result.items.map((row: { target_id: number }) => row.target_id),
  );
  expect(
    await db.prepare("SELECT count(*) AS n FROM memories").first("n"),
  ).toBe(2);
  expect(
    await db
      .prepare("SELECT memory_type FROM memories WHERE id = ?")
      .bind(first.result.items[1].target_id)
      .first("memory_type"),
  ).toBe("gotcha");
  const other = await call("/migrate", MigrationSuccessSchema, {
    repository: "o/r",
    source: "db2",
    rows: [rows[0]],
  });
  expect(other.result.inserted).toBe(1);
});

test.each<Record<string, JsonValue>>([
  { refs: "{}" },
  { refs: "[1]" },
  { content: "x".repeat(2001) },
  { expires_after_days: 3 },
])(
  "migration preflights the whole batch before a bad final row: %j",
  async (bad) => {
    const result = await call("/migrate", ErrorBodySchema, {
      repository: "o/r",
      source: "db1",
      rows: [
        { source_id: 1, content: "valid", update_count: 0 },
        { source_id: 2, content: "invalid", update_count: 0, ...bad },
      ],
    });
    expect(result.status).toBe(400);
    expect(
      await db.prepare("SELECT count(*) AS n FROM memories").first("n"),
    ).toBe(0);
  },
);

test("supersession rejects cross-repository/self/missing targets and repairs deletion", async () => {
  const id = await insert();
  const other = await insert("other", "other/repo");
  for (const replacement of [id, other, 999999]) {
    expect(
      (
        await productError("deprecate", {
          ids: [id],
          superseded_by: replacement,
        })
      ).status,
    ).toBe(400);
  }
  const replacement = await insert("replacement");
  expect(
    (await product("deprecate", { ids: [id], superseded_by: replacement }))
      .status,
  ).toBe(200);
  await product("delete", { id: replacement });
  expect(
    await db
      .prepare("SELECT status, superseded_by FROM memories WHERE id = ?")
      .bind(id)
      .first(),
  ).toEqual({ status: "deprecated", superseded_by: null });
});

test("SQL guards reject complementary oversized patches and invalid refs atomically", async () => {
  // 1,800 + "\nTags: " (7) + 90 = 1,897 bytes fits; "\nContext: " (10) + 94 does not.
  const id = await insert("x".repeat(1800));
  await db
    .prepare("UPDATE memories SET tags = ? WHERE id = ?")
    .bind("t".repeat(90), id)
    .run();
  await expect(
    db
      .prepare("UPDATE memories SET context = ? WHERE id = ?")
      .bind("c".repeat(94), id)
      .run(),
  ).rejects.toThrow(/2000 byte embedding budget/);
  // One byte less lands exactly on the cap, which the trigger accepts.
  await db
    .prepare("UPDATE memories SET context = ? WHERE id = ?")
    .bind("c".repeat(93), id)
    .run();
  await db
    .prepare("UPDATE memories SET context = '' WHERE id = ?")
    .bind(id)
    .run();
  await expect(
    db
      .prepare("UPDATE memories SET refs = ? WHERE id = ?")
      .bind("{}", id)
      .run(),
  ).rejects.toThrow(/refs/);
  expect(
    await db
      .prepare("SELECT context, refs FROM memories WHERE id = ?")
      .bind(id)
      .first(),
  ).toEqual({ context: "", refs: "[]" });
});

test("deprecating an exactly-full active embedding deletes rather than re-embeds", async () => {
  // 1,000 two-byte characters are exactly the 2,000-byte cap.
  const added = await product("add", { content: "é".repeat(1000) });
  expect(added.status).toBe(200);
  expect(added.result.size).toMatchObject({
    bytes: 2000,
    remaining_bytes: 0,
    within_budget: true,
  });
  const over = await productError("add", {
    content: "é".repeat(1000),
    tags: "area:api",
  });
  expect(over.status).toBe(400);
  expect(over.error).toContain(
    "Memory is over by 15 bytes of 2,000: content 2,000, tags 15, context 0 bytes.",
  );
  expect((await product("deprecate", { ids: [added.result.id] })).status).toBe(
    200,
  );
  await drain();
  expect(embed).not.toHaveBeenCalled();
  expect(deleteByIds).toHaveBeenCalledWith([String(added.result.id)]);
});

test("failed embedding/index delivery retries without rewriting or duplicating canonical data", async () => {
  const id = await insert();
  const now = Date.now();
  embed.mockRejectedValueOnce(new Error("AI unavailable"));
  await drain(now);
  expect(await job(id)).toMatchObject({
    generation: 1,
    delivered_generation: 0,
    attempts: 1,
    next_attempt_at: now + 1000,
  });
  upsert.mockRejectedValueOnce(new Error("429"));
  await drain(now + 1000);
  expect(await job(id)).toMatchObject({
    attempts: 2,
    next_attempt_at: now + 3000,
  });
  await drain(now + 3000);
  expect(await job(id)).toMatchObject({
    generation: 1,
    delivered_generation: 1,
    attempts: 0,
  });
  expect(
    await db.prepare("SELECT count(*) AS n FROM memories").first("n"),
  ).toBe(1);
  expect(
    await db
      .prepare("SELECT update_count FROM memories WHERE id = ?")
      .bind(id)
      .first("update_count"),
  ).toBe(0);
});

test("a memory that cannot be embedded is parked, reported by stats, and re-queued by a write", async () => {
  const id = await insert("fits");
  const waiting = await insert("waits for the index");
  const now = Date.now();
  // Only SQL that bypasses the size trigger can store a row over the cap.
  await db.prepare("DROP TRIGGER memories_validate_update").run();
  await db
    .prepare("UPDATE memories SET content = ? WHERE id = ?")
    .bind("x".repeat(2001), id)
    .run();
  await applyMigration("0007_embedding_budget");
  embed.mockRejectedValueOnce(new Error("AI unavailable"));
  await drain(now);
  expect(embed).toHaveBeenCalledTimes(1);
  expect(await job(id)).toMatchObject({
    delivered_generation: 0,
    attempts: 1,
    next_attempt_at: Number.MAX_SAFE_INTEGER,
    last_error: "Memory is over by 1 bytes of 2,000.",
  });
  // Later drains skip the parked row and retry only the outage.
  await drain(now + 600_000);
  expect(embed).toHaveBeenCalledTimes(2);
  expect((await job(id))?.attempts).toBe(1);
  expect((await job(waiting))?.delivered_generation).toBe(1);

  const queuedAt = Number((await job(id))?.queued_at);
  expect(Math.abs(queuedAt - now)).toBeLessThan(5000);
  const stats = await product("stats", {});
  expect(stats.result.index).toEqual({
    pending: 0,
    retrying: 0,
    parked: 1,
    oldest_pending_seconds: null,
    failures: [
      {
        error: "Memory is over by 1 bytes of 2,000.",
        state: "parked",
        count: 1,
        ids: [id],
      },
    ],
  });

  await db
    .prepare("UPDATE memories SET content = 'short again' WHERE id = ?")
    .bind(id)
    .run();
  expect((await product("stats", {})).result.index).toMatchObject({
    pending: 1,
    parked: 0,
    failures: [],
  });
  await drain(now + 700_000);
  expect(await job(id)).toMatchObject({ delivered_generation: 3, attempts: 0 });
});

test("stats reports a failing delivery as retrying with its error", async () => {
  const id = await insert();
  embed.mockRejectedValueOnce(new Error("AI unavailable"));
  await drain();
  const { index: status } = (await product("stats", {})).result;
  expect(status).toMatchObject({
    pending: 0,
    retrying: 1,
    parked: 0,
    failures: [
      { error: "AI unavailable", state: "retrying", count: 1, ids: [id] },
    ],
  });
  expect(status.oldest_pending_seconds).toBeLessThan(60);
});

test.each(["update", "delete"])(
  "%s during embedding cannot submit the old vector",
  async (operation) => {
    const id = await insert();
    embed.mockImplementationOnce(async () => {
      if (operation === "delete") {
        await db.prepare("DELETE FROM memories WHERE id = ?").bind(id).run();
      } else {
        await db
          .prepare("UPDATE memories SET content = 'newer' WHERE id = ?")
          .bind(id)
          .run();
      }
      return values;
    });
    await drain();
    expect(upsert).not.toHaveBeenCalled();
    expect((await job(id))?.delivered_generation).toBe(0);
    await drain();
    if (operation === "delete") {
      expect(deleteByIds).toHaveBeenCalledWith([String(id)]);
    } else {
      expect(embed.mock.calls[1][0]).toContain("newer");
    }
    expect(await job(id)).toMatchObject({
      generation: 2,
      delivered_generation: 2,
    });
  },
);

test("mutation during index submission stays pending and tombstones repair late delivery once", async () => {
  const id = await insert();
  const now = Date.now();
  upsert.mockImplementationOnce(async () => {
    await db.prepare("DELETE FROM memories WHERE id = ?").bind(id).run();
    return { mutationId: "late" };
  });
  await drain(now);
  expect(await job(id)).toMatchObject({
    generation: 2,
    delivered_generation: 0,
  });
  await drain(now + 1);
  expect(await job(id)).toMatchObject({
    generation: 2,
    delivered_generation: 2,
  });
  await drain(now + 2);
  expect(deleteByIds).toHaveBeenCalledTimes(1);
  await drain(now + 3_600_001);
  expect(deleteByIds).toHaveBeenCalledTimes(2);
  await drain(now + 30 * 3_600_000);
  expect(deleteByIds).toHaveBeenCalledTimes(2);
});

test("an unchanged active memory is embedded once, repaired once, then left alone", async () => {
  const id = await insert();
  const now = Date.now();
  for (const hours of [0, 1.01, 2.02, 30, 300]) {
    await drain(now + hours * 3_600_000);
  }
  expect(embed).toHaveBeenCalledTimes(2);
  expect(upsert).toHaveBeenCalledTimes(2);
  await db
    .prepare("UPDATE memories SET content = ? WHERE id = ?")
    .bind("edited", id)
    .run();
  await drain(now + 301 * 3_600_000);
  expect(embed).toHaveBeenCalledTimes(3);
  expect(embed.mock.calls[2][0]).toContain("edited");
});

test("a drain reports when the next one is due, and nothing when the queue is empty", async () => {
  const now = Date.now();
  const hour = 3_600_000;
  // Nothing queued: the coordinator sleeps.
  expect(await drain(now)).toBeUndefined();

  const id = await insert();
  // A drain that did work pauses one interval, whatever is due next.
  expect(await drain(now)).toBe(now + DRAIN_INTERVAL_MS);
  // Nothing is due after the pause; the one repair is an hour after delivery.
  expect(await drain(now + DRAIN_INTERVAL_MS)).toBe(now + hour);
  expect(await drain(now + hour)).toBe(now + hour + DRAIN_INTERVAL_MS);
  expect(await drain(now + 2 * hour)).toBeUndefined();
  expect(embed).toHaveBeenCalledTimes(2);

  // A failed delivery is due again after a second, but the pause still applies.
  await db
    .prepare("UPDATE memories SET content = ? WHERE id = ?")
    .bind("edited", id)
    .run();
  const later = now + 3 * hour;
  embed.mockRejectedValueOnce(new Error("AI unavailable"));
  expect(await drain(later)).toBe(later + DRAIN_INTERVAL_MS);
  expect((await job(id))?.next_attempt_at).toBe(later + 1000);

  // One drain embeds at most 20 memories; the rest wait for the next one.
  for (let extra = 0; extra < 25; extra += 1) {
    await insert(`batch ${extra}`);
  }
  embed.mockClear();
  const busy = later + DRAIN_INTERVAL_MS;
  expect(await drain(busy)).toBe(busy + DRAIN_INTERVAL_MS);
  expect(embed).toHaveBeenCalledTimes(20);
  await drain(busy + DRAIN_INTERVAL_MS);
  expect(embed).toHaveBeenCalledTimes(26);
});

test("a request wakes an idle coordinator but never shortens the pause after a drain", () => {
  const now = 1_000_000;
  // Idle, or only a repair an hour away: index the new write in a second.
  expect(wakeAlarmAt(null, now)).toBe(now + 1000);
  expect(wakeAlarmAt(now + 3_600_000, now)).toBe(now + 1000);
  // Within the pause after a drain: requests cannot bring the next drain forward.
  expect(wakeAlarmAt(now + DRAIN_INTERVAL_MS, now)).toBeUndefined();
  expect(wakeAlarmAt(now + 5000, now)).toBeUndefined();
});

test("embedding parser rejects invalid dimensions and nonfinite values", () => {
  expect(parseEmbedding({ data: [values] })).toEqual(values);
  expect(() => parseEmbedding({ data: [[1]] })).toThrow();
  expect(() => parseEmbedding({ data: [[...values.slice(1), NaN]] })).toThrow();
});

test.each([
  ["memory_type", "typo"],
  ["status", "typo"],
  ["certainty", "typo"],
  ["update_count", -1],
  ["update_count", 1.5],
  ["expires_after_days", 1.5],
] as const)(
  "raw SQL cannot poison reads with invalid %s = %s",
  async (field, value) => {
    const id = (
      await product("add", { content: "original", memory_type: "status" })
    ).result.id;
    const columns = field === "memory_type" ? field : `memory_type, ${field}`;
    const params = field === "memory_type" ? [value] : ["status", value];
    await expect(
      db
        .prepare(
          `INSERT INTO memories (repository, content, ${columns}) VALUES (?, ?, ${params.map(() => "?").join(", ")})`,
        )
        .bind("o/r", "bad insert", ...params)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(`UPDATE memories SET ${field} = ? WHERE id = ?`)
        .bind(value, id)
        .run(),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT count(*) AS n FROM memories").first("n"),
    ).toBe(1);
    expect(await job(id)).toMatchObject({
      generation: 1,
      delivered_generation: 0,
    });
    expect((await getRow(id)).id).toBe(id);
  },
);

test("verified writes require evidence, and evidence survives update, history, and restore", async () => {
  const bare = await productError("add", {
    content: "shortcuts fire only in focused forms",
    certainty: "verified",
  });
  expect(bare.status).toBe(400);
  expect(bare.error).toContain("requires at least one evidence kind");

  const added = await product("add", {
    content: "shortcuts fire only in focused forms",
    memory_type: "decision",
    certainty: "verified",
    evidence: ["observed_implementation"],
    validation_gaps: ["Safari untested"],
  });
  expect(added.status).toBe(200);
  expect(added.result.memory).toMatchObject({
    evidence: ["observed_implementation"],
    validation_gaps: ["Safari untested"],
  });
  const id = added.result.id;
  expect((await productError("update", { id, evidence: [] })).status).toBe(400);
  const updated = await product("update", {
    id,
    content: "shortcuts fire in focused forms on macOS",
    evidence: ["observed_implementation", "tested_behavior"],
  });
  expect(updated.status).toBe(200);
  expect(updated.result.memory.evidence).toEqual([
    "observed_implementation",
    "tested_behavior",
  ]);
  const history = await product("history", { id });
  expect(history.result.results[0]).toMatchObject({
    evidence: ["observed_implementation"],
  });
  const restored = await product("restore", {
    id,
    revision_id: history.result.results[0].revision_id,
    expected_update_count: history.result.current_update_count,
  });
  expect(restored.status).toBe(200);
  expect(restored.result.memory).toMatchObject({
    content: "shortcuts fire only in focused forms",
    evidence: ["observed_implementation"],
    validation_gaps: ["Safari untested"],
  });
  const invalid = await db
    .prepare("UPDATE memories SET evidence = ? WHERE id = ?")
    .bind('["looks_right"]', id)
    .run()
    .catch((cause: unknown) => cause);
  expect(String(invalid)).toContain("evidence must be a JSON array");
});

test("updates report dropped details and review candidates; deprecate reviews dependents", async () => {
  const premise = await product("add", {
    content: "Keep nixpkgs-security pinned in flake.nix.",
    memory_type: "decision",
  });
  const dependent = await product("add", {
    content: "Security updates wait for nixpkgs-security bumps.",
    memory_type: "convention",
  });
  const diff = await product("diff", {
    id: premise.result.id,
    content: "Home Manager reimports nixpkgs.",
  });
  expect(diff.result.dropped).toEqual({
    identifiers: ["nixpkgs-security", "flake.nix"],
    sentences: ["Keep nixpkgs-security pinned in flake.nix."],
  });
  // flake.nix is named by no other record; nixpkgs-security still is.
  const refused = await productError("update", {
    id: premise.result.id,
    content: "Home Manager reimports nixpkgs.",
  });
  expect(refused.status).toBe(400);
  expect(refused.error).toContain(
    `Update of memory ${premise.result.id} refused: it drops \`flake.nix\`, which no other active record mentions, and the new content shares 0.1 of its terms`,
  );
  expect(refused.error).toContain(
    `still held elsewhere: \`nixpkgs-security\` (#${dependent.result.id})`,
  );
  expect(refused.error).toContain("allow_drop true");
  expect(await getRow(premise.result.id)).toMatchObject({
    content: "Keep nixpkgs-security pinned in flake.nix.",
    update_count: 0,
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM memory_history").first("n"),
  ).toBe(0);
  const updated = await product("update", {
    id: premise.result.id,
    content: "Home Manager reimports nixpkgs.",
    allow_drop: true,
  });
  expect(updated.status).toBe(200);
  expect(updated.result.dropped?.identifiers).toEqual([
    "nixpkgs-security",
    "flake.nix",
  ]);
  expect(updated.result.review_candidates).toEqual([
    expect.objectContaining({ id: dependent.result.id }),
  ]);
  const deprecated = await product("deprecate", { ids: [dependent.result.id] });
  expect(deprecated.status).toBe(200);
  expect(deprecated.result).not.toHaveProperty("review_candidates");
});

test("doctor reports verified rows without evidence and overlapping gotchas", async () => {
  const legacy = await insert("legacy verified claim");
  await db
    .prepare("UPDATE memories SET certainty = 'verified' WHERE id = ?")
    .bind(legacy)
    .run();
  for (const content of [
    "alchemy@2.0.0-beta.83 polls Durable Objects; patch lib/cloudflare/worker.js.",
    "alchemy@2.0.0-beta.83 precreate needs the lib/cloudflare/worker.js patch.",
  ]) {
    await product("add", { content, memory_type: "gotcha" });
  }
  const doctor = await product("doctor");
  expect(doctor.result.counts_by_kind).toMatchObject({
    verified_without_evidence: 1,
    gotcha_overlap: 1,
  });
});

test.each([
  ["an unmatched upsert", { upsert_match: "nothing stored mentions this" }],
  [
    "a new record over a weak match",
    { upsert_match: "alpha", create_new: true },
  ],
])(
  "add rejects expires_after_days on non-status memories through %s",
  async (_path, upsert) => {
    await product("add", { content: "alpha beta gamma delta" });
    const result = await productError("add", {
      content: "alpha unrelated note",
      memory_type: "decision",
      expires_after_days: 3,
      ...upsert,
    });
    expect(result.status).toBe(400);
    expect(
      await db.prepare("SELECT count(*) AS n FROM memories").first("n"),
    ).toBe(1);
  },
);

test("writes store canonical tags, so doctor reports no invalid_tags", async () => {
  const added = await product("add", {
    content: "tags arrive in mixed case",
    tags: " Area:CLI, topic:Search ,area:cli",
  });
  expect(added.result.memory.tags).toBe("area:cli,topic:search");
  const updated = await product("update", {
    id: added.result.id,
    tags: "Area:API,Kind:Decision",
  });
  expect(updated.result.memory.tags).toBe("area:api,kind:decision");
  const doctor = await product("doctor");
  expect(doctor.result.counts_by_kind).not.toHaveProperty("invalid_tags");
});

test("doctor ignores path segments when pairing near duplicates", async () => {
  await insert("fix api worker src/test/lib/app/tests alpha");
  await insert("fix api worker src/test/lib/app/tests beta");
  await insert("router retries d1 writes on busy errors");
  await insert("router retries d1 writes on busy errors twice");
  const doctor = await product("doctor");
  expect(doctor.result.counts_by_kind).toMatchObject({ near_duplicate: 1 });
});
