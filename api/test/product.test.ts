import { readFile } from "node:fs/promises";

import { EMBEDDING_DIMENSIONS, type JsonValue } from "@machine-memory/contract";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Redacted } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { handleRestRequest } from "../src/rest-handlers";
import { drainVectorSync, parseEmbedding } from "../src/vector-sync";
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
const query = vi.fn(() =>
  Effect.succeed({ count: 0, matches: [] as { id: string; score: number }[] }),
);
const wake = vi.fn(() => undefined);

beforeAll(async () => {
  mf = new Miniflare({
    host: "127.0.0.1",
    modules: true,
    script: "export default { fetch() { return new Response('test'); } }",
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
  });
  db = await mf.getD1Database("DB");
  // D1 exec splits on lines. Keep each complete trigger as one prepared statement.
  for (const name of [
    "0001_machine_memory",
    "0002_vector_sync",
    "0003_memory_integrity",
  ]) {
    const sql = await readFile(
      new URL(`../../iac/migrations/${name}.sql`, import.meta.url),
      "utf8",
    );
    await db.exec(sql.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  }
});
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  await db.prepare("DELETE FROM memories").run();
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

async function call(path: string, body: JsonValue) {
  const effect = Effect.gen(function* () {
    const handlers = yield* createApiHandlers({
      d1: d1Client(),
      // Only query/run are used by HTTP handlers. Mutation methods deliberately throw.
      vectorize: {
        query,
        upsert: () => {
          throw new Error("HTTP must not mutate vectors");
        },
        deleteByIds: () => {
          throw new Error("HTTP must not mutate vectors");
        },
      } as unknown as Cloudflare.Vectorize.SearchIndexClient,
      ai: { run: aiRun } as unknown as Cloudflare.Workers.AIClient,
      expectedToken: Redacted.make("test"),
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
    Effect.scoped(effect) as Effect.Effect<
      Awaited<Effect.Success<typeof effect>>,
      unknown
    >,
  );
  const payload = response.body.toJSON() as { body: string };
  return { status: response.status, ...JSON.parse(payload.body) };
}
const product = (route: string, fields: Record<string, JsonValue> = {}) =>
  call(`/product/${route}`, { repository: "o/r", ...fields });
async function insert(content = "original", repository = "o/r") {
  const result = await db
    .prepare(
      `INSERT INTO memories (repository, content) VALUES (?, ?) RETURNING id`,
    )
    .bind(repository, content)
    .first<{ id: number }>();
  return result!.id;
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
    expect((await product("deprecate", { ids: [first, second] })).status).toBe(
      500,
    );
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

test("match mutations do not select inactive rows", async () => {
  const id = await insert("inactive match needle");
  await product("deprecate", { ids: [id] });
  const result = await product("update", {
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
  const rows = [
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
  const first = await call("/migrate", {
    repository: "o/r",
    source: "db1",
    rows,
  });
  expect(first.status).toBe(200);
  expect(first.result.inserted).toBe(2);
  const retry = await call("/migrate", {
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
  const other = await call("/migrate", {
    repository: "o/r",
    source: "db2",
    rows: [rows[0]],
  });
  expect(other.result.inserted).toBe(1);
});

test.each([
  { refs: "{}" },
  { refs: "[1]" },
  { content: "x".repeat(600) },
  { expires_after_days: 3 },
])(
  "migration preflights the whole batch before a bad final row: %j",
  async (bad) => {
    const result = await call("/migrate", {
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
      (await product("deprecate", { ids: [id], superseded_by: replacement }))
        .status,
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
  const id = await insert("x".repeat(300));
  await db
    .prepare("UPDATE memories SET tags = ? WHERE id = ?")
    .bind("t".repeat(90), id)
    .run();
  await expect(
    db
      .prepare("UPDATE memories SET context = ? WHERE id = ?")
      .bind("c".repeat(90), id)
      .run(),
  ).rejects.toThrow(/512/);
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
  // Metadata contributes 59 bytes, plus two special tokens: 451 + 59 + 2 = 512.
  const added = await product("add", { content: "x".repeat(451) });
  expect(added.status).toBe(200);
  expect(added.result.size.bytes_estimate).toBe(512);
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

test.each(["update", "delete"])(
  "%s during embedding cannot submit the old vector",
  async (operation) => {
    const id = await insert();
    embed.mockImplementationOnce(async () => {
      if (operation === "delete")
        await db.prepare("DELETE FROM memories WHERE id = ?").bind(id).run();
      else
        await db
          .prepare("UPDATE memories SET content = 'newer' WHERE id = ?")
          .bind(id)
          .run();
      return values;
    });
    await drain();
    expect(upsert).not.toHaveBeenCalled();
    expect((await job(id))?.delivered_generation).toBe(0);
    await drain();
    if (operation === "delete")
      expect(deleteByIds).toHaveBeenCalledWith([String(id)]);
    else expect(embed.mock.calls[1][0]).toContain("newer");
    expect(await job(id)).toMatchObject({
      generation: 2,
      delivered_generation: 2,
    });
  },
);

test("mutation during index submission stays pending and tombstones periodically repair late delivery", async () => {
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
});

test("queued indexing ignores stale client documents", async () => {
  const id = await insert("canonical newest");
  const result = await call("/vectorize/upsert", {
    id,
    repository: "o/r",
    content: "stale",
  });
  expect(result.status).toBe(200);
  expect(result.result.indexing).toBe("queued");
  expect(embed).not.toHaveBeenCalled();
  await drain();
  expect(embed.mock.calls[0][0]).toContain("canonical newest");
  expect(embed.mock.calls[0][0]).not.toContain("stale");
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
    expect((await product("get", { id })).status).toBe(200);
  },
);
