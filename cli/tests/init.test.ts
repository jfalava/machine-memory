import { describe, expect, it } from "vitest";
import {
  agentsMdContent,
  replaceMemoryBlock,
} from "@/cli/commands/agents-md-content";

describe("init templates", () => {
  it("generates local instructions for local memory", () => {
    const content = agentsMdContent("local");

    expect(content).toContain(
      "with a local SQLite database at `machine-memory.db`",
    );
    expect(content).toContain(
      'machine-memory query "topic" --local --json-min',
    );
    expect(content).toContain("Ensure `machine-memory.db` is writable");
    expect(content).toContain("below 512 BGE tokens");
    expect(content).toContain('machine-memory size "<text>"');
    expect(content).toContain("--force` if a new record is intended");
    expect(content).not.toContain("shared remote Worker-backed database");
  });

  it("generates remote instructions for remote memory", () => {
    const content = agentsMdContent("remote");

    expect(content).toContain("with a shared remote Worker-backed database");
    expect(content).toContain(
      'machine-memory query "topic" --remote --json-min',
    );
    expect(content).toContain("below 512 BGE tokens");
    expect(content).toContain('machine-memory size "<text>"');
    expect(content).toContain("--force` if a new record is intended");
    expect(content).not.toContain("machine-memory remote setup");
    expect(content).not.toContain("Ensure `machine-memory.db` is writable");
  });

  it("generates MCP instructions matching the MCP tool surface", () => {
    const content = agentsMdContent("mcp");

    expect(content).toContain("<!-- machine-memory:start -->");
    expect(content).toContain("<!-- machine-memory:end -->");
    for (const tool of [
      "list_repositories",
      "memory_suggest",
      "memory_query",
      "memory_get",
      "memory_list",
      "memory_doctor",
      "memory_stats",
      "memory_gc",
      "memory_verify",
      "memory_diff",
      "memory_size",
      "memory_add",
      "memory_update",
      "memory_deprecate",
      "memory_delete",
      "memory_delete_many",
    ]) {
      expect(content).toContain(tool);
    }
    // Parity workflows the MCP server supports.
    expect(content).toContain("upsert_match");
    expect(content).toContain("force: true");
    expect(content).toContain("potential_conflicts");
    expect(content).toContain("superseded_by");
    expect(content).toContain("memory_size");
    expect(content).toContain("over_by_bytes");
    expect(content).toContain("expires_after_days");
    expect(content).toContain(
      "No local CLI or `machine-memory.db` is required",
    );
    expect(content).not.toContain("--local");
    expect(content).not.toContain("--remote");
  });

  it("replaces an existing managed block without removing user content", () => {
    const content = replaceMemoryBlock(
      "# Local notes\n\n<!-- machine-memory:start -->\nold\n<!-- machine-memory:end -->\n",
      "remote",
    );

    expect(content).toContain("# Local notes");
    expect(content).toContain("shared remote Worker-backed database");
    expect(content).not.toContain("\nold\n");
  });
});
