import { describe, test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCliHarness } from "../../../_support/cli-harness";

const harness = createCliHarness();
const { exec, json, parseJsonValue, asJsonObject, getTestDir } = harness;

describe("add", () => {
  test("adds a memory and returns it with id", () => {
    const result = json("add", "test content") as Record<string, unknown>;
    expect(result.id).toBe(1);
    expect(result.content).toBe("test content");
    expect(result.tags).toBe("");
    expect(result.context).toBe("");
  });

  test("adds a memory with tags", () => {
    const result = json("add", "tagged", "--tags", "a,b") as Record<
      string,
      unknown
    >;
    expect(result.tags).toBe("a,b");
  });

  test("adds a memory with context", () => {
    const result = json(
      "add",
      "with context",
      "--context",
      "some reason",
    ) as Record<string, unknown>;
    expect(result.context).toBe("some reason");
  });

  test("adds a memory with tags and context", () => {
    const result = json(
      "add",
      "full",
      "--tags",
      "x",
      "--context",
      "y",
    ) as Record<string, unknown>;
    expect(result.tags).toBe("x");
    expect(result.context).toBe("y");
  });

  test("adds a memory from --from-file", () => {
    const filePath = join(getTestDir(), "memory.txt");
    writeFileSync(filePath, "line one\nline two");
    const result = json("add", "--from-file", "memory.txt") as Record<
      string,
      unknown
    >;
    expect(result.content).toBe("line one\nline two");
  });

  test("auto-increments ids", () => {
    const first = json("add", "first") as Record<string, unknown>;
    const second = json("add", "second") as Record<string, unknown>;
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
  });

  test("errors when no content provided", () => {
    const result = exec("add");
    expect(result.exitCode).toBe(1);
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(parsed.error).toContain("Usage:");
  });

  test("supports --no-conflicts to suppress potential_conflicts payload", () => {
    const result = json("add", "lean output", "--no-conflicts") as Record<
      string,
      unknown
    >;
    expect(result.id).toBe(1);
    expect(result.potential_conflicts).toBeUndefined();
  });

  test("supports --json-min on add", () => {
    const result = json("add", "json min output", "--json-min") as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ id: 1 });
  });

  test("supports --quiet on add", () => {
    const result = json("add", "quiet output", "--quiet") as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ id: 1 });
  });

  test("supports --upsert-match and updates a strong active match", () => {
    json(
      "add",
      "Auth JWT policy rotates RS256 signing keys every 24h",
      "--tags",
      "auth,jwt",
    );
    const result = json(
      "add",
      "Auth JWT policy rotates RS256 signing keys every 12h",
      "--upsert-match",
      "auth jwt policy",
    ) as Record<string, unknown>;
    expect(result.mode).toBe("updated");
    expect(result.id).toBe(1);

    const listed = json("list") as Record<string, unknown>[];
    expect(listed).toHaveLength(1);
    expect((json("get", "1") as Record<string, unknown>).content).toContain(
      "every 12h",
    );
  });

  test("supports --upsert-match and creates when match is weak", () => {
    json("add", "Database migration checklist and rollback order", "--tags", "db");
    const result = json(
      "add",
      "Frontend typography scale and spacing guidelines",
      "--upsert-match",
      "database migration checklist",
    ) as Record<string, unknown>;
    expect(result.mode).toBe("created");
    expect(result.id).toBe(2);
  });
});

describe("update", () => {
  test("updates content of a memory", () => {
    json("add", "original");
    const result = json("update", "1", "modified") as Record<string, unknown>;
    expect(result.content).toBe("modified");
  });

  test("updates tags", () => {
    json("add", "item", "--tags", "old");
    const result = json("update", "1", "item", "--tags", "new") as Record<
      string,
      unknown
    >;
    expect(result.tags).toBe("new");
  });

  test("updates context", () => {
    json("add", "item", "--context", "old reason");
    const result = json(
      "update",
      "1",
      "item",
      "--context",
      "new reason",
    ) as Record<string, unknown>;
    expect(result.context).toBe("new reason");
  });

  test("updates content from --from-file", () => {
    json("add", "item");
    const filePath = join(getTestDir(), "updated.txt");
    writeFileSync(filePath, "updated from file\nwith details");
    const result = json("update", "1", "--from-file", "updated.txt") as Record<
      string,
      unknown
    >;
    expect(result.content).toBe("updated from file\nwith details");
  });

  test("supports --match for fuzzy content updates", () => {
    json("add", "Views schema has running/errored/finished states");
    const result = json(
      "update",
      "--match",
      "views schema",
      "Views schema includes running, errored, and finished",
    ) as Record<string, unknown>;
    expect(result.id).toBe(1);
    expect(result.content).toContain("running, errored, and finished");
  });

  test("updates updated_at timestamp", () => {
    json("add", "item");
    const original = json("get", "1") as Record<string, unknown>;
    Bun.sleepSync(1100);
    json("update", "1", "changed");
    const modified = json("get", "1") as Record<string, unknown>;
    expect(modified.updated_at).not.toBe(original.updated_at);
  });

  test("preserves tags when not specified in update", () => {
    json("add", "item", "--tags", "keep-me");
    json("update", "1", "new content");
    const result = json("get", "1") as Record<string, unknown>;
    expect(result.tags).toBe("keep-me");
  });

  test("returns error for nonexistent id", () => {
    const result = json("update", "999", "content") as Record<string, unknown>;
    expect(result.error).toBe("Not found");
  });

  test("errors when missing arguments", () => {
    const result = exec("update");
    expect(result.exitCode).toBe(1);
  });

  test("accepts comma-separated ids", () => {
    json("add", "first");
    json("add", "second");
    const result = json(
      "update",
      "1,2",
      "shared updated content",
      "--tags",
      "bulk",
    ) as Record<string, unknown>;
    expect(result.count).toBe(2);
    const updated = result.updated as Record<string, unknown>[];
    expect(updated).toHaveLength(2);
    expect(
      updated.every((entry) => entry.content === "shared updated content"),
    ).toBe(true);
  });
});

describe("deprecate", () => {
  test("marks status and query excludes deprecated by default", () => {
    json("add", "legacy auth token format");
    json("add", "new auth token format");

    const deprecated = json("deprecate", "1", "--superseded-by", "2") as Record<
      string,
      unknown
    >;
    expect(deprecated.status).toBe("superseded_by");
    expect(deprecated.superseded_by).toBe(2);

    const defaultQuery = json("query", "legacy") as Record<string, unknown>;
    expect(defaultQuery.results).toEqual([]);

    const withDeprecated = json(
      "query",
      "legacy",
      "--include-deprecated",
    ) as Record<string, unknown>[];
    expect(withDeprecated).toHaveLength(1);
    expect(withDeprecated[0]?.id).toBe(1);
  });

  test("supports --match on deprecate", () => {
    json("add", "views schema snapshot");
    const deprecated = json("deprecate", "--match", "views schema") as Record<
      string,
      unknown
    >;
    expect(deprecated.id).toBe(1);
    expect(deprecated.status).toBe("deprecated");
  });

  test("accepts comma-separated ids", () => {
    json("add", "s1");
    json("add", "s2");
    json("add", "replacement");

    const result = json("deprecate", "1,2", "--superseded-by", "3") as Record<
      string,
      unknown
    >;
    expect(result.count).toBe(2);
    const deprecated = result.deprecated as Record<string, unknown>[];
    expect(deprecated).toHaveLength(2);
    expect(deprecated.every((entry) => entry.status === "superseded_by")).toBe(
      true,
    );
  });
});

describe("delete", () => {
  test("deletes a memory", () => {
    json("add", "to delete");
    const result = json("delete", "1") as Record<string, unknown>;
    expect(result.deleted).toBe(1);
  });

  test("memory is gone after delete", () => {
    json("add", "gone");
    json("delete", "1");
    const result = json("get", "1") as Record<string, unknown>;
    expect(result.error).toBe("Not found");
  });

  test("errors when no id provided", () => {
    const result = exec("delete");
    expect(result.exitCode).toBe(1);
  });

  test("accepts comma-separated ids", () => {
    json("add", "one");
    json("add", "two");
    json("add", "three");
    const result = json("delete", "1,3") as Record<string, unknown>;
    expect(result.deleted).toEqual([1, 3]);
    expect(result.count).toBe(2);
    expect((json("get", "1") as Record<string, unknown>).error).toBe(
      "Not found",
    );
    expect((json("get", "2") as Record<string, unknown>).content).toBe("two");
  });
});

describe("status cascade", () => {
  test("prompts deprecating older active status memories with overlapping tags", () => {
    json("add", "Phase 1 status", "--type", "status", "--tags", "client,phase");
    const created = json(
      "add",
      "Phase 2 status",
      "--type",
      "status",
      "--tags",
      "client,phase2",
    ) as Record<string, unknown>;

    const cascade = asJsonObject(created.status_cascade);
    expect(cascade.overlapping_ids).toEqual([1]);
    expect(String(cascade.suggested_command)).toContain(
      "machine-memory deprecate 1 --superseded-by 2",
    );
  });
});

describe("structured fields on write", () => {
  test("supports --type on add and update", () => {
    json("add", "routing rule alpha", "--type", "decision");
    const updated = json(
      "update",
      "1",
      "routing rule alpha",
      "--type",
      "status",
    ) as Record<string, unknown>;
    expect(updated.memory_type).toBe("status");
  });

  test("tracks source_agent, last_updated_by, and update_count", () => {
    const created = json(
      "add",
      "provenance memory",
      "--source-agent",
      "claude-sonnet-4-6",
    ) as Record<string, unknown>;

    expect(created.source_agent).toBe("claude-sonnet-4-6");
    expect(created.last_updated_by).toBe("claude-sonnet-4-6");
    expect(created).toHaveProperty("created_at");
    expect(created.update_count).toBe(0);

    const updated = json(
      "update",
      "1",
      "provenance memory revised",
      "--updated-by",
      "gpt-5-codex",
    ) as Record<string, unknown>;
    expect(updated.last_updated_by).toBe("gpt-5-codex");
    expect(updated.update_count).toBe(1);
  });

  test("defaults certainty to inferred and supports updates", () => {
    const created = json("add", "certainty test") as Record<string, unknown>;
    expect(created.certainty).toBe("inferred");

    const updated = json(
      "update",
      "1",
      "certainty test",
      "--certainty",
      "verified",
    ) as Record<string, unknown>;
    expect(updated.certainty).toBe("verified");

    const listed = json("list", "--certainty", "verified") as Record<
      string,
      unknown
    >[];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(1);
  });

  test("accepts legacy certainty aliases and normalizes output", () => {
    const created = json(
      "add",
      "legacy certainty alias",
      "--certainty",
      "soft",
    ) as Record<string, unknown>;
    expect(created.certainty).toBe("inferred");

    const updated = json(
      "update",
      "1",
      "legacy certainty alias",
      "--certainty",
      "hard",
    ) as Record<string, unknown>;
    expect(updated.certainty).toBe("verified");
  });

  test("returns potential_conflicts in add response", () => {
    json("add", "JWT middleware uses RS256 signatures", "--tags", "auth,jwt");

    const created = json(
      "add",
      "Auth JWT middleware signs with RS256",
      "--tags",
      "auth",
    ) as Record<string, unknown>;

    const conflicts = created.potential_conflicts as Record<string, unknown>[];
    expect(Array.isArray(conflicts)).toBe(true);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some((item) => item.id === 1)).toBe(true);
  });

  test("stores refs internally and returns refs as arrays on add/update", () => {
    const created = json(
      "add",
      "refs example",
      "--refs",
      '["https://example.com/pr/1","docs/adr-001.md"]',
    ) as Record<string, unknown>;
    expect(created.refs).toEqual([
      "https://example.com/pr/1",
      "docs/adr-001.md",
    ]);

    const updated = json(
      "update",
      "1",
      "refs example updated",
      "--refs",
      '["https://example.com/issues/2"]',
    ) as Record<string, unknown>;
    expect(updated.refs).toEqual(["https://example.com/issues/2"]);
  });
});
