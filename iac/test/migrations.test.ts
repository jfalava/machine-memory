import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test.each(["0001_machine_memory", "0002_vector_sync", "0003_memory_integrity"])(
  "D1 receives complete one-line triggers from %s",
  async (name) => {
    const sql = await readFile(
      new URL(`../migrations/${name}.sql`, import.meta.url),
      "utf8",
    );
    const triggers = sql.match(/^CREATE TRIGGER[^\n]*/gm) ?? [];
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) {
      expect(trigger).toMatch(/\bBEGIN\b.*\bEND;$/);
    }
  },
);
