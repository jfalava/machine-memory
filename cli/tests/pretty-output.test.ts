import { describe, expect, it } from "vitest";
import { outputModeForPretty, prettyOutputEnabled } from "@/cli/runtime/output";
import { renderPretty } from "@/cli/runtime/pretty";

describe("pretty output", () => {
  it("renders memory results as a readable table", () => {
    const output = renderPretty("query", [
      {
        id: 7,
        memory_type: "decision",
        certainty: "verified",
        tags: "cli,output",
        content: "Use a human renderer for terminal users",
      },
    ]);

    expect(output).toContain("Search results");
    expect(output).toContain("CERTAINTY");
    expect(output).toContain("Use a human renderer for terminal");
    expect(output).toContain("users");
    expect(output).not.toContain('"memory_type"');
  });

  it("wraps wide memory rows to a consistent table width", () => {
    const output = renderPretty("list", [
      {
        id: 7,
        memory_type: "decision",
        certainty: "verified",
        tags: "area:cli,topic:output,kind:decision,terminal,rendering",
        content:
          "This is deliberately long content that should wrap across multiple lines without breaking the table layout for a human terminal reader.",
      },
    ]);
    const tableLines = output
      .split("\n")
      .filter((line) => /[┌│└]/u.test(line))
      .map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
    const rowSeparators = output
      .split("\n")
      .filter((line) => line.includes("├"));

    expect(tableLines.length).toBeGreaterThan(4);
    expect(new Set(tableLines.map((line) => line.length)).size).toBe(1);
    expect(rowSeparators.length).toBe(1);
    expect(output).not.toMatch(/[╔╤╟╚╧]/u);
    expect(output).toContain("This is deliberately long content");
  });

  it("renders help as conventional command sections", () => {
    const output = renderPretty("help", {
      name: "machine-memory",
      description: "Persistent project-scoped memory for LLM agents.",
      database: "Use exactly one of --local or --remote.",
      global_options: {
        pretty: "Render human-readable output for machine commands.",
      },
      commands: {
        help: "Show this help message",
        query: {
          usage: "query <search_term> [--remote]",
        },
        remote: {
          setup: {
            usage: "remote setup",
            description: "Store remote credentials.",
          },
        },
      },
    });

    expect(output).toContain("Commands");
    expect(output).toContain("  help");
    expect(output).toContain("    Show this help message");
    expect(output).toContain("  query");
    expect(output).toContain("    Usage: query <search_term> [--remote]");
    expect(output).toContain("  remote setup");
    expect(output).toContain("Global options");
    expect(output).toContain("  --pretty");
    expect(output).not.toContain("COMMAND");
    expect(output).not.toContain("┌");
  });

  it("renders a memory detail as labeled fields", () => {
    const output = renderPretty("get", {
      id: 3,
      content: "Keep output stable",
      memory_type: "decision",
      certainty: "verified",
      tags: "cli",
      refs: ["docs/output"],
    });

    expect(output).toContain("Memory #3");
    expect(output).toContain("Content");
    expect(output).toContain("Keep output stable");
    expect(output).toContain("• docs/output");
  });

  it("lets explicit machine modes override pretty", () => {
    expect(prettyOutputEnabled(outputModeForPretty(true))).toBe(true);
    expect(
      prettyOutputEnabled({
        ...outputModeForPretty(true),
        jsonMin: true,
      }),
    ).toBe(false);
    expect(
      prettyOutputEnabled({
        ...outputModeForPretty(true),
        quiet: true,
      }),
    ).toBe(false);
  });
});
