import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  assetNameForPlatform,
  binaryNameForPlatform,
  extractZipBinary,
} from "@/upgrade";

const cliTokenizerJson = {
  version: "1.0",
  truncation: null,
  padding: null,
  added_tokens: [
    {
      id: 0,
      content: "[PAD]",
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    },
    {
      id: 1,
      content: "[UNK]",
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    },
    {
      id: 2,
      content: "[CLS]",
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    },
    {
      id: 3,
      content: "[SEP]",
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    },
  ],
  normalizer: {
    type: "BertNormalizer",
    clean_text: true,
    handle_chinese_chars: true,
    strip_accents: null,
    lowercase: true,
  },
  pre_tokenizer: { type: "BertPreTokenizer" },
  post_processor: {
    type: "BertProcessing",
    sep: ["[SEP]", 3],
    cls: ["[CLS]", 2],
  },
  decoder: { type: "WordPiece", prefix: "##", cleanup: true },
  model: {
    type: "WordPiece",
    unk_token: "[UNK]",
    continuing_subword_prefix: "##",
    max_input_chars_per_word: 100,
    vocab: { "[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3, hello: 4 },
  },
};

const cliTokenizerConfig = {
  model_max_length: 512,
  do_lower_case: true,
  cls_token: "[CLS]",
  sep_token: "[SEP]",
  unk_token: "[UNK]",
  pad_token: "[PAD]",
};

let tokenizerServer: Server;
let tokenizerEnv: Record<string, string> = {};

type RunResult = {
  code: number;
  json: Record<string, unknown>;
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
  "update",
  "deprecate",
  "delete",
  "suggest",
  "sweep",
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
        resolvePromise({
          code: numericCode,
          stdout,
          stderr:
            stderr ||
            (typeof processError?.message === "string"
              ? processError.message
              : ""),
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
    json: JSON.parse(result.stdout.trim()) as Record<string, unknown>,
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
      response.end(JSON.stringify(cliTokenizerJson));
      return;
    }
    if (url.endsWith("/tokenizer_config.json")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(cliTokenizerConfig));
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
    typeof address === "object" && address !== null ? address.port : 0;
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
    expect((updated.json as { update_count: number }).update_count).toBe(1);

    const fetched = await runCli(cwd, dbPath, "get", String(id));
    expect(fetched.json.content).toBe("Use Effect for all CLI effects");
    expect(fetched.json.last_updated_by).toBe("integration-test");
    expect(fetched.json.repository).toBe("jfalava/machine-memory");

    const deprecated = await runCli(cwd, dbPath, "deprecate", String(id));
    expect(deprecated.code).toBe(0);
    expect((deprecated.json as { status: string }).status).toBe("deprecated");
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
    expect(JSON.parse(machine.stdout.trim()).ids).toEqual([1]);
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
      "--local",
      "--quiet",
    );
    expect(added.code).toBe(0);

    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
          string,
          unknown
        >;
        requests.push({ path: request.url ?? "", body });
        response.setHeader("content-type", "application/json");
        if (request.url === "/migrate") {
          const rows = body.rows as { source_id: number }[];
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
    if (!address || typeof address === "string") {
      throw new Error("The migration test server did not expose a port.");
    }

    try {
      const result = await execBun(
        ["run", cliEntrypoint, "local", "export", dbPath, "--remote"],
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
      expect(
        (requests[0]?.body.rows as Record<string, unknown>[])[0]?.content,
      ).toBe("A selected SQLite file can be exported remotely");
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
    const tokens = added.json.tokens as Record<string, unknown>;
    expect(tokens).toBeDefined();
    expect(tokens.source).toBe("tokenizer");
    expect(tokens.within_limit).toBe(true);
    expect(tokens.over_by).toBe(0);
    expect(Number(tokens.total_tokens)).toBeGreaterThan(0);
    const parts = tokens.parts as Array<{ part: string; tokens: number }>;
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
    expect(error).toContain("Trim at least");
    expect(error).toContain("content: 602 tokens");

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
    expect(String(updated.json.error ?? "")).toContain("Trim at least");

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
});

describe("human command errors", () => {
  it("renders all human command argument errors as terminal text", async () => {
    const cases = [
      [
        ["upgrade", "--bad"],
        "Usage: machine-memory upgrade",
        "✗ Upgrade failed",
      ],
      [
        ["init", "--bad"],
        "Usage: machine-memory init (--local|--remote)",
        "✗ init failed",
      ],
      [
        ["remote", "setup", "--bad"],
        "Usage: machine-memory remote setup [--url <worker-url>] [--token <worker-token>]",
        "✗ remote setup failed",
      ],
      [
        ["remote", "provision", "--bad"],
        "Usage: machine-memory remote provision [--stack-name <name>] [--database-name <name>] [--api-name <name>]",
        "✗ remote provision failed",
      ],
    ] as const;

    for (const [args, usage, heading] of cases) {
      const result = await execBun(["run", cliEntrypoint, ...args], {});

      expect(result.code).toBe(1);
      expect(result.stdout).toContain(usage);
      expect(result.stdout).not.toContain('"error"');
      expect(result.stderr).toContain(heading);
      expect(result.stderr).not.toContain('{"error"');
    }
  });
});

describe("release platform selection", () => {
  it("selects the published asset for each supported target", () => {
    expect(assetNameForPlatform("darwin", "arm64")).toBe(
      "machine-memory-darwin-arm64.zip",
    );
    expect(assetNameForPlatform("linux", "x64")).toBe(
      "machine-memory-linux-x64.zip",
    );
    expect(assetNameForPlatform("win32", "x64")).toBe(
      "machine-memory-windows-x64.zip",
    );
    expect(assetNameForPlatform("freebsd", "x64")).toBeUndefined();
  });

  it("uses normalized executable names inside release archives", () => {
    expect(binaryNameForPlatform("darwin")).toBe("machine-memory");
    expect(binaryNameForPlatform("linux")).toBe("machine-memory");
    expect(binaryNameForPlatform("win32")).toBe("machine-memory.exe");
    expect(binaryNameForPlatform("freebsd")).toBeUndefined();
  });

  it("extracts the expected executable from a stored ZIP archive", () => {
    const name = new TextEncoder().encode("machine-memory-linux-x64");
    const contents = new TextEncoder().encode("binary");
    const local = new Uint8Array(30 + name.length + contents.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(18, contents.length, true);
    localView.setUint32(22, contents.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(contents, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(20, contents.length, true);
    centralView.setUint32(24, contents.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, 0, true);
    central.set(name, 46);

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, 1, true);
    endView.setUint16(10, 1, true);
    endView.setUint32(12, central.length, true);
    endView.setUint32(16, local.length, true);

    const archive = new Uint8Array(local.length + central.length + end.length);
    archive.set(local, 0);
    archive.set(central, local.length);
    archive.set(end, local.length + central.length);

    expect(extractZipBinary(archive, "machine-memory")).toEqual(contents);
    expect(extractZipBinary(archive, "machine-memory-linux-x64")).toEqual(
      contents,
    );
  });
});
