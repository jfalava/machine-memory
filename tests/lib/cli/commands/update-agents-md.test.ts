import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCliHarness } from "../../../_support/cli-harness";

const harness = createCliHarness();
const { exec, getTestDir } = harness;

describe("update-agents-md", () => {
  test("creates AGENTS.md when it does not exist", () => {
    const agentsPath = join(getTestDir(), "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(false);

    const { stdout, exitCode } = exec("update-agents-md");

    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      "Updated AGENTS.md with recommendations on machine-memory usage",
    );
    expect(existsSync(agentsPath)).toBe(true);

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain("# Project memory");
    expect(content).toContain("machine-memory");
    expect(content).toContain("MANDATORY: Memory scan");
    expect(content).toContain("One-sweep workflow");
  });

  test("appends to existing AGENTS.md", () => {
    const agentsPath = join(getTestDir(), "AGENTS.md");
    const existingContent = "# Existing Project Documentation\n\nSome existing content here.";
    writeFileSync(agentsPath, existingContent);

    const { stdout, exitCode } = exec("update-agents-md");

    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      "Updated AGENTS.md with recommendations on machine-memory usage",
    );

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain("# Existing Project Documentation");
    expect(content).toContain("Some existing content here.");
    expect(content).toContain("# Project memory");
    expect(content).toContain("machine-memory");
    expect(content.indexOf("# Existing Project Documentation")).toBeLessThan(
      content.indexOf("# Project memory"),
    );
  });

  test("appends multiple times without duplicate headers", () => {
    const agentsPath = join(getTestDir(), "AGENTS.md");

    exec("update-agents-md");
    const firstContent = readFileSync(agentsPath, "utf-8");

    exec("update-agents-md");
    const secondContent = readFileSync(agentsPath, "utf-8");

    // Content should be appended, not replaced
    expect(secondContent).toContain(firstContent);
    expect(secondContent.length).toBeGreaterThan(firstContent.length);
    // Should have two occurrences of "# Project memory"
    const matches = secondContent.match(/# Project memory/g);
    expect(matches).toHaveLength(2);
  });
});
