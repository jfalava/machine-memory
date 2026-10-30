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
