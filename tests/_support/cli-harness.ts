import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  beforeEach as bunBeforeEach,
  afterEach as bunAfterEach,
} from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "..", "..", "src", "app.ts");

export function createCliHarness() {
  let testDir = "";
  const extraEnv: Record<string, string> = {};

  bunBeforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "mm-test-"));
    for (const key of Object.keys(extraEnv)) {
      delete extraEnv[key];
    }
  });

  bunAfterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function runCli(...args: string[]): { stdout: string; exitCode: number } {
    const result = Bun.spawnSync(["bun", CLI, ...args], {
      cwd: testDir,
      env: { ...process.env, ...extraEnv },
    });
    return {
      stdout: result.stdout.toString().trim(),
      exitCode: result.exitCode,
    };
  }

  async function execAsync(
    ...args: string[]
  ): Promise<{ stdout: string; exitCode: number }> {
    const child = Bun.spawn(["bun", CLI, ...args], {
      cwd: testDir,
      env: { ...process.env, ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    return { stdout: stdout.trim(), exitCode };
  }

  function parseJsonValue(text: string): unknown {
    return JSON.parse(text) as unknown;
  }

  function asJsonObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected JSON object");
    }
    return value as Record<string, unknown>;
  }

  function briefLines(...args: string[]): string[] {
    const { stdout } = runCli(...args);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function json(
    ...args: string[]
  ): Record<string, unknown> | Record<string, unknown>[] {
    const { stdout } = runCli(...args);
    return parseJsonValue(stdout) as
      | Record<string, unknown>
      | Record<string, unknown>[];
  }

  async function jsonAsync(
    ...args: string[]
  ): Promise<Record<string, unknown> | Record<string, unknown>[]> {
    const { stdout } = await execAsync(...args);
    return parseJsonValue(stdout) as
      | Record<string, unknown>
      | Record<string, unknown>[];
  }

  function dbRun(sql: string, params: SQLQueryBindings[] = []) {
    const dbPath = join(testDir, ".agents", "memory.db");
    const database = new Database(dbPath);
    try {
      database.run(sql, params);
    } finally {
      database.close();
    }
  }

  return {
    CLI,
    exec: runCli,
    execAsync,
    json,
    jsonAsync,
    briefLines,
    parseJsonValue,
    asJsonObject,
    dbRun,
    getTestDir: () => testDir,
    setEnv: (key: string, value: string) => {
      extraEnv[key] = value;
    },
  };
}
