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
    expect(content).toContain("below 512 tokens");
    expect(content).not.toContain("shared remote Worker-backed database");
  });

  it("generates remote instructions for remote memory", () => {
    const content = agentsMdContent("remote");

    expect(content).toContain("with a shared remote Worker-backed database");
    expect(content).toContain(
      'machine-memory query "topic" --remote --json-min',
    );
    expect(content).toContain("below 512 tokens");
    expect(content).not.toContain("machine-memory remote setup");
    expect(content).not.toContain("Ensure `machine-memory.db` is writable");
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
