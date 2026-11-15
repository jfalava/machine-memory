import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("integrity triggers avoid nested END tokens in D1 HTTP batches", async () => {
  const sql = await readFile(
    new URL("../migrations/0003_memory_integrity.sql", import.meta.url),
    "utf8",
  );
  // CASE expressions add END tokens that the remote trigger splitter misreads.
  expect(sql.replace(/^--.*$/gm, "")).not.toMatch(/\bCASE\b/i);
});

test("history triggers use D1-compatible trigger bodies", async () => {
  const sql = await readFile(
    new URL("../migrations/0004_memory_history.sql", import.meta.url),
    "utf8",
  );
  expect(sql.replace(/^--.*$/gm, "")).not.toMatch(/\bCASE\b/i);
});

test("evidence migrations keep columns separate from rerunnable D1-compatible triggers", async () => {
  const columns = await readFile(
    new URL("../migrations/0005_memory_evidence.sql", import.meta.url),
    "utf8",
  );
  const triggers = await readFile(
    new URL("../migrations/0006_memory_evidence_triggers.sql", import.meta.url),
    "utf8",
  );
  // The local CLI reruns 0006 on every migration, so it must not add columns.
  expect(triggers).not.toMatch(/\bALTER\b/i);
  expect(columns).not.toMatch(/\bTRIGGER\b/i);
  expect(triggers.replace(/^--.*$/gm, "")).not.toMatch(/\bCASE\b/i);
});

test("the embedding budget migration replaces both validation triggers and is rerunnable", async () => {
  const sql = await readFile(
    new URL("../migrations/0007_embedding_budget.sql", import.meta.url),
    "utf8",
  );
  const statements = sql.replace(/^--.*$/gm, "");
  expect(statements).not.toMatch(/\bCASE\b/i);
  expect(statements).not.toMatch(/\bALTER\b/i);
  for (const trigger of [
    "memories_validate_insert",
    "memories_validate_update",
  ]) {
    expect(statements).toContain(`DROP TRIGGER IF EXISTS ${trigger};`);
    expect(statements).toContain(`CREATE TRIGGER ${trigger} BEFORE`);
  }
  // The cap and the composition match contract's MAX_EMBEDDING_BYTES and composeEmbeddingText.
  expect(statements.match(/AS BLOB\)\) > 2000;/g)).toHaveLength(2);
  expect(statements).not.toContain("Memory type:");
});

test("the vector sync queue migration dates every queued write", async () => {
  const sql = await readFile(
    new URL("../migrations/0008_vector_sync_queue.sql", import.meta.url),
    "utf8",
  );
  const statements = sql.replace(/^--.*$/gm, "");
  expect(statements).not.toMatch(/\bCASE\b/i);
  for (const trigger of [
    "memory_vector_insert",
    "memory_vector_update",
    "memory_vector_delete",
  ]) {
    expect(statements).toContain(`DROP TRIGGER ${trigger};`);
    expect(statements).toContain(`CREATE TRIGGER ${trigger} AFTER`);
  }
  expect(statements.match(/queued_at = excluded\.queued_at;/g)).toHaveLength(3);
});

test("the vector sync model migration adds the column once and backfills in one statement", async () => {
  const sql = await readFile(
    new URL("../migrations/0009_vector_sync_model.sql", import.meta.url),
    "utf8",
  );
  const statements = sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  expect(statements).toHaveLength(2);
  expect(statements[0]).toBe(
    "ALTER TABLE memory_vector_sync ADD COLUMN delivered_model TEXT",
  );
  // Triggers do not name the column, so writes queued by them leave it as it is.
  expect(sql).not.toMatch(/\bTRIGGER\b/i);
  expect(sql.replace(/^--.*$/gm, "")).not.toMatch(/\bCASE\b/i);
});
