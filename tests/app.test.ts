import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/lib/constants";
import { createCliHarness } from "./_support/cli-harness";

const harness = createCliHarness();
const { exec, json, parseJsonValue, asJsonObject, getTestDir } = harness;

describe("database initialization", () => {
  test("creates .agents/memory.db on first command", () => {
    exec("list");
    expect(existsSync(join(getTestDir(), ".agents", "memory.db"))).toBe(true);
  });

  test("creates .agents directory if missing", () => {
    expect(existsSync(join(getTestDir(), ".agents"))).toBe(false);
    exec("list");
    expect(existsSync(join(getTestDir(), ".agents"))).toBe(true);
  });
});

describe("no command", () => {
  test("exits with error and shows help when no command given", () => {
    const result = exec();
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(result.exitCode).toBe(1);
    expect(parsed.name).toBe("machine-memory");
    expect(parsed.commands).toBeDefined();
  });
});

describe("unknown command", () => {
  test("exits with error for unknown command", () => {
    const result = exec("foo");
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain("Unknown command: foo");
  });
});

describe("version", () => {
  test("returns version as JSON matching package.json", () => {
    const result = json("version") as Record<string, unknown>;
    expect(result).toHaveProperty("version");
    expect(result.version).toBe(VERSION);
  });

  test("does not create database", () => {
    exec("version");
    expect(existsSync(join(getTestDir(), ".agents", "memory.db"))).toBe(false);
  });
});

describe("output format", () => {
  test("all output is valid JSON", () => {
    const commands = [
      ["add", "test"],
      ["list"],
      ["get", "1"],
      ["query", "test"],
      ["version"],
    ];
    for (const entry of commands) {
      const { stdout } = exec(...entry);
      expect(() => {
        void parseJsonValue(stdout);
      }).not.toThrow();
    }
  });
});
