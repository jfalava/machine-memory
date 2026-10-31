import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { MigrationRequestInputSchema } from "@machine-memory/contract";
import { Schema } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  type CliOutput,
  type CliRow,
  decodeCliOutput,
  decodeCliRows,
} from "./fixtures/cli-output";
import { tokenizerConfig, tokenizerJson } from "./fixtures/tokenizer";

let tokenizerServer: Server;
/** Tokenizer download overrides that point the CLI at the local test server. */
type TokenizerEnv = {
  MACHINE_MEMORY_BGE_TOKENIZER_URL?: string;
  MACHINE_MEMORY_BGE_TOKENIZER_CONFIG_URL?: string;
};

let tokenizerEnv: TokenizerEnv = {};

type RunResult = {
  code: number;
  json: CliOutput;
  stderr: string;
};

type RowsRunResult = {
  code: number;
  rows: readonly CliRow[];
  stderr: string;
};

type TextRunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const databaseCommands = new Set([
  "add",
  "query",
  "list",
  "get",
  "history",
  "update",
  "restore",
  "deprecate",
  "delete",
  "suggest",
  "sweep",
  "checkpoint",
  "doctor",
  "verify",
  "diff",
  "coverage",
  "gc",
  "stats",
  "import",
  "export",
  "migrate",
]);

const cliEntrypoint = resolve(process.cwd(), "src/app.ts");
const tempDirectories: string[] = [];

function execBun(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFileCallback(
      "bun",
      args,
      {
        ...options,
        env: {
          ...process.env,
          ...tokenizerEnv,
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        const numericCode =
          error === null
            ? 0
            : Schema.is(Schema.Int)(error.code)
              ? error.code
              : error.signal === "SIGSEGV"
                ? 139
                : 1;
        resolvePromise({
          code: numericCode,
          stdout,
          stderr: stderr || (error?.message ?? ""),
        });
      },
    );
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
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    execFileCallback(
      "git",
      ["remote", "add", "origin", "git@github.com:jfalava/machine-memory.git"],
      { cwd },
      (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });
  return { cwd, dbPath: join(cwd, ".agents", "memory.db") };
}

async function runCliStdout(
  cwd: string,
  dbPath: string,
  args: string[],
): Promise<TextRunResult> {
  const backendFlag =
    databaseCommands.has(args[0] ?? "") &&
    !args.includes("--local") &&
    !args.includes("--remote")
      ? ["--local"]
      : [];
  const result = await execBun(
    ["run", cliEntrypoint, ...args, ...backendFlag],
    {
      cwd,
      env: { ...process.env, MACHINE_MEMORY_DB_PATH: dbPath },
    },
  );
  return {
    code: isKnownBunCanaryExit(result) ? 0 : result.code,
    stdout: result.stdout.trim(),
    stderr: result.stderr,
  };
}

async function runCli(
  cwd: string,
  dbPath: string,
  ...args: string[]
): Promise<RunResult> {
  const result = await runCliStdout(cwd, dbPath, args);
  return {
    code: result.code,
    json: decodeCliOutput(result.stdout),
    stderr: result.stderr,
  };
}

async function runCliRows(
  cwd: string,
  dbPath: string,
  ...args: string[]
): Promise<RowsRunResult> {
  const result = await runCliStdout(cwd, dbPath, args);
  return {
    code: result.code,
    rows: decodeCliRows(result.stdout),
    stderr: result.stderr,
  };
}

async function runCliText(
  cwd: string,
  dbPath: string,
  ...args: string[]
): Promise<TextRunResult> {
  const result = await execBun(["run", cliEntrypoint, ...args], {
    cwd,
    env: { ...process.env, MACHINE_MEMORY_DB_PATH: dbPath },
  });
  return {
    code: isKnownBunCanaryExit(result) ? 0 : result.code,
    stdout: result.stdout,
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

beforeAll(async () => {
  tokenizerServer = createServer((request, response) => {
    const url = request.url ?? "";
    if (url.endsWith("/tokenizer.json")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(tokenizerJson));
      return;
    }
    if (url.endsWith("/tokenizer_config.json")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(tokenizerConfig));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolvePromise) =>
    tokenizerServer.listen(0, "127.0.0.1", resolvePromise),
  );
  const address = tokenizerServer.address();
  const port =
    address === null || Schema.is(Schema.String)(address) ? 0 : address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  tokenizerEnv = {
    MACHINE_MEMORY_BGE_TOKENIZER_URL: `${baseUrl}/tokenizer.json`,
    MACHINE_MEMORY_BGE_TOKENIZER_CONFIG_URL: `${baseUrl}/tokenizer_config.json`,
  };
});

afterAll(async () => {
  await new Promise<void>((resolvePromise, rejectPromise) =>
    tokenizerServer.close((error) =>
      error ? rejectPromise(error) : resolvePromise(),
    ),
  );
});

describe("CLI integration", () => {
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
      "--evidence",
      "observed_implementation",
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

    const explicitlyLocal = await runCli(
      cwd,
      dbPath,
      "list",
      "--local",
      "--json-min",
    );
    expect(explicitlyLocal.code).toBe(0);
    expect(explicitlyLocal.json.ids).toContain(id);

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
    expect(updated.json.update_count).toBe(1);

    const fetched = await runCli(cwd, dbPath, "get", String(id));
    expect(fetched.json.content).toBe("Use Effect for all CLI effects");
    expect(fetched.json.last_updated_by).toBe("integration-test");
    expect(fetched.json.repository).toBe("jfalava/machine-memory");

    const deprecated = await runCli(cwd, dbPath, "deprecate", String(id));
    expect(deprecated.code).toBe(0);
    expect(deprecated.json.status).toBe("deprecated");
  });

  it("renders pretty output globally while preserving explicit JSON modes", async () => {
    const { cwd, dbPath } = await createProject();
    const help = await runCliText(cwd, dbPath, "--pretty", "help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Commands");
    expect(help.stdout).toContain("Global options");
    expect(help.stdout).not.toContain("COMMAND");

    const added = await runCliText(
      cwd,
      dbPath,
      "add",
      "Pretty output keeps humans comfortable",
      "--local",
      "--pretty",
    );
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("Add");
    expect(added.stdout).toContain("Pretty output keeps humans comfortable");
    expect(added.stdout.trimStart()).not.toMatch(/^\{/);

    const queried = await runCliText(
      cwd,
      dbPath,
      "--pretty",
      "query",
      "comfortable",
      "--local",
    );
    expect(queried.code).toBe(0);
    expect(queried.stdout).toContain("Search results");
    expect(queried.stdout).toContain("Pretty output keeps humans");
    expect(queried.stdout).toContain("comfortable");
    expect(queried.stdout.trimStart()).not.toMatch(/^\{/);

    const machine = await runCliText(
      cwd,
      dbPath,
      "query",
      "comfortable",
      "--local",
      "--pretty",
      "--json-min",
    );
    expect(machine.code).toBe(0);
    expect(decodeCliOutput(machine.stdout.trim()).ids).toEqual([1]);
  });

  it("deletes a memory when given an explicit backend flag", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "Memory to delete",
      "--local",
      "--quiet",
    );
    expect(added.code).toBe(0);
    const id = Number(added.json.id);

    const deleted = await runCli(cwd, dbPath, "delete", String(id), "--local");
    expect(deleted.code, deleted.stderr).toBe(0);
    expect(deleted.json).toEqual({ deleted: id });

    const fetched = await runCli(cwd, dbPath, "get", String(id), "--local");
    expect(fetched.json).toEqual({ error: "Not found" });
  });

  it("isolates records from other repositories in a shared database", async () => {
    const { cwd, dbPath } = await createProject();
    const local = await runCli(
      cwd,
      dbPath,
      "add",
      "Current repository memory",
      "--quiet",
    );
    const foreignId = await insertMemoryFromRepository(
      dbPath,
      "someone/another-repository",
      "Foreign repository memory",
    );

    const queried = await runCli(
      cwd,
      dbPath,
      "query",
      "repository",
      "--json-min",
    );
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
    expect(
      migrated.code,
      `${migrated.stderr} ${JSON.stringify(migrated.json)}`,
    ).toBe(0);
    expect(migrated.json).toEqual({ status: "ok", migrated: true });

    const fetched = await runCli(cwd, dbPath, "get", "1");
    expect(fetched.json.certainty).toBe("verified");
    expect(fetched.json.memory_type).toBe("convention");
    expect(fetched.json.repository).toBe("jfalava/machine-memory");
  });

  it("recovers overwritten content and refs through history with a required concurrency guard", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "Original decision",
      "--type",
      "decision",
      "--refs",
      "docs/a.md,docs/b.md",
      "--tags",
      "original",
      "--quiet",
    );
    const id = String(added.json.id);
    await runCli(
      cwd,
      dbPath,
      "update",
      id,
      "Wrong overwrite",
      "--tags",
      "wrong",
      "--refs",
      "docs/wrong.md",
    );
    const history = await runCli(cwd, dbPath, "history", id, "--limit", "1");
    expect(history.code).toBe(0);
    expect(history.json).toMatchObject({
      current_update_count: 1,
      total_count: 1,
    });
    const snapshots = history.json.results ?? [];
    expect(snapshots[0]).toMatchObject({
      content: "Original decision",
      refs: ["docs/a.md", "docs/b.md"],
      tags: "original",
    });
    const revision = String(snapshots[0]!.revision_id);
    const missingGuard = await runCli(
      cwd,
      dbPath,
      "restore",
      id,
      "--revision",
      revision,
    );
    expect(missingGuard.code).toBe(1);
    const restored = await runCli(
      cwd,
      dbPath,
      "restore",
      id,
      "--revision",
      revision,
      "--expected-update-count",
      "1",
    );
    expect(restored.code, JSON.stringify(restored.json)).toBe(0);
    expect(restored.json.memory).toMatchObject({
      id: Number(id),
      content: "Original decision",
      refs: ["docs/a.md", "docs/b.md"],
      tags: "original",
      update_count: 2,
      last_updated_by: "restore",
    });
    const stale = await runCli(
      cwd,
      dbPath,
      "restore",
      id,
      "--revision",
      revision,
      "--expected-update-count",
      "1",
    );
    expect(stale.code).toBe(1);
    expect(stale.json.error).toContain("concurrently");
    const after = await runCli(cwd, dbPath, "history", id, "--limit", "1");
    expect(after.json).toMatchObject({ total_count: 2, has_more: true });
    expect(after.json.results?.[0]?.content).toBe("Wrong overwrite");
    await runCli(cwd, dbPath, "delete", id);
    expect((await runCli(cwd, dbPath, "history", id)).json.total_count).toBe(0);
  });

  it("requires evidence for verified claims and keeps evidence through updates and restore", async () => {
    const { cwd, dbPath } = await createProject();
    const bare = await runCliText(
      cwd,
      dbPath,
      "add",
      "Shortcuts only fire in focused forms",
      "--certainty",
      "verified",
      "--local",
    );
    expect(bare.code).not.toBe(0);
    expect(`${bare.stdout}${bare.stderr}`).toContain(
      "requires at least one evidence kind",
    );

    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "Shortcuts only fire in focused forms",
      "--certainty",
      "verified",
      "--evidence",
      "observed_implementation",
      "--validation-gaps",
      '["User intent unconfirmed","Safari and Windows not tested"]',
      "--quiet",
    );
    expect(added.code).toBe(0);
    const id = String(added.json.id);
    expect((await runCli(cwd, dbPath, "get", id)).json).toMatchObject({
      certainty: "verified",
      evidence: ["observed_implementation"],
      validation_gaps: [
        "User intent unconfirmed",
        "Safari and Windows not tested",
      ],
    });

    const unknownKind = await runCliText(
      cwd,
      dbPath,
      "update",
      id,
      "Shortcuts only fire in focused forms",
      "--evidence",
      "looks_right",
      "--local",
    );
    expect(unknownKind.code).not.toBe(0);
    const cleared = await runCliText(
      cwd,
      dbPath,
      "update",
      id,
      "Shortcuts only fire in focused forms",
      "--evidence",
      "none",
      "--local",
    );
    expect(cleared.code).not.toBe(0);

    // Content-only edits keep evidence; omitted flags change nothing.
    expect(
      (
        await runCli(
          cwd,
          dbPath,
          "update",
          id,
          "Shortcuts fire in focused forms",
        )
      ).code,
    ).toBe(0);
    const tested = await runCli(
      cwd,
      dbPath,
      "update",
      id,
      "Shortcuts fire in focused forms on macOS",
      "--evidence",
      "observed_implementation,tested_behavior",
      "--validation-gaps",
      "Windows not tested",
    );
    expect(tested.json).toMatchObject({
      evidence: ["observed_implementation", "tested_behavior"],
      validation_gaps: ["Windows not tested"],
    });

    const history = await runCli(cwd, dbPath, "history", id, "--limit", "1");
    const latest = history.json.results?.[0];
    expect(latest).toMatchObject({ evidence: ["observed_implementation"] });
    const restored = await runCli(
      cwd,
      dbPath,
      "restore",
      id,
      "--revision",
      String(latest?.revision_id),
      "--expected-update-count",
      String(history.json.current_update_count),
    );
    expect(restored.json.memory).toMatchObject({
      content: "Shortcuts fire in focused forms",
      evidence: ["observed_implementation"],
      validation_gaps: [
        "User intent unconfirmed",
        "Safari and Windows not tested",
      ],
    });

    const brief = await runCliText(
      cwd,
      dbPath,
      "get",
      id,
      "--brief",
      "--local",
    );
    expect(brief.stdout).toContain(
      "<verified> <evidence:observed_implementation> <gaps:2>",
    );
  });

  it("flags legacy verified records without evidence in doctor", async () => {
    const { cwd, dbPath } = await createProject();
    await runCli(cwd, dbPath, "add", "Legacy verified claim", "--quiet");
    const legacy = await execBun(
      [
        "-e",
        `import { Database } from "bun:sqlite";
const db = new Database(process.env.MACHINE_MEMORY_DB_PATH); db.exec("UPDATE memories SET certainty = 'verified'"); db.close();`,
      ],
      { env: { ...process.env, MACHINE_MEMORY_DB_PATH: dbPath } },
    );
    expect(legacy.code).toBe(0);
    // Editing content does not re-assert certainty, so legacy rows stay writable.
    expect(
      (
        await runCli(
          cwd,
          dbPath,
          "update",
          "1",
          "Legacy verified claim, edited",
        )
      ).code,
    ).toBe(0);
    const doctor = await runCli(cwd, dbPath, "doctor");
    expect(doctor.json.summary).toMatchObject({ verified_without_evidence: 1 });
    expect(doctor.json.findings?.verified_without_evidence).toEqual([
      expect.objectContaining({ id: 1 }),
    ]);
  });

  it("reports dropped details and records that rely on a changed or retired premise", async () => {
    const { cwd, dbPath } = await createProject();
    const premise = await runCli(
      cwd,
      dbPath,
      "add",
      "Keep nixpkgs-security pinned in flake.nix. Home Manager reimports nixpkgs.",
      "--type",
      "decision",
      "--quiet",
    );
    const dependent = await runCli(
      cwd,
      dbPath,
      "add",
      "Security updates wait for nixpkgs-security bumps before switching.",
      "--type",
      "convention",
      "--quiet",
    );
    await runCli(
      cwd,
      dbPath,
      "add",
      "Docs sidebar lists install first",
      "--quiet",
    );
    const premiseId = String(premise.json.id);
    const dependentId = Number(dependent.json.id);

    const diff = await runCli(
      cwd,
      dbPath,
      "diff",
      premiseId,
      "Home Manager reimports nixpkgs.",
    );
    expect(diff.json.dropped).toEqual({
      identifiers: ["nixpkgs-security", "flake.nix"],
      sentences: ["Keep nixpkgs-security pinned in flake.nix."],
    });
    const dryRun = await runCli(
      cwd,
      dbPath,
      "update",
      premiseId,
      "Home Manager reimports nixpkgs.",
      "--dry-run",
    );
    expect(dryRun.json.targets?.[0]?.dropped).toMatchObject({
      identifiers: ["nixpkgs-security", "flake.nix"],
    });

    const updated = await runCli(
      cwd,
      dbPath,
      "update",
      premiseId,
      "nixpkgs-security was removed from flake.nix; Home Manager reimports nixpkgs.",
      "--json-min",
    );
    // The rewrite keeps the identifiers and most terms, so nothing is dropped.
    expect(updated.json).toEqual({
      id: Number(premiseId),
      review_candidate_ids: [dependentId],
    });

    const deprecated = await runCli(cwd, dbPath, "deprecate", premiseId);
    expect(deprecated.json.review_candidates).toEqual([
      expect.objectContaining({ id: dependentId, match_strength: "strong" }),
    ]);
  });

  it("flags overlapping gotchas in doctor", async () => {
    const { cwd, dbPath } = await createProject();
    for (const content of [
      "alchemy@2.0.0-beta.83 polls Durable Objects; patch lib/cloudflare/worker.js.",
      "alchemy@2.0.0-beta.83 precreate needs the lib/cloudflare/worker.js patch.",
    ]) {
      await runCli(cwd, dbPath, "add", content, "--type", "gotcha", "--quiet");
    }
    const doctor = await runCli(cwd, dbPath, "doctor");
    expect(doctor.json.summary).toMatchObject({ gotcha_overlaps: 1 });
    expect(doctor.json.findings?.gotcha_overlaps).toEqual([
      expect.objectContaining({
        ids: [1, 2],
        shared_identifiers: [
          "alchemy@2.0.0-beta.83",
          "lib/cloudflare/worker.js",
        ],
      }),
    ]);
  });

  it("prints focused help for one command and the full catalog for help", async () => {
    const { cwd, dbPath } = await createProject();
    const focused = await runCliText(cwd, dbPath, "update", "--help");
    const payload = decodeCliOutput(focused.stdout);
    expect(Object.keys(payload.commands ?? {})).toEqual(["update"]);
    expect(Object.keys(payload.output_fields ?? {})).toContain("dropped");
    expect(payload.full_help).toBe("machine-memory help");
    const viaHelp = await runCli(cwd, dbPath, "help", "checkpoint");
    expect(Object.keys(viaHelp.json.commands ?? {})).toEqual(["checkpoint"]);
    const full = await runCli(cwd, dbPath, "help");
    expect(Object.keys(full.json.commands ?? {}).length).toBeGreaterThan(20);
  });

  it("targets another repository with --repo and refuses unknown ones on add", async () => {
    const { cwd, dbPath } = await createProject();
    await runCli(cwd, dbPath, "add", "Local repository memory", "--quiet");
    const refused = await runCli(
      cwd,
      dbPath,
      "add",
      "Other repository memory",
      "--repo",
      "jfalava/outfit",
    );
    expect(refused.code).not.toBe(0);
    expect(String(refused.json.error)).toContain("--allow-new-repo");
    const created = await runCli(
      cwd,
      dbPath,
      "--repo",
      "jfalava/outfit",
      "add",
      "Other repository memory",
      "--allow-new-repo",
      "--local",
      "--quiet",
    );
    expect(created.code).toBe(0);
    const other = await runCliRows(
      cwd,
      dbPath,
      "list",
      "--repo=jfalava/outfit",
      "--local",
    );
    expect(other.rows.map((row) => row.content)).toEqual([
      "Other repository memory",
    ]);
    const own = await runCliRows(cwd, dbPath, "list");
    expect(own.rows.map((row) => row.content)).toEqual([
      "Local repository memory",
    ]);
    const invalid = await runCli(cwd, dbPath, "list", "--repo", "outfit");
    expect(invalid.code).not.toBe(0);
    expect(String(invalid.json.error)).toContain("owner/name");
  });

  it("summarizes recent writes, related memories, and the classification in checkpoint", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "cli/src/db.ts applies evidence triggers on every migrate",
      "--type",
      "reference",
      "--certainty",
      "verified",
      "--evidence",
      "tested_behavior",
      "--validation-gaps",
      "D1 untested",
      "--quiet",
    );
    const id = Number(added.json.id);
    await runCli(
      cwd,
      dbPath,
      "add",
      "Release in progress",
      "--type",
      "status",
      "--quiet",
    );
    const checkpoint = await runCli(
      cwd,
      dbPath,
      "checkpoint",
      "--files",
      "cli/src/db.ts",
      "--json-min",
    );
    expect(checkpoint.json.files).toEqual(["cli/src/db.ts"]);
    expect(checkpoint.json.recent?.map((row) => row.id)).toEqual([2, id]);
    expect(checkpoint.json.related).toEqual([
      expect.objectContaining({ id, match_strength: "strong" }),
    ]);
    expect(checkpoint.json.review).toMatchObject({
      status_without_expiry: [2],
      verified_with_gaps: [id],
      strong_related: [id],
    });
    expect(checkpoint.json.classification?.map((entry) => entry.group)).toEqual(
      [
        "already_covered",
        "new_durable_knowledge",
        "superseded_or_conflicting",
        "transient_status",
        "intentionally_omitted",
      ],
    );
    const quiet = await runCli(cwd, dbPath, "checkpoint", "--quiet");
    expect(quiet.json.recent_ids).toEqual([2, id]);
  });

  it("upgrades a v3 database without backfill and can rerun migration without losing history", async () => {
    const { cwd, dbPath } = await createProject();
    await runCli(cwd, dbPath, "add", "Retained v3 memory", "--quiet");
    const downgrade = await execBun(
      [
        "-e",
        `import { Database } from "bun:sqlite";
const db = new Database(process.env.MACHINE_MEMORY_DB_PATH);
db.exec("DROP TRIGGER memory_history_after_update; DROP TRIGGER memory_history_after_delete; DROP TABLE memory_history; PRAGMA user_version = 3;"); db.close();`,
      ],
      { env: { ...process.env, MACHINE_MEMORY_DB_PATH: dbPath } },
    );
    expect(downgrade.code).toBe(0);
    expect((await runCli(cwd, dbPath, "migrate")).code).toBe(0);
    expect((await runCli(cwd, dbPath, "history", "1")).json.total_count).toBe(
      0,
    );
    await runCli(cwd, dbPath, "update", "1", "After upgrade");
    const markOutdated = await execBun(
      [
        "-e",
        `import { Database } from "bun:sqlite";
const db = new Database(process.env.MACHINE_MEMORY_DB_PATH); db.exec("PRAGMA user_version = 3;"); db.close();`,
      ],
      { env: { ...process.env, MACHINE_MEMORY_DB_PATH: dbPath } },
    );
    expect(markOutdated.code).toBe(0);
    expect((await runCli(cwd, dbPath, "migrate")).code).toBe(0);
    const history = await runCli(cwd, dbPath, "history", "1");
    expect(history.json.total_count).toBe(1);
    expect(history.json.results?.[0]?.content).toBe("Retained v3 memory");
    expect((await runCli(cwd, dbPath, "get", "1")).json.content).toBe(
      "After upgrade",
    );
  });

  it("exports a selected local database through the raw TypeScript CLI", async () => {
    const { cwd, dbPath } = await createProject();
    await writeFile(
      join(cwd, "AGENTS.md"),
      "# Project instructions\n\n<!-- machine-memory:start -->\nlocal instructions\n<!-- machine-memory:end -->\n",
    );
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "A selected SQLite file can be exported remotely",
      "--type",
      "decision",
      "--certainty",
      "verified",
      "--evidence",
      "observed_implementation",
      "--local",
      "--quiet",
    );
    expect(added.code).toBe(0);

    const requests: {
      path: string;
      body: typeof MigrationRequestInputSchema.Type;
    }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Schema.decodeSync(
          Schema.fromJsonString(MigrationRequestInputSchema),
        )(Buffer.concat(chunks).toString());
        requests.push({ path: request.url ?? "", body });
        response.setHeader("content-type", "application/json");
        if (request.url === "/migrate") {
          const rows = body.rows;
          response.end(
            JSON.stringify({
              ok: true,
              result: {
                processed: rows.length,
                inserted: rows.length,
                duplicates: 0,
                items: rows.map((row) => ({
                  source_id: row.source_id,
                  target_id: row.source_id + 100,
                  status: "inserted",
                })),
              },
            }),
          );
          return;
        }
        if (request.url === "/migrate/links") {
          response.end(JSON.stringify({ ok: true, result: { updated: 0 } }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ ok: false, error: "not found" }));
      });
    });
    await new Promise<void>((resolveServer, rejectServer) => {
      server.once("error", rejectServer);
      server.listen(0, "127.0.0.1", () => resolveServer());
    });
    const address = server.address();
    if (address === null || Schema.is(Schema.String)(address)) {
      throw new Error("The migration test server did not expose a port.");
    }

    try {
      const result = await execBun(
        [
          "run",
          cliEntrypoint,
          "local",
          "export",
          dbPath,
          "--source-id",
          "stable-backup",
          "--remote",
        ],
        {
          cwd,
          env: {
            ...process.env,
            MACHINE_MEMORY_DB_PATH: dbPath,
            MACHINE_MEMORY_DB_URL: `http://127.0.0.1:${address.port}/query`,
            MACHINE_MEMORY_DB_TOKEN: "test-token",
          },
        },
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Local export completed");
      expect(result.stdout).toContain("Inserted");
      expect(requests.map((request) => request.path)).toEqual(["/migrate"]);
      expect(requests[0]?.body.repository).toBe("jfalava/machine-memory");
      expect(requests[0]?.body.source).toBe("stable-backup");
      expect(requests[0]?.body.rows[0]?.content).toBe(
        "A selected SQLite file can be exported remotely",
      );
      const agentsMd = await readFile(join(cwd, "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("# Project instructions");
      expect(agentsMd).toContain(
        "Every database-backed command requires exactly one backend flag: use `--remote` for this repository.",
      );
      expect(agentsMd).not.toContain(
        "For this one use `--local` for this repository.",
      );
    } finally {
      await new Promise<void>((resolveServer, rejectServer) =>
        server.close((error) =>
          error ? rejectServer(error) : resolveServer(),
        ),
      );
    }
  });

  it("attaches an embedding token breakdown with --token-report", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "hello",
      "--tags",
      "cli",
      "--token-report",
      "--quiet",
    );
    expect(added.code).toBe(0);
    const tokens = added.json.tokens;
    expect(tokens).toBeDefined();
    expect(tokens?.source).toBe("tokenizer");
    expect(tokens?.within_limit).toBe(true);
    expect(tokens?.over_by).toBe(0);
    expect(Number(tokens?.total_tokens)).toBeGreaterThan(0);
    const parts = tokens?.parts ?? [];
    expect(parts.map((entry) => entry.part)).toEqual(
      expect.arrayContaining(["content", "memory_type", "status", "certainty"]),
    );
  });

  it("rejects an oversized add before writing and reports the breakdown", async () => {
    const { cwd, dbPath } = await createProject();
    const addResult = await runCli(
      cwd,
      dbPath,
      "add",
      Array.from({ length: 600 }, () => "hello").join(" "),
      "--local",
    );
    expect(addResult.code).toBe(1);
    const error = String(addResult.json.error ?? "");
    expect(error).toContain("embedding tokens");
    expect(error).toContain("byte estimate");
    expect(error).toContain("Both limits bind");
    expect(error).toContain("content: 602 tokens");
    expect(error).toMatch(/over the 512-byte embedding estimate by \d+ bytes/);

    const fetched = await runCli(cwd, dbPath, "get", "1", "--local");
    expect(fetched.json).toEqual({ error: "Not found" });
  });

  it("validates retained metadata before updating an upsert match", async () => {
    const { cwd, dbPath } = await createProject();
    const original = Array.from({ length: 10 }, () => "alpha beta gamma").join(
      " ",
    );
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      original,
      "--context",
      original,
      "--type",
      "decision",
      "--certainty",
      "verified",
      "--evidence",
      "observed_implementation",
      "--quiet",
    );
    expect(added.code).toBe(0);
    const id = Number(added.json.id);

    const upserted = await runCli(
      cwd,
      dbPath,
      "add",
      Array.from({ length: 20 }, () => "alpha beta gamma").join(" "),
      "--upsert-match",
      "alpha beta gamma",
      "--token-report",
      "--quiet",
    );
    expect(upserted.code).toBe(1);
    expect(String(upserted.json.error ?? "")).toContain(`Memory ${id}`);
    expect(String(upserted.json.error ?? "")).toContain("byte estimate");

    const fetched = await runCli(cwd, dbPath, "get", String(id), "--local");
    expect(fetched.json.content).toBe(original);
    expect(fetched.json.context).toBe(original);
  });

  it("rejects an oversized update and leaves the memory unchanged", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "original content",
      "--local",
      "--quiet",
    );
    expect(added.code).toBe(0);
    const id = Number(added.json.id);

    const updated = await runCli(
      cwd,
      dbPath,
      "update",
      String(id),
      Array.from({ length: 600 }, () => "hello").join(" "),
      "--local",
    );
    expect(updated.code).toBe(1);
    expect(String(updated.json.error ?? "")).toContain(`Memory ${id}`);
    expect(String(updated.json.error ?? "")).toContain("byte estimate");
    expect(String(updated.json.error ?? "")).toContain("Both limits bind");

    const fetched = await runCli(cwd, dbPath, "get", String(id), "--local");
    expect(fetched.json.content).toBe("original content");
  });

  it("attaches token breakdowns to a successful update with --token-report", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "original content",
      "--local",
      "--quiet",
    );
    expect(added.code).toBe(0);
    const id = Number(added.json.id);

    const updated = await runCli(
      cwd,
      dbPath,
      "update",
      String(id),
      "replacement content",
      "--token-report",
      "--local",
    );
    expect(updated.code).toBe(0);
    expect(updated.json.content).toBe("replacement content");
    expect(updated.json.tokens).toMatchObject({
      source: "tokenizer",
      within_limit: true,
    });
  });

  it("preflights the embedding budget with the size command", async () => {
    const { cwd, dbPath } = await createProject();
    const within = await runCli(cwd, dbPath, "size", "hello world");
    expect(within.code).toBe(0);
    expect(within.json.within_budget).toBe(true);
    expect(within.json.binding_limit).toBeNull();
    const limits = within.json.limits;
    expect(limits?.tokens?.pass).toBe(true);
    expect(limits?.bytes_estimate?.pass).toBe(true);

    // --remote is accepted as a no-op for the non-database size command.
    const withRemote = await runCli(
      cwd,
      dbPath,
      "size",
      "hello world",
      "--remote",
    );
    expect(withRemote.code).toBe(0);

    const over = await runCli(cwd, dbPath, "size", "é".repeat(400));
    expect(over.code).toBe(1);
    expect(over.json.within_budget).toBe(false);
    expect(over.json.binding_limit).toBe("bytes");
    expect(over.json.over_by_bytes).toBeGreaterThan(0);
    expect(String(over.json.limits?.tokens?.pass)).toBe("true");
  });

  it("reports the add size with --dry-run without writing", async () => {
    const { cwd, dbPath } = await createProject();
    const dry = await runCli(
      cwd,
      dbPath,
      "add",
      Array.from({ length: 600 }, () => "hello").join(" "),
      "--dry-run",
      "--local",
    );
    expect(dry.code).toBe(1);
    expect(dry.json.command).toBe("add");
    expect(dry.json.dry_run).toBe(true);
    expect(dry.json.action).toBe("create");
    const size = dry.json.size;
    expect(size?.within_budget).toBe(false);
    expect(size?.trimmed_suggestion).toMatch(
      /truncating content to ~\d+ bytes/,
    );

    const fetched = await runCli(cwd, dbPath, "get", "1", "--local");
    expect(fetched.json).toEqual({ error: "Not found" });
  });

  it("reports the update size per target with --dry-run without writing", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "original content",
      "--quiet",
      "--local",
    );
    const id = Number(added.json.id);

    const dry = await runCli(
      cwd,
      dbPath,
      "update",
      String(id),
      "é".repeat(400),
      "--dry-run",
      "--local",
    );
    expect(dry.code).toBe(1);
    expect(dry.json.command).toBe("update");
    expect(dry.json.dry_run).toBe(true);
    expect(dry.json.count).toBe(1);
    const targets = dry.json.targets ?? [];
    expect(targets[0]?.id).toBe(id);
    expect(targets[0]?.size?.binding_limit).toBe("bytes");

    const okDry = await runCli(
      cwd,
      dbPath,
      "update",
      `${id},${id + 1}`,
      "small content",
      "--dry-run",
      "--local",
    );
    // Missing ids are filtered before measurement; the found target fits.
    expect(okDry.code).toBe(0);
    expect(okDry.json.count).toBe(1);
    const fetched = await runCli(cwd, dbPath, "get", String(id), "--local");
    expect(fetched.json.content).toBe("original content");
  });

  it("shows the upsert candidate with add --upsert-match --dry-run", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "alpha beta gamma delta epsilon zeta",
      "--quiet",
      "--local",
    );
    const existingId = Number(added.json.id);

    // Identical content resolves to a strong match -> action "update".
    const strong = await runCli(
      cwd,
      dbPath,
      "add",
      "alpha beta gamma delta epsilon zeta",
      "--upsert-match",
      "alpha beta gamma",
      "--dry-run",
      "--local",
    );
    expect(strong.code).toBe(0);
    expect(strong.json.action).toBe("update");
    expect(strong.json.would_match?.id).toBe(existingId);
    expect(String(strong.json.would_match?.content_head)).toContain(
      "alpha beta gamma",
    );
    expect(strong.json.size?.within_budget).toBe(true);

    // A weak match would NOT be updated; the write path creates a new record.
    const weak = await runCli(
      cwd,
      dbPath,
      "add",
      "unrelated omega psi quantum flux capacitor notes",
      "--upsert-match",
      "alpha beta gamma",
      "--dry-run",
      "--local",
    );
    expect(weak.code).toBe(0);
    expect(weak.json.action).toBe("create");
    expect(weak.json.would_match?.id).toBe(existingId);
    expect(String(weak.json.note)).toContain("not a strong upsert match");

    const fetched = await runCli(
      cwd,
      dbPath,
      "get",
      String(existingId),
      "--local",
    );
    expect(fetched.json.update_count).toBe(0);
  });

  it("gates weak upsert matches behind --force", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "alpha beta gamma delta epsilon zeta",
      "--quiet",
      "--local",
    );
    const existingId = Number(added.json.id);

    const blocked = await runCli(
      cwd,
      dbPath,
      "add",
      "unrelated omega psi quantum flux capacitor notes",
      "--upsert-match",
      "alpha beta gamma",
      "--local",
    );
    expect(blocked.code).toBe(1);
    expect(String(blocked.json.error)).toContain("not a strong upsert match");

    // Still just one record after the blocked attempt.
    const afterBlock = await runCli(
      cwd,
      dbPath,
      "list",
      "--json-min",
      "--local",
    );
    expect(afterBlock.json.count).toBe(1);

    const forced = await runCli(
      cwd,
      dbPath,
      "add",
      "unrelated omega psi quantum flux capacitor notes",
      "--upsert-match",
      "alpha beta gamma",
      "--force",
      "--local",
    );
    expect(forced.code).toBe(0);
    expect(forced.json.mode).toBe("created");
    const newId = Number(forced.json.id);
    expect(newId).not.toBe(existingId);
    expect(forced.json.upsert_match?.id).toBe(existingId);

    const lowered = await runCli(
      cwd,
      dbPath,
      "add",
      "another distinct record about rust build caches",
      "--upsert-match",
      "alpha beta gamma",
      "--upsert-threshold",
      "0.000001",
      "--local",
    );
    expect(lowered.code).toBe(1); // similarity floor still applies
  });

  it("supports get --json-min, get --brief and get --quiet", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "parity check memory for get output modes",
      "--tags",
      "area:cli,kind:test",
      "--type",
      "reference",
      "--certainty",
      "verified",
      "--evidence",
      "observed_implementation",
      "--quiet",
      "--local",
    );
    const id = Number(added.json.id);

    const jsonMin = await runCli(
      cwd,
      dbPath,
      "get",
      String(id),
      "--json-min",
      "--local",
    );
    expect(jsonMin.json.count).toBe(1);
    expect(jsonMin.json.ids).toEqual([id]);
    expect(jsonMin.json.results).toEqual([
      {
        id,
        memory_type: "reference",
        certainty: "verified",
        status: "active",
        tags: ["area:cli", "kind:test"],
        evidence: ["observed_implementation"],
      },
    ]);

    const quiet = await runCli(
      cwd,
      dbPath,
      "get",
      String(id),
      "--quiet",
      "--local",
    );
    expect(quiet.json).toEqual({ count: 1, ids: [id] });

    const brief = await runCliText(
      cwd,
      dbPath,
      "get",
      String(id),
      "--brief",
      "--local",
    );
    expect(brief.stdout).toContain(`[${id}]`);
    expect(brief.stdout).toContain(
      "<verified> <evidence:observed_implementation>",
    );
    expect(brief.stdout).toContain("#area:cli");
  });

  it("supports update --brief and deprecate --brief", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "original content",
      "--quiet",
      "--local",
    );
    const id = Number(added.json.id);

    const updated = await runCli(
      cwd,
      dbPath,
      "update",
      String(id),
      "replacement content",
      "--brief",
      "--local",
    );
    expect(updated.code).toBe(0);
    expect(updated.json).toMatchObject({ id, status: "updated" });

    const deprecated = await runCli(
      cwd,
      dbPath,
      "deprecate",
      String(id),
      "--brief",
      "--local",
    );
    expect(deprecated.code).toBe(0);
    expect(deprecated.json).toEqual({ id, status: "deprecated" });
  });
});

describe("audit write regressions", () => {
  it("imports rows without timestamps and preserves an independently supplied timestamp", async () => {
    const { cwd, dbPath } = await createProject();
    const file = join(cwd, "restore.json");
    await writeFile(
      file,
      JSON.stringify([
        {
          content: "first imported record",
          memory_type: "decision",
          refs: ["docs/first.md"],
        },
        {
          content: "second imported record",
          created_at: "2024-01-02 03:04:05",
        },
      ]),
    );
    const imported = await runCli(cwd, dbPath, "import", file, "--json-min");
    expect(imported.code, imported.stderr).toBe(0);
    expect(imported.json.imported).toBe(2);
    const results = imported.json.results ?? [];
    const first = await runCli(cwd, dbPath, "get", String(results[0]?.id));
    expect(first.json).toMatchObject({
      memory_type: "decision",
      refs: ["docs/first.md"],
    });
    expect(first.json.created_at).toEqual(expect.any(String));
    const second = await runCli(cwd, dbPath, "get", String(results[1]?.id));
    expect(second.json.created_at).toBe("2024-01-02 03:04:05");
    expect(second.json.updated_at).toEqual(expect.any(String));
  });

  it("remaps superseded_by source IDs instead of pointing at unrelated target IDs", async () => {
    const { cwd, dbPath } = await createProject();
    await runCli(
      cwd,
      dbPath,
      "add",
      "pre-existing unrelated memory",
      "--quiet",
    );
    const file = join(cwd, "restore.json");
    await writeFile(
      file,
      JSON.stringify([
        {
          id: 70,
          content: "obsolete convention",
          status: "superseded_by",
          superseded_by: 90,
        },
        { id: 90, content: "replacement convention", status: "active" },
      ]),
    );
    const imported = await runCli(cwd, dbPath, "import", file, "--json-min");
    expect(imported.code, imported.stderr).toBe(0);
    const results = imported.json.results ?? [];
    const old = await runCli(cwd, dbPath, "get", String(results[0]?.id));
    expect(old.json.superseded_by).toBe(results[1]?.id);
    expect(old.json.superseded_by).not.toBe(90);
    const replacement = await runCli(
      cwd,
      dbPath,
      "get",
      String(results[1]?.id),
    );
    expect(replacement.json.content).toBe("replacement convention");
  });

  it.each([
    { content: "x".repeat(600) },
    { refs: [1] },
    { expires_after_days: 3 },
  ])(
    "rejects an invalid final import row before inserting a valid first row: %j",
    async (bad) => {
      const { cwd, dbPath } = await createProject();
      const file = join(cwd, "restore.json");
      await writeFile(
        file,
        JSON.stringify([
          { content: "valid first row" },
          { content: "bad second row", ...bad },
        ]),
      );
      const imported = await runCli(cwd, dbPath, "import", file, "--json-min");
      expect(imported.code).toBe(1);
      expect(imported.json.imported).toBe(0);
      expect((await runCli(cwd, dbPath, "list", "--json-min")).json.count).toBe(
        0,
      );
    },
  );

  it("reports missing single mutations as failures", async () => {
    const { cwd, dbPath } = await createProject();
    await runCli(cwd, dbPath, "migrate");
    for (const args of [
      ["update", "99", "replacement"],
      ["deprecate", "99"],
      ["delete", "99"],
    ]) {
      const result = await runCli(cwd, dbPath, ...args, "--json-min");
      expect(result.code).toBe(1);
      expect(result.json.not_found).toEqual([99]);
      expect(result.json.status).not.toBe("updated");
    }
  });

  it("rejects match updates of deprecated memories and clears expiry on type conversion", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "temporary status needle",
      "--type",
      "status",
      "--expires-after-days",
      "4",
      "--quiet",
    );
    const id = Number(added.json.id);
    const converted = await runCli(
      cwd,
      dbPath,
      "update",
      String(id),
      "permanent decision needle",
      "--type",
      "decision",
      "--json-min",
    );
    expect(converted.code, converted.stderr).toBe(0);
    expect(
      (await runCli(cwd, dbPath, "get", String(id))).json.expires_after_days,
    ).toBeNull();
    await runCli(cwd, dbPath, "deprecate", String(id));
    const inactive = await runCli(
      cwd,
      dbPath,
      "update",
      "must not overwrite",
      "--match",
      "permanent decision needle",
      "--json-min",
      "--local",
    );
    expect(inactive.code).toBe(1);
    expect(inactive.json.error).toContain("No active memory matched");
    expect((await runCli(cwd, dbPath, "get", String(id))).json.content).toBe(
      "permanent decision needle",
    );
  });

  it("refuses source-mode self-upgrade before touching the runtime", async () => {
    const { cwd } = await createProject();
    const result = await execBun(["run", cliEntrypoint, "upgrade"], {
      cwd,
      env: {
        MACHINE_MEMORY_BIN_PATH: "",
        MACHINE_MEMORY_API_URL: "http://127.0.0.1:1",
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("compiled executable");
    expect(result.stderr).not.toContain("Failed to fetch");
  });

  it("refuses an explicitly named upgrade target that resolves to Bun", async () => {
    const { cwd } = await createProject();
    const runtime = await execBun(["-e", "console.log(process.execPath)"], {});
    const target = join(cwd, "machine-memory");
    await symlink(runtime.stdout.trim(), target);
    const result = await execBun(["run", cliEntrypoint, "upgrade"], {
      cwd,
      env: {
        MACHINE_MEMORY_BIN_PATH: target,
        MACHINE_MEMORY_API_URL: "http://127.0.0.1:1",
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing to replace");
    expect(result.stderr).not.toContain("Failed to fetch");
  });
});

describe("human command errors", () => {
  it("renders all human command argument errors as terminal text", async () => {
    const cases = [
      [["upgrade"], "✗ Upgrade failed"],
      [["init"], "✗ init failed"],
      [["remote", "setup"], "✗ remote setup failed"],
      [["remote", "provision"], "✗ remote provision failed"],
      [["local", "export"], "✗ local export failed"],
    ] as const;

    for (const [command, heading] of cases) {
      const result = await execBun(
        ["run", cliEntrypoint, ...command, "--bad"],
        {},
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        `Usage: machine-memory ${command.join(" ")}`,
      );
      expect(result.stdout).not.toContain('"error"');
      expect(result.stderr).toContain(heading);
      expect(result.stderr).not.toContain('{"error"');
      expect(result.stderr).not.toContain("Next:");
    }
  });

  it("prints runtime hints on stdout instead of a red Next line", async () => {
    const cases = [
      [
        ["init"],
        "Choose exactly one init target",
        "✗ init failed",
        "machine-memory init (--local|--remote|--mcp)",
      ],
      [
        ["local", "export"],
        "Choose a database backend explicitly",
        "✗ local export failed",
        "machine-memory local export [local-db-path] --remote",
      ],
    ] as const;

    for (const [args, message, heading, hint] of cases) {
      const result = await execBun(["run", cliEntrypoint, ...args], {});

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(heading);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain("Next:");
      expect(result.stderr).not.toContain("Hint");
      expect(result.stdout).toContain("Hint");
      expect(result.stdout).toContain(hint);
    }
  });
});
