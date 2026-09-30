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
