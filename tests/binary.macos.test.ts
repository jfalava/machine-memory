import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;

const macArch = process.arch === "arm64" ? "arm64" : "x64";
const BIN = join(
  import.meta.dir,
  "..",
  "dist",
  `machine-memory-darwin-${macArch}`,
);

function execBin(...args: string[]) {
  const result = Bun.spawnSync([BIN, ...args], {
    cwd: testDir,
  });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

function json(...args: string[]): unknown {
  const result = execBin(...args);
  return JSON.parse(result.stdout) as unknown;
}

function requireMacOS() {
  if (process.platform !== "darwin") {
    throw new Error("macOS binary integration tests must run on macOS");
  }
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "mm-bin-test-"));
});

afterAll(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe("macOS binary integration", () => {
  test("compiled macOS binary exists and returns version JSON", () => {
    requireMacOS();
    expect(existsSync(BIN)).toBe(true);

    const result = execBin("version");
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(typeof payload.version).toBe("string");
  });

  test("compiled macOS binary can add/list/query memories", () => {
    requireMacOS();
    expect(existsSync(BIN)).toBe(true);

    const add = json(
      "add",
      "Compiled binary auth note",
      "--tags",
      "auth,binary",
      "--type",
      "decision",
    ) as Record<string, unknown>;
    expect(add.id).toBe(1);

    const list = json("list") as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]?.content).toBe("Compiled binary auth note");

    const query = json("query", "binary") as Record<string, unknown>[];
    expect(query).toHaveLength(1);
    expect(query[0]?.id).toBe(1);
    expect(typeof query[0]?.score).toBe("number");
  });
});
