import { describe, expect, it } from "vitest";

import {
  agentsMdContent,
  MEMORY_BLOCK_VERSION,
  replaceMemoryBlock,
  staleMemoryBlockWarning,
} from "@/cli/commands/agents-md-content";

const BACKENDS = ["local", "remote", "mcp"] as const;

describe("init templates", () => {
  it("generates local instructions for local memory", () => {
    const content = agentsMdContent("local");

    expect(content).toContain("the local SQLite database `machine-memory.db`");
    expect(content).toContain('machine-memory query "<topic>" --local');
    expect(content).toContain("machine-memory checkpoint --local --json-min");
    expect(content).not.toContain("--remote");
  });

  it("generates remote instructions for remote memory", () => {
    const content = agentsMdContent("remote");

    expect(content).toContain("a remote database shared by every checkout");
    expect(content).toContain(
      'machine-memory query "<topic>" --hybrid --remote',
    );
    expect(content).toContain("machine-memory help workflow");
    expect(content).not.toContain("--local");
  });

  it("generates MCP instructions that name tools, not commands", () => {
    const content = agentsMdContent("mcp");

    for (const tool of [
      "list_repositories",
      "memory_suggest",
      "memory_query",
      "memory_get",
      "memory_size",
      "memory_update",
      "memory_add",
      "memory_list",
    ]) {
      expect(content).toContain(tool);
    }
    expect(content).toContain("upsert_match");
    expect(content).toContain("expires_after_days");
    expect(content).not.toContain("--local");
    expect(content).not.toContain("--remote");
    expect(content).not.toContain("machine-memory help");
  });

  it.each(BACKENDS)("keeps the %s block short and complete", (backend) => {
    const content = agentsMdContent(backend);

    // The block is read on every turn of every thread in the repository.
    expect(new TextEncoder().encode(content).byteLength).toBeLessThan(2600);
    expect(content.split("\n").slice(0, 2)).toEqual([
      "<!-- machine-memory:start -->",
      `<!-- machine-memory:version ${MEMORY_BLOCK_VERSION} ${backend} -->`,
    ]);
    expect(content.endsWith("<!-- machine-memory:end -->")).toBe(true);
    for (const rule of [
      "Before changing code, scan once",
      "a task that touches no files",
      "follow the user and update the record",
      "Write one fact per record",
      "pixel values, UI state and deploy outcomes",
      "that machine's guidance file",
      "Check size before writing",
      "read the record first and keep the details that still hold",
      "`dropped` or `review_candidates`",
      "Reading the code proves only `observed_implementation`",
      "the parent writes them",
      "Before the final response",
    ]) {
      expect(content).toContain(rule);
    }
  });

  it("reports a block older than the one this CLI writes", () => {
    const unversioned =
      "# Notes\n\n<!-- machine-memory:start -->\nold\n<!-- machine-memory:end -->\n";
    expect(staleMemoryBlockWarning(unversioned)).toContain(
      "version 1; this CLI writes version",
    );
    expect(
      staleMemoryBlockWarning(
        "<!-- machine-memory:start -->\n<!-- machine-memory:version 1 mcp -->\nold\n<!-- machine-memory:end -->",
      ),
    ).toContain("machine-memory init --mcp");
    expect(staleMemoryBlockWarning("# Notes without a block\n")).toBe(
      undefined,
    );
    for (const backend of BACKENDS) {
      expect(staleMemoryBlockWarning(agentsMdContent(backend))).toBe(undefined);
      // init replaces a stale block, after which it is current.
      expect(
        staleMemoryBlockWarning(replaceMemoryBlock(unversioned, backend)),
      ).toBe(undefined);
    }
  });

  it("replaces an existing managed block without removing user content", () => {
    const content = replaceMemoryBlock(
      "# Local notes\n\n<!-- machine-memory:start -->\nold\n<!-- machine-memory:end -->\n",
      "remote",
    );

    expect(content).toContain("# Local notes");
    expect(content).toContain("a remote database shared by every checkout");
    expect(content).not.toContain("\nold\n");
    expect(content.match(/machine-memory:start/g)).toHaveLength(1);
  });
});
