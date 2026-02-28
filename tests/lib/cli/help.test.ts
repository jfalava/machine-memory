import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createCliHarness } from "../../_support/cli-harness";

const harness = createCliHarness();
const { exec, parseJsonValue, asJsonObject, getTestDir } = harness;

describe("help", () => {
  test("returns help JSON with commands and guidance", () => {
    const result = exec("help");
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    const commands = asJsonObject(parsed.commands);
    expect(result.exitCode).toBe(0);
    expect(parsed.name).toBe("machine-memory");
    expect(parsed.commands).toBeDefined();
    expect(commands.add).toBeDefined();
    expect(commands.query).toBeDefined();
    expect(parsed.what_to_store).toBeInstanceOf(Array);
  });

  test("supports --help alias", () => {
    const result = exec("--help");
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(result.exitCode).toBe(0);
    expect(parsed.name).toBe("machine-memory");
    expect(parsed.commands).toBeDefined();
  });

  test("does not create database", () => {
    exec("help");
    expect(existsSync(join(getTestDir(), ".agents", "memory.db"))).toBe(false);
  });

  test("--help does not create database", () => {
    exec("--help");
    expect(existsSync(join(getTestDir(), ".agents", "memory.db"))).toBe(false);
  });
});
