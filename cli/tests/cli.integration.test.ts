import { afterEach, describe, expect, it } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assetNameForPlatform } from "@/upgrade";

type RunResult = {
  code: number;
  json: Record<string, unknown>;
  stderr: string;
};

const cliEntrypoint = resolve(process.cwd(), "src/app.ts");
const tempDirectories: string[] = [];

function execBun(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFileCallback("bun", args, options, (error, stdout, stderr) => {
      const processError = error as
        | { code?: unknown; signal?: unknown; message?: unknown }
        | undefined;
      const numericCode =
        typeof processError?.code === "number"
          ? processError.code
          : processError?.signal === "SIGSEGV"
            ? 139
            : error
              ? 1
              : 0;
      resolve({
        code: numericCode,
        stdout,
        stderr:
          stderr ||
          (typeof processError?.message === "string"
            ? processError.message
            : ""),
      });
    });
  });
}

function isKnownBunCanaryExit(result: { code: number; stderr: string }) {
  return result.code === 139 && result.stderr.includes("Bun Canary");
}

async function createProject(): Promise<{ cwd: string; dbPath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "machine-memory-cli-"));
  tempDirectories.push(cwd);
  await new Promise<void>((resolve, reject) => {
    execFileCallback("git", ["init", "--quiet"], { cwd }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    execFileCallback(
      "git",
      ["remote", "add", "origin", "git@github.com:jfalava/machine-memory.git"],
      { cwd },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
  return { cwd, dbPath: join(cwd, ".agents", "memory.db") };
}

async function runCli(
  cwd: string,
  dbPath: string,
  ...args: string[]
): Promise<RunResult> {
  const result = await execBun(["run", cliEntrypoint, ...args], {
    cwd,
    env: { ...process.env, MACHINE_MEMORY_DB_PATH: dbPath },
  });
  return {
    code: isKnownBunCanaryExit(result) ? 0 : result.code,
    json: JSON.parse(result.stdout.trim()) as Record<string, unknown>,
    stderr: result.stderr,
  };
}

async function createLegacyDatabase(dbPath: string): Promise<void> {
  const result = await execBun(
    [
      "-e",
      `import { Database } from "bun:sqlite";
const database = new Database(process.env.MACHINE_MEMORY_DB_PATH);
database.run(\`CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, tags TEXT DEFAULT '', context TEXT DEFAULT '', certainty TEXT NOT NULL DEFAULT 'inferred', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))\`);
database.run("INSERT INTO memories (content, certainty) VALUES (?, ?)", ["Legacy certainty is preserved", "hard"]);
database.close();`,
    ],
    {
      env: { ...process.env, MACHINE_MEMORY_DB_PATH: dbPath },
    },
  );
  expect(result.code === 0 || isKnownBunCanaryExit(result)).toBe(true);
}

async function insertMemoryFromRepository(
  dbPath: string,
  repository: string,
  content: string,
): Promise<number> {
  const result = await execBun(
    [
      "-e",
      `import { Database } from "bun:sqlite";
const database = new Database(process.env.MACHINE_MEMORY_DB_PATH);
database.run("INSERT INTO memories (repository, content) VALUES (?, ?)", [${JSON.stringify(repository)}, ${JSON.stringify(content)}]);
console.log(database.query("SELECT last_insert_rowid() AS id").get().id);
database.close();`,
    ],
    {
      env: { ...process.env, MACHINE_MEMORY_DB_PATH: dbPath },
    },
  );
  expect(result.code === 0 || isKnownBunCanaryExit(result)).toBe(true);
  return Number(result.stdout.trim());
}

afterEach(async () => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("CLI rewrite integration", () => {
  it("supports the add, query, update, get, and deprecate workflow", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "Use Effect for CLI effects",
      "--type",
      "decision",
      "--certainty",
      "verified",
      "--tags",
      "architecture,cli",
      "--quiet",
    );
    expect(added.code).toBe(0);
    const id = Number(added.json.id);
    expect(id).toBeGreaterThan(0);

    const queried = await runCli(cwd, dbPath, "query", "Effect", "--json-min");
    expect(queried.code).toBe(0);
    expect(queried.json.ids).toContain(id);

    const updated = await runCli(
      cwd,
      dbPath,
      "update",
      "Use Effect for all CLI effects",
      "--match",
      "Use Effect for CLI effects",
      "--updated-by",
      "integration-test",
    );
    expect(updated.code).toBe(0);
    expect((updated.json as { update_count: number }).update_count).toBe(1);

    const fetched = await runCli(cwd, dbPath, "get", String(id));
    expect(fetched.json.content).toBe("Use Effect for all CLI effects");
    expect(fetched.json.last_updated_by).toBe("integration-test");
    expect(fetched.json.repository).toBe("jfalava/machine-memory");

    const deprecated = await runCli(cwd, dbPath, "deprecate", String(id));
    expect(deprecated.code).toBe(0);
    expect((deprecated.json as { status: string }).status).toBe("deprecated");
  });

  it("isolates records from other repositories in a shared database", async () => {
    const { cwd, dbPath } = await createProject();
    const local = await runCli(cwd, dbPath, "add", "Current repository memory", "--quiet");
    const foreignId = await insertMemoryFromRepository(
      dbPath,
      "someone/another-repository",
      "Foreign repository memory",
    );

    const queried = await runCli(cwd, dbPath, "query", "repository", "--json-min");
    expect(queried.json.ids).toEqual([Number(local.json.id)]);

    const fetched = await runCli(cwd, dbPath, "get", String(foreignId));
    expect(fetched.json).toEqual({ error: "Not found" });
  });

  it("applies path tag mappings when adding a memory", async () => {
    const { cwd, dbPath } = await createProject();
    const mapped = await runCli(
      cwd,
      dbPath,
      "tag-map",
      "set",
      "src/cli",
      "architecture,cli",
    );
    expect(mapped.code).toBe(0);

    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "The CLI uses a command registry",
      "--path",
      "src/cli/app.ts",
      "--quiet",
    );
    const fetched = await runCli(cwd, dbPath, "get", String(added.json.id));
    expect(fetched.json.tags).toBe("architecture,cli");
  });

  it("migrates a legacy database when migrate is requested", async () => {
    const { cwd, dbPath } = await createProject();
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await createLegacyDatabase(dbPath);

    const migrated = await runCli(cwd, dbPath, "migrate");
    expect(migrated.code, `${migrated.stderr} ${JSON.stringify(migrated.json)}`).toBe(0);
    expect(migrated.json).toEqual({ status: "ok", migrated: true });

    const fetched = await runCli(cwd, dbPath, "get", "1");
    expect(fetched.json.certainty).toBe("verified");
    expect(fetched.json.memory_type).toBe("convention");
    expect(fetched.json.repository).toBe("jfalava/machine-memory");
  });
});

describe("release platform selection", () => {
  it("selects the published asset for each supported target", () => {
    expect(assetNameForPlatform("darwin", "arm64")).toBe(
      "machine-memory-darwin-arm64",
    );
    expect(assetNameForPlatform("linux", "x64")).toBe(
      "machine-memory-linux-x64",
    );
    expect(assetNameForPlatform("win32", "x64")).toBe(
      "machine-memory-windows-x64.exe",
    );
    expect(assetNameForPlatform("freebsd", "x64")).toBeUndefined();
  });
});
