import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { MigrationRequestInputSchema } from "@machine-memory/contract";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  type CliOutput,
  type CliRow,
  decodeCliOutput,
} from "./fixtures/cli-output";

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
  env: Record<string, string> = {},
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
      env: { ...process.env, MACHINE_MEMORY_DB_PATH: dbPath, ...env },
    },
  );
  return {
    code: isKnownBunCanaryExit(result) ? 0 : result.code,
    stdout: result.stdout.trim(),
    stderr: result.stderr,
  };
}

/** Run the CLI as the agent `writer`, the way a harness's environment names it. */
async function runCliAs(
  project: { cwd: string; dbPath: string },
  writer: string,
  ...args: string[]
): Promise<RunResult> {
  const result = await runCliStdout(project.cwd, project.dbPath, args, {
    MACHINE_MEMORY_AGENT: writer,
  });
  return {
    code: result.code,
    json: decodeCliOutput(result.stdout),
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

/** A read, reduced to the `results` of its envelope. */
async function runCliRows(
  cwd: string,
  dbPath: string,
  ...args: string[]
): Promise<RowsRunResult> {
  const result = await runCli(cwd, dbPath, ...args);
  return {
    code: result.code,
    rows: [...(result.json.results ?? [])],
    stderr: result.stderr,
  };
}

/** `get <id>`: `json` is the one memory (empty when missing), `envelope` the whole output. */
async function getMemory(
  cwd: string,
  dbPath: string,
  id: string | number,
  ...flags: string[]
): Promise<RunResult & { envelope: CliOutput }> {
  const result = await runCli(cwd, dbPath, "get", String(id), ...flags);
  return {
    ...result,
    json: result.json.results?.[0] ?? {},
    envelope: result.json,
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

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** created_at and updated_at of the first memory, exactly as stored. */
async function storedTimestamps(dbPath: string): Promise<string[]> {
  const result = await execBun(
    [
      "-e",
      `import { Database } from "bun:sqlite";
const database = new Database(process.env.MACHINE_MEMORY_DB_PATH);
const row = database.query("SELECT created_at, updated_at FROM memories ORDER BY id LIMIT 1").get();
console.log(JSON.stringify([row.created_at, row.updated_at]));
database.close();`,
    ],
    {
      env: { ...process.env, MACHINE_MEMORY_DB_PATH: dbPath },
    },
  );
  expect(result.code === 0 || isKnownBunCanaryExit(result)).toBe(true);
  return [
    ...Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
      result.stdout.trim(),
    ),
  ];
}

afterEach(async () => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("CLI integration", () => {
  it("reads a flag value that looks like a flag as a value, not a flag", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "Deploy uses bun",
      "--context=--quiet",
    );
    expect(added.code).toBe(0);
    // --quiet would print only { id }; the full row proves it stayed a value.
    expect(added.json).toMatchObject({
      content: "Deploy uses bun",
      context: "--quiet",
    });
  });

  it("prints the same envelope from every read command in every output mode", async () => {
    const { cwd, dbPath } = await createProject();
    for (const content of [
      "Deploy runs src/deploy.ts",
      "Deploy needs a token",
    ]) {
      await runCli(
        cwd,
        dbPath,
        "add",
        content,
        "--tags",
        "area:ops",
        "--quiet",
      );
    }
    const reads = [
      ["get", "1"],
      ["get", "1,2"],
      ["query", "deploy"],
      ["list"],
      ["suggest", "--files", "src/deploy.ts"],
      ["sweep", "--files", "src/deploy.ts", "--query", "deploy"],
      ["export"],
    ];
    const modes = [[], ["--json-min"], ["--quiet"]];
    // Reads do not write, so the 21 processes can share the database.
    const observed = await Promise.all(
      reads.flatMap((read) =>
        modes.map(async (mode) => {
          const printed = await runCliStdout(cwd, dbPath, [...read, ...mode]);
          const json = decodeCliOutput(printed.stdout);
          const results = json.results ?? [];
          const keys = Object.keys(results[0] ?? {});
          return {
            command: [...read, ...mode].join(" "),
            // Read from the printed text: decoding reorders keys.
            first_key: /^\{"([^"]+)"/.exec(printed.stdout)?.[1],
            count: json["count"],
            results: results.length,
            has_ids: "ids" in json,
            only_id: keys.join(",") === "id",
            bookkeeping: keys.includes("created_at"),
            content: keys.includes("content"),
          };
        }),
      ),
    );
    const expected = reads.flatMap((read) =>
      modes.map((mode) => {
        const count = read.join(" ") === "get 1" ? 1 : 2;
        const full = mode.length === 0;
        return {
          command: [...read, ...mode].join(" "),
          first_key: "repository",
          count,
          results: count,
          has_ids: false,
          only_id: mode[0] === "--quiet",
          // Summaries drop bookkeeping columns, and carry content only from get.
          bookkeeping: full,
          content: full || (mode[0] === "--json-min" && read[0] === "get"),
        };
      }),
    );
    expect(observed).toEqual(expected);
  });

  it("keeps the envelope when a read finds nothing", async () => {
    const { cwd, dbPath } = await createProject();
    await runCli(cwd, dbPath, "add", "Deploy runs bun", "--quiet");
    for (const read of [
      ["get", "99"],
      ["query", "zzzunmatched"],
      ["list", "--tags", "area:none"],
      ["export", "--tags", "area:none"],
    ]) {
      const output = await runCli(cwd, dbPath, ...read, "--json-min");
      expect([
        read[0],
        output.code,
        output.json["count"],
        output.json.results,
      ]).toEqual([read[0], 0, 0, []]);
    }
    const missing = await runCli(cwd, dbPath, "get", "1,99");
    expect(missing.json).toMatchObject({ count: 1, missing_ids: [99] });
    expect(missing.json.results?.map((row) => row.id)).toEqual([1]);
  });

  it("pages list with --offset until has_more is false", async () => {
    const { cwd, dbPath } = await createProject();
    for (const content of ["first fact", "second fact", "third fact"]) {
      await runCli(cwd, dbPath, "add", content, "--quiet");
    }
    const seen: (number | undefined)[] = [];
    const pages = [];
    for (const offset of [0, 2]) {
      const page = await runCli(
        cwd,
        dbPath,
        "list",
        "--limit",
        "2",
        "--offset",
        String(offset),
        "--quiet",
      );
      pages.push({
        offset: page.json["offset"],
        count: page.json["count"],
        total_count: page.json["total_count"],
        has_more: page.json["has_more"],
      });
      seen.push(...(page.json.results ?? []).map((row) => row.id));
    }
    expect(pages).toEqual([
      { offset: 0, count: 2, total_count: 3, has_more: true },
      { offset: 2, count: 1, total_count: 3, has_more: false },
    ]);
    expect(seen.toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3]);
    const past = await runCli(cwd, dbPath, "list", "--offset", "5", "--quiet");
    expect(past.json).toMatchObject({
      count: 0,
      total_count: 3,
      has_more: false,
    });
  });

  it("records who wrote each memory and filters reads by writer", async () => {
    const project = await createProject();
    const { cwd, dbPath } = project;
    const attribution = async (id: number) => {
      const { json } = await getMemory(cwd, dbPath, id);
      return [json["source_agent"], json["last_updated_by"]];
    };
    await runCliAs(project, "amp:T-1", "add", "Deploy runs bun", "--quiet");
    await runCliAs(project, "amp:T-2", "add", "Lint runs oxlint", "--quiet");
    await runCliAs(project, "codex:9", "add", "Tests run vitest", "--quiet");
    expect(await attribution(1)).toEqual(["amp:T-1", "amp:T-1"]);

    // An update names the editor and leaves the author alone.
    await runCliAs(project, "codex:9", "update", "1", "--tags", "area:ops");
    expect(await attribution(1)).toEqual(["amp:T-1", "codex:9"]);
    // With no harness detected, the stored editor stays.
    await runCli(cwd, dbPath, "update", "1", "--tags", "area:deploy");
    expect(await attribution(1)).toEqual(["amp:T-1", "codex:9"]);
    // A flag wins over the environment.
    await runCliAs(
      project,
      "amp:T-1",
      "add",
      "Format runs oxfmt",
      "--source-agent",
      "reviewer",
      "--quiet",
    );
    expect(await attribution(4)).toEqual(["reviewer", "reviewer"]);
    await runCliAs(project, "amp:T-2", "deprecate", "3", "--quiet");
    expect(await attribution(3)).toEqual(["codex:9", "amp:T-2"]);

    const ids = (output: RunResult) =>
      (output.json.results ?? [])
        .map((row) => row.id ?? 0)
        .toSorted((a, b) => a - b);
    const listed = (writer: string, ...flags: string[]) =>
      runCliAs(project, writer, "list", "--include-deprecated", ...flags);
    // Mine: created or last changed by this thread.
    expect(ids(await listed("amp:T-1", "--mine", "--quiet"))).toEqual([1]);
    expect(ids(await listed("amp:T-2", "--mine", "--quiet"))).toEqual([2, 3]);
    expect(ids(await listed("", "--by", "codex:9", "--quiet"))).toEqual([1, 3]);
    // A bare agent name covers every thread of that agent, and no other name.
    expect(ids(await listed("", "--by", "amp", "--quiet"))).toEqual([1, 2, 3]);
    expect(ids(await listed("", "--by", "am", "--quiet"))).toEqual([]);
    expect(
      ids(await runCliAs(project, "amp:T-2", "export", "--mine", "--quiet")),
    ).toEqual([2]);

    const checkpoint = await runCliAs(
      project,
      "amp:T-1",
      "checkpoint",
      "--mine",
      "--json-min",
    );
    expect((checkpoint.json.recent ?? []).map((row) => row.id)).toEqual([1]);

    const unknown = await runCliStdout(cwd, dbPath, ["list", "--mine"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stdout + unknown.stderr).toContain("MACHINE_MEMORY_AGENT");
  });

  it("resolves the repository from --repo, the environment, the pin, then the origin remote", async () => {
    const { cwd, dbPath } = await createProject();
    const resolved = async (
      directory: string,
      args: string[] = [],
      env: Record<string, string> = {},
    ) => {
      const output = await runCliStdout(
        directory,
        dbPath,
        ["list", "--quiet", ...args],
        env,
      );
      return decodeCliOutput(output.stdout).repository;
    };
    expect(await resolved(cwd)).toBe("jfalava/machine-memory");

    const initialized = await runCliText(cwd, dbPath, "init", "--local");
    expect(initialized.code, initialized.stderr).toBe(0);
    const pin = join(cwd, ".agents", "machine-memory.json");
    expect(await readFile(pin, "utf8")).toBe(
      '{\n  "repository": "jfalava/machine-memory"\n}\n',
    );

    // The pin outlives the remote it was read from, and --repo re-pins.
    await runCliText(cwd, dbPath, "init", "--local", "--repo", "@acme/widgets");
    const nested = join(cwd, "src", "deep");
    await mkdir(nested, { recursive: true });
    expect(await resolved(cwd)).toBe("@acme/widgets");
    expect(await resolved(nested)).toBe("@acme/widgets");
    expect(await resolved(cwd, [], { MACHINE_MEMORY_REPO: "env/repo" })).toBe(
      "env/repo",
    );
    expect(
      await resolved(cwd, ["--repo", "flag/repo"], {
        MACHINE_MEMORY_REPO: "env/repo",
      }),
    ).toBe("flag/repo");

    await writeFile(pin, '{"repository": "not a slug"}');
    const broken = await runCliStdout(cwd, dbPath, ["list", "--quiet"]);
    expect(broken.code).not.toBe(0);
    expect(broken.stdout + broken.stderr).toContain("machine-memory.json");
  });

  it("lists repositories and merges one into another under new ids", async () => {
    const { cwd, dbPath } = await createProject();
    const other = ["--repo", "@acme/widgets"];
    await runCli(cwd, dbPath, "add", "Deploy runs bun", "--quiet");
    await runCli(cwd, dbPath, "add", "Lint runs oxlint", "--quiet");
    await runCli(cwd, dbPath, "add", "Old fact about gulp", "--quiet");
    await runCli(cwd, dbPath, "deprecate", "3", "--quiet");
    await runCli(
      cwd,
      dbPath,
      "add",
      "Widgets ship weekly",
      "--allow-new-repo",
      "--quiet",
      ...other,
    );

    const listed = await runCli(cwd, dbPath, "repo", "list", "--local");
    expect(listed.json).toMatchObject({
      current: "jfalava/machine-memory",
      source: "origin",
      pin: null,
      count: 2,
      results: [
        {
          repository: "@acme/widgets",
          total: 1,
          active: 1,
          deprecated: 0,
          superseded: 0,
        },
        {
          repository: "jfalava/machine-memory",
          total: 3,
          active: 2,
          deprecated: 1,
          superseded: 0,
        },
      ],
    });

    const merge = ["repo", "merge", "jfalava/machine-memory", "@acme/widgets"];
    const dry = await runCli(cwd, dbPath, ...merge, "--dry-run", "--local");
    expect(dry.json).toMatchObject({ dry_run: true, would_copy: 2 });
    const merged = await runCli(cwd, dbPath, ...merge, "--local");
    expect(merged.code, merged.stderr).toBe(0);
    // Only active memories move; the deprecated one stays behind as history.
    expect(merged.json).toMatchObject({
      copied: 2,
      deprecated: 2,
      id_map: [
        { from_id: 1, into_id: 5 },
        { from_id: 2, into_id: 6 },
      ],
    });

    const target = await runCli(cwd, dbPath, "list", ...other);
    expect(
      (target.json.results ?? []).map((row) => [row.id, row.content]),
    ).toEqual(
      expect.arrayContaining([
        [4, "Widgets ship weekly"],
        [5, "Deploy runs bun"],
        [6, "Lint runs oxlint"],
      ]),
    );
    expect(target.json["count"]).toBe(3);
    const source = await runCli(cwd, dbPath, "list", "--quiet");
    expect(source.json["count"]).toBe(0);

    // A second run finds nothing left to copy and copies nothing twice.
    const again = await runCli(cwd, dbPath, ...merge, "--local");
    expect(again.json).toMatchObject({ copied: 0, deprecated: 0 });
    expect((await runCli(cwd, dbPath, "list", ...other)).json["count"]).toBe(3);
    const same = await runCliStdout(cwd, dbPath, [
      "repo",
      "merge",
      "a/b",
      "a/b",
      "--local",
    ]);
    expect(same.code).not.toBe(0);
  });

  it("prints only ASCII with --ascii, and the JSON still parses to the same text", async () => {
    const { cwd, dbPath } = await createProject();
    const isAscii = (text: string) => !/[\u0080-\uffff]/.test(text);
    const content = `Café déploie — ${"x".repeat(150)} 日本語 🚀`;
    await runCli(cwd, dbPath, "add", content, "--quiet");
    for (const mode of [[], ["--json-min"], ["--brief"]]) {
      const plain = await runCliStdout(cwd, dbPath, ["list", ...mode]);
      const ascii = await runCliStdout(cwd, dbPath, [
        "list",
        ...mode,
        "--ascii",
      ]);
      // The snippet's ellipsis and the content are both non-ASCII without the flag.
      expect([mode, isAscii(plain.stdout)]).toEqual([mode, false]);
      expect([mode, isAscii(ascii.stdout)]).toEqual([mode, true]);
      if (mode[0] !== "--brief") {
        expect(decodeCliOutput(ascii.stdout)).toEqual(
          decodeCliOutput(plain.stdout),
        );
      }
    }
  });

  it("remote status names a version mismatch, a refused token and an older Worker", async () => {
    const { cwd, dbPath } = await createProject();
    const replies = new Map([
      [
        "current",
        {
          status: 200,
          body: {
            ok: true,
            result: { version: "0.1.0", schema_level: 7, schema_expected: 8 },
          },
        },
      ],
      ["refused", { status: 401, body: { error: "Unauthorized" } }],
      ["older", { status: 404, body: { error: "Not found" } }],
      // The router in front of the API answers undeclared paths with 418.
      ["older-router", { status: 418, body: {} }],
    ]);
    const server = createServer((request, response) => {
      const reply = replies.get(request.headers.authorization?.slice(7) ?? "");
      response.statusCode = reply?.status ?? 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(reply?.body ?? {}));
    });
    await new Promise<void>((resolveServer, rejectServer) => {
      server.once("error", rejectServer);
      server.listen(0, "127.0.0.1", () => resolveServer());
    });
    const address = server.address();
    if (address === null || Schema.is(Schema.String)(address)) {
      throw new Error("The status test server did not expose a port.");
    }
    const status = async (token: string, port = address.port) => {
      const result = await runCliStdout(cwd, dbPath, ["remote", "status"], {
        MACHINE_MEMORY_DB_URL: `http://127.0.0.1:${port}/query`,
        MACHINE_MEMORY_DB_TOKEN: token,
      });
      return { code: result.code, json: decodeCliOutput(result.stdout) };
    };
    try {
      const current = await status("current");
      expect(current.code).toBe(0);
      expect(current.json).toMatchObject({
        ok: true,
        authenticated: true,
        worker_version: "0.1.0",
        versions_match: false,
        schema_level: 7,
        schema_expected: 8,
      });
      // The schema gap is the more urgent of the two mismatches.
      expect(current.json.note).toContain("7 of the 8 migrations");

      const refused = await status("refused");
      expect(refused.code).toBe(1);
      expect(refused.json).toMatchObject({ ok: false, authenticated: false });
      expect(refused.json.note).toContain("remote setup");

      const older = await status("older");
      expect(older.code).toBe(1);
      expect(older.json).toMatchObject({ ok: false, authenticated: null });
      expect(older.json.note).toContain("older release");
      expect((await status("older-router")).json).toMatchObject({
        ok: false,
        authenticated: null,
        note: older.json.note,
      });
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    }
    const unreachable = await status("current", 9);
    expect(unreachable.code).toBe(1);
    expect(unreachable.json).toMatchObject({ ok: false, reachable: false });
  });

  it("collects a child's candidates in a file and writes the ones that pass review", async () => {
    const project = await createProject();
    const { cwd, dbPath } = project;
    await runCli(
      cwd,
      dbPath,
      "add",
      "Deploys run through scripts/deploy.sh on the release branch",
      "--quiet",
    );
    const emit = (content: string, ...flags: string[]) =>
      runCliAs(
        project,
        "amp:child",
        "add",
        content,
        "--emit-candidate",
        "findings.json",
        ...flags,
      );

    const fresh = await emit(
      "Lint runs oxlint with the anti-slop plugin",
      "--type",
      "reference",
      "--tags",
      "area:lint",
    );
    expect(fresh.code, fresh.stderr).toBe(0);
    expect(fresh.json).toMatchObject({
      dry_run: true,
      candidate_emitted: true,
      candidates_in_file: 1,
    });
    // The checks of a real add apply, and a refused add emits nothing.
    const duplicate = await emit(
      "Deploys run through scripts/deploy.sh on the release branch",
    );
    expect(duplicate.code).toBe(1);
    expect(duplicate.json).toMatchObject({ candidate_emitted: false });
    const oversize = await emit("x".repeat(2100));
    expect(oversize.code).toBe(1);
    expect(oversize.json).toMatchObject({ candidate_emitted: false });
    const unproven = await runCliStdout(cwd, dbPath, [
      "add",
      "Format runs oxfmt",
      "--certainty",
      "verified",
      "--emit-candidate",
      "findings.json",
    ]);
    expect(unproven.code).not.toBe(0);

    const file = join(cwd, "findings.json");
    const emitted = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Array(Schema.Record(Schema.String, Schema.Json)),
      ),
    )(await readFile(file, "utf8"));
    expect(emitted).toEqual([
      expect.objectContaining({
        content: "Lint runs oxlint with the anti-slop plugin",
        memory_type: "reference",
        tags: "area:lint",
        source_agent: "amp:child",
      }),
    ]);
    // Nothing reached the database.
    expect((await runCli(cwd, dbPath, "list", "--quiet")).json["count"]).toBe(
      1,
    );

    // The parent reviews a file that also holds what a child could not emit.
    await writeFile(
      file,
      JSON.stringify([
        ...emitted,
        {
          content:
            "Deploys run through scripts/deploy.sh on the release branch",
        },
        { content: "y".repeat(2100) },
        { content: "Tests run vitest", certainty: "verified" },
      ]),
    );
    const reviewed = await runCliAs(
      project,
      "amp:parent",
      "import",
      "findings.json",
      "--review",
    );
    expect(reviewed.code, reviewed.stderr).toBe(0);
    expect(reviewed.json).toMatchObject({ count: 4, written: 1, declined: 3 });
    expect(
      (reviewed.json.results ?? []).map((result) => [
        result["status"],
        result["reason"] ?? result.id,
      ]),
    ).toEqual([
      ["written", 2],
      ["declined", "near_duplicate"],
      ["declined", "over_size_limit"],
      ["declined", "verified_without_evidence"],
    ]);
    expect(reviewed.json.results?.[1]).toMatchObject({ duplicate_of: 1 });

    // The child found it; the parent wrote it.
    const written = await getMemory(cwd, dbPath, 2);
    expect(written.json).toMatchObject({
      content: "Lint runs oxlint with the anti-slop plugin",
      memory_type: "reference",
      source_agent: "amp:child",
      last_updated_by: "amp:parent",
    });
    // A second review of the same file writes nothing twice.
    const again = await runCliAs(
      project,
      "amp:parent",
      "import",
      "findings.json",
      "--review",
    );
    expect(again.json).toMatchObject({ written: 0, declined: 4 });
  });

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
    expect(queried.json.results?.map((row) => row.id)).toContain(id);

    const explicitlyLocal = await runCli(
      cwd,
      dbPath,
      "list",
      "--local",
      "--json-min",
    );
    expect(explicitlyLocal.code).toBe(0);
    expect(explicitlyLocal.json.results?.map((row) => row.id)).toContain(id);

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

    const fetched = await getMemory(cwd, dbPath, String(id));
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
    expect(
      decodeCliOutput(machine.stdout.trim()).results?.map((row) => row.id),
    ).toEqual([1]);
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

    const fetched = await getMemory(cwd, dbPath, String(id), "--local");
    expect(fetched.envelope).toEqual({
      repository: "jfalava/machine-memory",
      warning: "Repository 'jfalava/machine-memory' has no memories.",
      count: 0,
      missing_ids: [id],
      results: [],
    });
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
    expect(queried.json.results?.map((row) => row.id)).toEqual([
      Number(local.json.id),
    ]);

    const fetched = await getMemory(cwd, dbPath, String(foreignId));
    expect(fetched.envelope).toEqual({
      repository: "jfalava/machine-memory",
      count: 0,
      missing_ids: [foreignId],
      found_elsewhere: [
        { id: foreignId, repository: "someone/another-repository" },
      ],
      results: [],
    });
    expect(fetched.stderr).toContain("--repo someone/another-repository");
  });

  it("refuses missing-value content and one content for several records", async () => {
    const { cwd, dbPath } = await createProject();
    const first = await runCli(cwd, dbPath, "add", "first fact", "--quiet");
    const second = await runCli(cwd, dbPath, "add", "second fact", "--quiet");
    const firstId = Number(first.json.id);
    const secondId = Number(second.json.id);

    for (const junk of ["null", "undefined", "  "]) {
      const added = await runCli(cwd, dbPath, "add", junk);
      expect(added.code).not.toBe(0);
      const updated = await runCli(
        cwd,
        dbPath,
        "update",
        String(firstId),
        junk,
      );
      expect(updated.code).not.toBe(0);
    }
    const diffed = await runCli(cwd, dbPath, "diff", String(firstId), "null");
    expect(diffed.code).not.toBe(0);
    const file = join(cwd, "import.json");
    await writeFile(
      file,
      JSON.stringify([{ content: "imported fact" }, { content: "null" }]),
    );
    const imported = await runCli(cwd, dbPath, "import", file, "--json-min");
    expect(imported.json.imported).toBe(0);
    expect(String(imported.json.error)).toContain("index 1: missing_content");

    const both = await runCli(
      cwd,
      dbPath,
      "update",
      `${firstId},${secondId}`,
      "one text for two records",
    );
    expect(both.code).not.toBe(0);
    expect(String(both.json.error)).toContain("2 ids were given");

    const rows = await runCliRows(cwd, dbPath, "list");
    expect(rows.rows.map((row) => row.content)).toEqual([
      "second fact",
      "first fact",
    ]);
  });

  it("pins an update to its read and reports lost content on stderr", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "Deploys run through scripts/deploy.sh. Rollbacks use scripts/rollback.sh.",
      "--type",
      "decision",
      "--quiet",
    );
    const id = String(added.json.id);

    const stale = await runCli(
      cwd,
      dbPath,
      "update",
      id,
      "based on an old read",
      "--expected-update-count",
      "4",
    );
    expect(stale.code).toBe(1);
    expect(String(stale.json.error)).toContain("update_count 0");
    const kept = await getMemory(cwd, dbPath, id);
    expect(kept.json.update_count).toBe(0);

    // No other record mentions scripts/rollback.sh, so dropping it is refused.
    const lossy = [
      "update",
      id,
      "Deploys run through scripts/deploy.sh.",
      "--expected-update-count",
      "0",
      "--json-min",
    ];
    const refused = await runCli(cwd, dbPath, ...lossy);
    expect(refused.code).toBe(1);
    expect(String(refused.json.error)).toContain(
      "it drops `scripts/rollback.sh`, which no other active record mentions",
    );
    expect(String(refused.json.error)).toContain("--allow-drop");
    const untouched = await getMemory(cwd, dbPath, id);
    expect(untouched.json.update_count).toBe(0);
    expect(untouched.json.content).toContain("scripts/rollback.sh");
    expect((await runCli(cwd, dbPath, "history", id)).json.total_count).toBe(0);

    const updated = await runCli(cwd, dbPath, ...lossy, "--allow-drop");
    expect(updated.code).toBe(0);
    expect(updated.json).toHaveProperty("dropped");
    // stdout may be piped through a filter; the loss is also on stderr.
    expect(updated.stderr).toContain(`Update of memory ${id}: dropped`);
    const current = await getMemory(cwd, dbPath, id);
    expect(current.json.update_count).toBe(1);
  });

  it("lets an update drop a name another record still carries", async () => {
    const { cwd, dbPath } = await createProject();
    await runCli(
      cwd,
      dbPath,
      "add",
      "Deploys run through scripts/deploy.sh. Rollbacks use scripts/rollback.sh.",
      "--type",
      "decision",
      "--quiet",
    );
    await runCli(
      cwd,
      dbPath,
      "add",
      "The ops runbook documents scripts/rollback.sh and its exit codes.",
      "--quiet",
    );
    const narrowed = ["update", "1", "Deploys run through scripts/deploy.sh."];

    const dryRun = await runCli(cwd, dbPath, ...narrowed, "--dry-run");
    expect(dryRun.code).toBe(0);
    expect(dryRun.json.targets?.[0]?.replacement).toMatchObject({
      action: "update",
      orphaned_identifiers: [],
      held_elsewhere: [{ identifier: "scripts/rollback.sh", ids: [2] }],
    });
    expect((await runCli(cwd, dbPath, ...narrowed)).code).toBe(0);

    // scripts/deploy.sh is now mentioned nowhere else: the dry run and the
    // write agree that dropping it is refused.
    const emptied = ["update", "1", "Deploys are started by hand."];
    const refusedDryRun = await runCli(cwd, dbPath, ...emptied, "--dry-run");
    expect(refusedDryRun.code).toBe(1);
    expect(refusedDryRun.json.targets?.[0]?.replacement).toMatchObject({
      action: "refuse",
      orphaned_identifiers: ["scripts/deploy.sh"],
    });
    const refused = await runCli(cwd, dbPath, ...emptied);
    expect(refused.code).toBe(1);
    expect(refused.json.error).toBe(refusedDryRun.json.targets?.[0]?.note);
    const kept = await getMemory(cwd, dbPath, "1");
    expect(kept.json.content).toBe("Deploys run through scripts/deploy.sh.");
    expect(kept.json.update_count).toBe(1);
  });

  it("changes metadata without touching the content", async () => {
    const { cwd, dbPath } = await createProject();
    const content = "Deploys run through scripts/deploy.sh.";
    await runCli(cwd, dbPath, "add", content, "--tags", "area:ops", "--quiet");
    await runCli(
      cwd,
      dbPath,
      "add",
      "The users table stores UUID primary keys.",
      "--context",
      "Seen in the schema",
      "--quiet",
    );

    const retyped = await runCli(
      cwd,
      dbPath,
      "update",
      "1",
      "--type",
      "decision",
      "--add-tags",
      "kind:decision,area:ops",
      "--add-gap",
      "untested on Windows",
    );
    expect(retyped.code).toBe(0);
    const first = await getMemory(cwd, dbPath, "1");
    expect(first.json).toMatchObject({
      content,
      memory_type: "decision",
      tags: "area:ops,kind:decision",
      validation_gaps: ["untested on Windows"],
      update_count: 1,
    });
    // The previous state is in history and the content is still searchable.
    const history = await runCli(cwd, dbPath, "history", "1");
    expect(history.json.total_count).toBe(1);
    expect(history.json.results?.[0]?.content).toBe(content);
    const found = await runCli(cwd, dbPath, "query", "deploy.sh", "--json-min");
    expect(found.json.results?.[0]?.id).toBe(1);

    // Removing what was added restores the stored lists.
    const reverted = await runCli(
      cwd,
      dbPath,
      "update",
      "1",
      "--remove-tags",
      "kind:decision",
      "--remove-gap",
      "untested on Windows",
    );
    expect(reverted.code).toBe(0);
    expect((await getMemory(cwd, dbPath, "1")).json).toMatchObject({
      content,
      tags: "area:ops",
      validation_gaps: [],
      update_count: 2,
    });

    // Several ids are allowed when no content is given.
    const both = await runCli(
      cwd,
      dbPath,
      "update",
      "1,2",
      "--clear-context",
      "--updated-by",
      "tester",
    );
    expect(both.code).toBe(0);
    expect((await getMemory(cwd, dbPath, "2")).json).toMatchObject({
      content: "The users table stores UUID primary keys.",
      context: "",
      last_updated_by: "tester",
      update_count: 1,
    });

    const missingGap = await runCli(
      cwd,
      dbPath,
      "update",
      "1",
      "--remove-gap",
      "never stored",
    );
    expect(missingGap.code).toBe(1);
    expect(String(missingGap.json.error)).toContain("No stored validation gap");
    const nothing = await runCli(cwd, dbPath, "update", "1");
    expect(nothing.code).not.toBe(0);
    expect(String(nothing.json.error)).toContain(
      "Give the new content or a field to change",
    );
    const mixed = await runCli(
      cwd,
      dbPath,
      "update",
      "1",
      "--tags",
      "a",
      "--add-tags",
      "b",
    );
    expect(mixed.code).not.toBe(0);
    expect(String(mixed.json.error)).toContain("--tags replaces the stored");
    expect((await getMemory(cwd, dbPath, "1")).json.update_count).toBe(3);
  });

  it("warns about a repository without memories and guards writes to it", async () => {
    const { cwd, dbPath } = await createProject();
    // An empty database has nothing to confuse the slug with: no list of others.
    const empty = await runCli(cwd, dbPath, "list", "--quiet");
    expect(empty.json.warning).toBe(
      "Repository 'jfalava/machine-memory' has no memories.",
    );
    // The same project recorded under its Amp slug: a different repository.
    await insertMemoryFromRepository(
      dbPath,
      "@jfalava/machine-memory",
      "Recorded under the Amp slug",
    );

    const queried = await runCli(cwd, dbPath, "query", "slug", "--json-min");
    expect(queried.json.repository).toBe("jfalava/machine-memory");
    expect(queried.json.warning).toContain("@jfalava/machine-memory");
    expect(queried.stderr).toContain("has no memories");
    const listed = await runCli(cwd, dbPath, "list", "--quiet");
    expect(listed.json.warning).toContain("--repo <slug>");

    const refused = await runCli(cwd, dbPath, "add", "Would start a namespace");
    expect(refused.code).not.toBe(0);
    expect(String(refused.json.error)).toContain("@jfalava/machine-memory");
    expect(String(refused.json.error)).toContain("--allow-new-repo");

    // --repo accepts the slug auto-detection produced, leading @ included.
    const other = await runCliRows(
      cwd,
      dbPath,
      "list",
      "--repo",
      "@jfalava/machine-memory",
    );
    expect(other.rows.map((row) => row.content)).toEqual([
      "Recorded under the Amp slug",
    ]);
    expect(other.stderr).not.toContain("has no memories");

    const started = await runCli(
      cwd,
      dbPath,
      "add",
      "Starts the namespace on purpose",
      "--allow-new-repo",
      "--quiet",
    );
    expect(started.code).toBe(0);
    const own = await runCli(cwd, dbPath, "list", "--quiet");
    expect(own.json).toEqual({
      repository: "jfalava/machine-memory",
      count: 1,
      total_count: 1,
      offset: 0,
      limit: 100,
      has_more: false,
      results: [{ id: Number(started.json.id) }],
    });
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
    const fetched = await getMemory(cwd, dbPath, String(added.json.id));
    expect(fetched.json.tags).toBe("architecture,cli");

    // Several paths: the result names the prefix each one matched, and a path
    // that matched nothing is reported instead of silently adding no tags.
    const several = await runCli(
      cwd,
      dbPath,
      "add",
      "Vitest runs the integration tests in a forked pool",
      "--path",
      "src/cli/help.ts,docs/readme.md",
    );
    expect(several.code).toBe(0);
    expect(several.json.tags).toBe("architecture,cli");
    expect(several.json.path_tag_matches).toEqual([
      {
        path: "src/cli/help.ts",
        prefix: "src/cli",
        tags: ["architecture", "cli"],
      },
    ]);
    expect(several.stderr).toContain(
      "--path docs/readme.md matched no prefix of the tag map",
    );
    expect(several.stderr).not.toContain("without tags");

    const untagged = await runCli(
      cwd,
      dbPath,
      "add",
      "The users table stores UUID primary keys",
      "--path",
      "docs/readme.md",
      "--quiet",
    );
    expect(untagged.code).toBe(0);
    expect(untagged.stderr).toContain(
      `Memory ${untagged.json.id} was written without tags`,
    );
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

    const fetched = await getMemory(cwd, dbPath, "1");
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
    expect((await getMemory(cwd, dbPath, id)).json).toMatchObject({
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

  it("reads several repositories with --repo a,b and writes to one only", async () => {
    const { cwd, dbPath } = await createProject();
    const local = await runCli(
      cwd,
      dbPath,
      "add",
      "Deploy pipeline applies migrations first",
      "--quiet",
    );
    const foreignId = await insertMemoryFromRepository(
      dbPath,
      "acme/widgets",
      "Deploy pipeline of the widgets service runs on tags",
    );
    const hiddenId = await insertMemoryFromRepository(
      dbPath,
      "acme/gadgets",
      "Deploy pipeline of the gadgets service is manual",
    );
    const localId = Number(local.json.id);
    const both = ["--repo", "jfalava/machine-memory,acme/widgets"];
    const where = (rows: readonly { id?: unknown; repository?: unknown }[]) =>
      rows
        .map((row) => [Number(row.id), row.repository])
        .sort(([left], [right]) => Number(left) - Number(right));

    const queried = await runCli(
      cwd,
      dbPath,
      "query",
      "deploy pipeline",
      ...both,
      "--json-min",
    );
    expect(queried.json.repositories).toEqual([
      "jfalava/machine-memory",
      "acme/widgets",
    ]);
    expect(queried.json).not.toHaveProperty("repository");
    expect(where(queried.json.results ?? [])).toEqual([
      [localId, "jfalava/machine-memory"],
      [foreignId, "acme/widgets"],
    ]);

    const fetched = await runCli(
      cwd,
      dbPath,
      "get",
      `${localId},${foreignId},${hiddenId}`,
      ...both,
    );
    expect(where(fetched.json.results ?? [])).toEqual([
      [localId, "jfalava/machine-memory"],
      [foreignId, "acme/widgets"],
    ]);
    expect(fetched.json.missing_ids).toEqual([hiddenId]);

    const listed = await runCli(cwd, dbPath, "list", ...both, "--json-min");
    expect(listed.json.total_count).toBe(2);

    const unknown = await runCli(
      cwd,
      dbPath,
      "list",
      "--repo",
      "jfalava/machine-memory,acme/nothing",
      "--quiet",
    );
    expect(unknown.json.warning).toContain("No memories in: acme/nothing.");
    expect(unknown.stderr).toContain("No memories in: acme/nothing.");

    for (const command of [
      ["add", "Written to two repositories"],
      ["suggest", "--files", "deploy/pipeline.ts"],
    ]) {
      const refused = await runCli(cwd, dbPath, ...command, ...both);
      expect(refused.code).toBe(1);
      expect(refused.json.error).toContain(
        "only query, get and list read several at once",
      );
    }
    expect((await runCliRows(cwd, dbPath, "list", "--quiet")).rows).toEqual([
      { id: localId },
    ]);
  });

  it("leaves an expired status out of query and suggest, not out of list", async () => {
    const { cwd, dbPath } = await createProject();
    await runCli(
      cwd,
      dbPath,
      "add",
      "Deploy pipeline applies migrations before the workers",
      "--type",
      "decision",
      "--quiet",
    );
    await runCli(
      cwd,
      dbPath,
      "add",
      "Deploy pipeline migration is half finished",
      "--type",
      "status",
      "--expires-after-days",
      "3",
      "--create-new",
      "--quiet",
    );
    const backdated = await execBun(
      [
        "-e",
        `import { Database } from "bun:sqlite";
const db = new Database(process.env.MACHINE_MEMORY_DB_PATH); db.exec("UPDATE memories SET updated_at = datetime('now', '-4 days') WHERE memory_type = 'status'"); db.close();`,
      ],
      { env: { ...process.env, MACHINE_MEMORY_DB_PATH: dbPath } },
    );
    expect(backdated.code).toBe(0);
    const ids = async (...args: string[]) =>
      (await runCliRows(cwd, dbPath, ...args, "--json-min")).rows
        .map((row) => Number(row.id))
        .sort((left, right) => left - right);
    expect(await ids("query", "deploy pipeline")).toEqual([1]);
    expect(await ids("query", "deploy pipeline", "--type", "status")).toEqual([
      2,
    ]);
    expect(await ids("suggest", "--files", "deploy/pipeline.ts")).toEqual([1]);
    expect(await ids("list")).toEqual([1, 2]);

    const generic = await runCli(
      cwd,
      dbPath,
      "suggest",
      "--files",
      "package.json,bun.lock",
      "--json-min",
    );
    expect(generic.json).toMatchObject({
      count: 0,
      generic_files: ["package.json", "bun.lock"],
    });
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
      size: { bytes: 76, remaining_bytes: 1924 },
    });

    const deprecated = await runCli(cwd, dbPath, "deprecate", premiseId);
    expect(deprecated.json.review_candidates).toEqual([
      expect.objectContaining({ id: dependentId, match_strength: "strong" }),
    ]);
  });

  it("doctor counts informational findings, lists them with --only, and reports ids in --json-min", async () => {
    const { cwd, dbPath } = await createProject();
    const add = (content: string, ...flags: string[]) =>
      runCli(cwd, dbPath, "add", content, "--create-new", "--quiet", ...flags);
    await add("Deploys go through scripts/deploy.sh", "--tags", "topic:deploy");
    await add("Rollbacks use scripts/rollback.sh", "--tags", "topic:deploy");
    await add("The importer is a work in progress", "--tags", "topic:import");

    const full = await runCli(cwd, dbPath, "doctor");
    // Two decisions on one topic are a thread, not a defect: counted only.
    expect(full.json["informational_counts"]).toMatchObject({
      canonical_thread_overlap: 1,
    });
    expect(full.json.findings).not.toHaveProperty(
      "canonical_thread_overlaps.0",
    );
    expect(JSON.stringify(full.json["suggested_commands"])).not.toContain(
      "--superseded-by",
    );

    const listed = await runCli(
      cwd,
      dbPath,
      "doctor",
      "--only",
      "canonical_thread_overlap",
    );
    expect(listed.json.findings).toMatchObject({
      canonical_thread_overlaps: [{ stale_id: 1, canonical_id: 2 }],
    });
    expect(listed.json["suggested_commands"]).toEqual([]);

    const minimal = await runCli(
      cwd,
      dbPath,
      "doctor",
      "--only",
      "type_boundary",
      "--json-min",
    );
    expect(minimal.json).toMatchObject({
      count: 1,
      counts_by_kind: { transient_non_status: 1 },
      ids_by_kind: { transient_non_status: [3] },
    });
    const unknown = await runCliStdout(cwd, dbPath, ["doctor", "--only", "x"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stdout + unknown.stderr).toContain("transient_non_status");
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
    // The classification leads: it says what to do with the rest.
    const printed = await runCliStdout(cwd, dbPath, [
      "checkpoint",
      "--files",
      "cli/src/db.ts",
      "--json-min",
    ]);
    expect(printed.stdout).toMatch(/^\{"repository":"[^"]+","classification":/);
    expect(checkpoint.json["files_source"]).toBe("flag");
    expect(checkpoint.json.files).toEqual(["cli/src/db.ts"]);
    expect(checkpoint.json.recent?.map((row) => row.id)).toEqual([2, id]);
    expect(checkpoint.json.related).toEqual([
      expect.objectContaining({ id, match_strength: "strong" }),
    ]);
    expect(checkpoint.json.review).toMatchObject({
      status_without_expiry: [2],
      // Gaps beside named evidence are how a verified record should look.
      verified_with_gaps: [],
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

  it("checkpoint takes files from the working tree, and from the last commit only on request", async () => {
    const { cwd, dbPath } = await createProject();
    const git = (...args: string[]) =>
      new Promise<void>((resolveGit, rejectGit) => {
        execFileCallback(
          "git",
          ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
          { cwd },
          (error) => (error ? rejectGit(error) : resolveGit()),
        );
      });
    const files = async (...flags: string[]) => {
      const { json } = await runCli(cwd, dbPath, "checkpoint", ...flags);
      return [json["files_source"], json.files, "files_note" in json];
    };
    // The test database lives in the checkout; a project ignores it.
    await writeFile(join(cwd, ".gitignore"), ".agents/\n");
    await git("add", ".gitignore");
    await git("commit", "--quiet", "-m", "ignore");
    await writeFile(join(cwd, "committed.ts"), "export {};\n");
    await git("add", "committed.ts");
    await git("commit", "--quiet", "-m", "first");

    // A clean tree says so; the last commit may be someone else's work.
    expect(await files()).toEqual(["none", [], true]);
    expect(await files("--last-commit")).toEqual([
      "last_commit",
      ["committed.ts"],
      false,
    ]);
    await writeFile(join(cwd, "draft.ts"), "export {};\n");
    expect(await files()).toEqual(["working_tree", ["draft.ts"], false]);
    expect(await files("--files", "other.ts")).toEqual([
      "flag",
      ["other.ts"],
      false,
    ]);
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
    expect((await getMemory(cwd, dbPath, "1")).json.content).toBe(
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
    // The block above predates block versions, so every command says so.
    expect(added.stderr).toContain(
      "The machine-memory block in AGENTS.md is version 1",
    );

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
      expect(agentsMd).toContain("Every database command takes `--remote`.");
      expect(agentsMd).not.toContain("local instructions");
    } finally {
      await new Promise<void>((resolveServer, rejectServer) =>
        server.close((error) =>
          error ? rejectServer(error) : resolveServer(),
        ),
      );
    }
  });

  it("reports used and remaining bytes on a successful add", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "hello",
      "--tags",
      "cli",
      "--quiet",
    );
    expect(added.code).toBe(0);
    // "hello" (5) + "\nTags: cli" (10)
    expect(added.json.size).toEqual({ bytes: 15, remaining_bytes: 1985 });
  });

  it("accepts a memory of exactly 2,000 bytes and refuses 2,001", async () => {
    const { cwd, dbPath } = await createProject();
    // 1,990 content bytes + "\nTags: cli" (10 bytes) = 2,000.
    const atLimit = await runCli(
      cwd,
      dbPath,
      "add",
      "é".repeat(995),
      "--tags",
      "cli",
      "--quiet",
    );
    expect(atLimit.code).toBe(0);
    expect(atLimit.json.size).toEqual({ bytes: 2000, remaining_bytes: 0 });

    const over = await runCli(
      cwd,
      dbPath,
      "add",
      `${"é".repeat(995)}a`,
      "--tags",
      "cli",
      "--local",
    );
    expect(over.code).toBe(1);
    expect(String(over.json.error ?? "")).toBe(
      "Memory is over by 1 bytes of 2,000: content 1,991, tags 10, context 0 bytes. Shorten it, or split it into one record per fact. Nothing was written.",
    );
    const second = await getMemory(cwd, dbPath, "2", "--local");
    expect(second.envelope.count).toBe(0);
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
    expect(error).toContain("is over by 1,599 bytes of 2,000");
    expect(error).toContain("content 3,599, tags 0, context 0 bytes");

    const fetched = await getMemory(cwd, dbPath, "1", "--local");
    expect(fetched.envelope.count).toBe(0);
  });

  it("validates retained metadata before updating an upsert match", async () => {
    const { cwd, dbPath } = await createProject();
    const original = Array.from({ length: 58 }, () => "alpha beta gamma").join(
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
      Array.from({ length: 60 }, () => "alpha beta gamma").join(" "),
      "--upsert-match",
      "alpha beta gamma",
      "--quiet",
    );
    expect(upserted.code).toBe(1);
    expect(String(upserted.json.error ?? "")).toContain(`Memory ${id}`);
    // The new content fits alone; with the retained context it does not.
    expect(String(upserted.json.error ?? "")).toContain(
      "is over by 14 bytes of 2,000: content 1,019, tags 0, context 995 bytes",
    );

    const fetched = await getMemory(cwd, dbPath, String(id), "--local");
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
    expect(String(updated.json.error ?? "")).toContain(
      "is over by 1,599 bytes of 2,000",
    );

    const fetched = await getMemory(cwd, dbPath, String(id), "--local");
    expect(fetched.json.content).toBe("original content");
  });

  it("reports used and remaining bytes on a successful update", async () => {
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
      "--local",
    );
    expect(updated.code).toBe(0);
    expect(updated.json.content).toBe("replacement content");
    expect(updated.json.size).toEqual({ bytes: 19, remaining_bytes: 1981 });
  });

  it("preflights the embedding budget with the size command", async () => {
    const { cwd, dbPath } = await createProject();
    const within = await runCli(
      cwd,
      dbPath,
      "size",
      "hello world",
      "--tags",
      "cli",
      "--context",
      "why",
    );
    expect(within.code).toBe(0);
    expect(within.json).toMatchObject({
      bytes: 34,
      max_bytes: 2000,
      within_budget: true,
      over_by_bytes: 0,
      remaining_bytes: 1966,
      parts: { content: 11, tags: 10, context: 13 },
    });

    // --remote is accepted as a no-op for the non-database size command.
    const withRemote = await runCli(
      cwd,
      dbPath,
      "size",
      "hello world",
      "--remote",
    );
    expect(withRemote.code).toBe(0);

    // 1,001 two-byte characters: under 2,000 characters, over 2,000 bytes.
    const over = await runCli(cwd, dbPath, "size", "é".repeat(1001));
    expect(over.code).toBe(1);
    expect(over.json).toMatchObject({
      bytes: 2002,
      within_budget: false,
      over_by_bytes: 2,
      remaining_bytes: -2,
    });
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
    expect(size?.over_by_bytes).toBe(1599);

    const fetched = await getMemory(cwd, dbPath, "1", "--local");
    expect(fetched.envelope.count).toBe(0);
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
      "é".repeat(1001),
      "--dry-run",
      "--local",
    );
    expect(dry.code).toBe(1);
    expect(dry.json.command).toBe("update");
    expect(dry.json.dry_run).toBe(true);
    expect(dry.json.count).toBe(1);
    const targets = dry.json.targets ?? [];
    expect(targets[0]?.id).toBe(id);
    expect(targets[0]?.size?.over_by_bytes).toBe(2);

    const okDry = await runCli(
      cwd,
      dbPath,
      "update",
      String(id),
      "small content",
      "--dry-run",
      "--local",
    );
    expect(okDry.code).toBe(0);
    expect(okDry.json.count).toBe(1);
    const fetched = await getMemory(cwd, dbPath, String(id), "--local");
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

    // The dry run reports what the real write does: a weak match is refused,
    // --create-new creates, and nothing matching creates.
    const weakArgs = [
      "add",
      "unrelated omega psi quantum flux capacitor notes",
      "--upsert-match",
      "alpha beta gamma",
      "--dry-run",
      "--local",
    ];
    const weak = await runCli(cwd, dbPath, ...weakArgs);
    expect(weak.code).toBe(1);
    expect(weak.json.action).toBe("refuse");
    expect(weak.json.would_match).toMatchObject({
      id: existingId,
      text_overlap: 0,
      shared_identifiers: [],
    });
    expect(weak.json.candidates).toEqual([weak.json.would_match]);
    expect(String(weak.json.note)).toContain(
      "No record matches the upsert query strongly enough to update",
    );
    const createNew = await runCli(cwd, dbPath, ...weakArgs, "--create-new");
    expect(createNew.code).toBe(0);
    expect(createNew.json.action).toBe("create");
    expect(createNew.json.would_match?.id).toBe(existingId);
    // --update-id names the target; replacing it with a different fact is refused.
    const wrongTarget = await runCli(
      cwd,
      dbPath,
      "add",
      "unrelated omega psi quantum flux capacitor notes",
      "--update-id",
      String(existingId),
      "--dry-run",
    );
    expect(wrongTarget.code).toBe(1);
    expect(wrongTarget.json).toMatchObject({
      action: "refuse",
      update_id: existingId,
      replacement: { action: "refuse", text_overlap: 0 },
    });
    const unmatched = await runCli(
      cwd,
      dbPath,
      "add",
      "unrelated omega psi quantum flux capacitor notes",
      "--upsert-match",
      "zzzunmatched",
      "--dry-run",
    );
    expect(unmatched.code).toBe(0);
    expect(unmatched.json.action).toBe("create");
    expect(unmatched.json).not.toHaveProperty("would_match");

    const fetched = await getMemory(cwd, dbPath, String(existingId), "--local");
    expect(fetched.json.update_count).toBe(0);
  });

  it("refuses a weak upsert match until the caller states intent", async () => {
    const { cwd, dbPath } = await createProject();
    const added = await runCli(
      cwd,
      dbPath,
      "add",
      "alpha beta gamma delta epsilon zeta",
      "--tags",
      "area:greek",
      "--quiet",
      "--local",
    );
    const existingId = Number(added.json.id);
    const weakArgs = [
      "add",
      "unrelated omega psi quantum flux capacitor notes",
      "--upsert-match",
      "alpha beta gamma",
      "--local",
    ];

    const blocked = await runCli(cwd, dbPath, ...weakArgs);
    expect(blocked.code).toBe(1);
    const error = String(blocked.json.error);
    expect(error).toContain(`#${existingId} convention "alpha beta gamma`);
    expect(error).toContain(`--update-id ${existingId}`);
    expect(error).toContain("--create-new");
    expect(error).toContain("Nothing was written.");

    // Still just one record after the blocked attempt.
    const afterBlock = await runCli(
      cwd,
      dbPath,
      "list",
      "--json-min",
      "--local",
    );
    expect(afterBlock.json.count).toBe(1);

    // The flag --create-new replaced is gone, not ignored: nothing is created.
    const forced = await runCli(cwd, dbPath, ...weakArgs, "--force");
    expect(forced.code).not.toBe(0);
    expect((await runCli(cwd, dbPath, "list", "--json-min")).json.count).toBe(
      1,
    );

    const lowered = await runCli(
      cwd,
      dbPath,
      ...weakArgs,
      "--upsert-threshold",
      "0.000001",
    );
    expect(lowered.code).toBe(1); // the text_overlap bar still applies

    const created = await runCli(cwd, dbPath, ...weakArgs, "--create-new");
    expect(created.code).toBe(0);
    expect(created.json.mode).toBe("created");
    expect(Number(created.json.id)).not.toBe(existingId);
    expect(created.json.upsert_match).toMatchObject({
      id: existingId,
      text_overlap: 0,
    });

    // --update-id restates the record it names and keeps the omitted fields.
    const restated = await runCli(
      cwd,
      dbPath,
      "add",
      "alpha beta gamma delta epsilon zeta eta",
      "--update-id",
      String(existingId),
    );
    expect(restated.code).toBe(0);
    expect(restated.json).toMatchObject({ mode: "updated", id: existingId });
    const current = await getMemory(cwd, dbPath, String(existingId));
    expect(current.json).toMatchObject({
      content: "alpha beta gamma delta epsilon zeta eta",
      tags: "area:greek",
      update_count: 1,
    });

    const both = await runCli(
      cwd,
      dbPath,
      "add",
      "alpha beta",
      "--update-id",
      String(existingId),
      "--create-new",
    );
    expect(both.code).not.toBe(0);
    expect(String(both.json.error)).toContain("give one of them");
    const missing = await runCli(
      cwd,
      dbPath,
      "add",
      "alpha beta",
      "--update-id",
      "999",
    );
    expect(missing.code).toBe(1);
    expect(String(missing.json.error)).toContain("Memory 999 was not found");
  });

  it("refuses a plain add that repeats a record and lists related ones", async () => {
    const { cwd, dbPath } = await createProject();
    const content =
      "Deploys run through scripts/deploy.sh. Rollbacks use scripts/rollback.sh.";
    await runCli(cwd, dbPath, "add", content, "--tags", "area:ops", "--quiet");

    const repeated = ["add", `${content} Always.`, "--tags", "area:ops"];
    const refused = await runCli(cwd, dbPath, ...repeated);
    expect(refused.code).toBe(1);
    expect(String(refused.json.error)).toContain(
      "Memory #1 already states nearly the same thing",
    );
    expect(String(refused.json.error)).toContain("--update-id 1");
    const dryRun = await runCli(cwd, dbPath, ...repeated, "--dry-run");
    expect(dryRun.code).toBe(1);
    expect(dryRun.json).toMatchObject({
      action: "refuse",
      duplicate: { id: 1 },
      note: refused.json.error,
    });
    expect((await runCli(cwd, dbPath, "list", "--json-min")).json.count).toBe(
      1,
    );
    // --create-new: the caller read record 1 and this is a different fact.
    const insisted = await runCli(cwd, dbPath, ...repeated, "--create-new");
    expect(insisted.code).toBe(0);
    expect(insisted.json.id).toBe(2);

    // A record about the same script is not a duplicate; it is listed as related.
    const related = await runCli(
      cwd,
      dbPath,
      "add",
      "Run scripts/deploy.sh against staging before every production release.",
      "--tags",
      "area:ops",
    );
    expect(related.code).toBe(0);
    expect(
      (related.json.related ?? []).map((row: { id?: number }) => row.id),
    ).toEqual(expect.arrayContaining([1]));

    const unrelated = await runCli(
      cwd,
      dbPath,
      "add",
      "The users table stores UUID primary keys.",
      "--tags",
      "area:db",
    );
    expect(unrelated.code).toBe(0);
    expect(unrelated.json).not.toHaveProperty("related");
    expect(unrelated.json).not.toHaveProperty("potential_conflicts");
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

    const jsonMin = await getMemory(
      cwd,
      dbPath,
      String(id),
      "--json-min",
      "--local",
    );
    // get is how a memory is read, so its summary carries the whole content.
    expect(jsonMin.envelope).toEqual({
      repository: "jfalava/machine-memory",
      count: 1,
      results: [
        {
          id,
          memory_type: "reference",
          certainty: "verified",
          status: "active",
          tags: ["area:cli", "kind:test"],
          evidence: ["observed_implementation"],
          content: "parity check memory for get output modes",
        },
      ],
    });

    const quiet = await getMemory(
      cwd,
      dbPath,
      String(id),
      "--quiet",
      "--local",
    );
    expect(quiet.envelope).toEqual({
      repository: "jfalava/machine-memory",
      count: 1,
      results: [{ id }],
    });

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
    const first = await getMemory(cwd, dbPath, String(results[0]?.id));
    expect(first.json).toMatchObject({
      memory_type: "decision",
      refs: ["docs/first.md"],
    });
    expect(first.json["created_at"]).toMatch(ISO_UTC);
    const second = await getMemory(cwd, dbPath, String(results[1]?.id));
    expect(second.json["created_at"]).toBe("2024-01-02T03:04:05Z");
    expect(second.json["updated_at"]).toMatch(ISO_UTC);
  });

  it("prints timestamps with a zone and keeps SQLite's form in storage", async () => {
    const { cwd, dbPath } = await createProject();
    await runCli(cwd, dbPath, "add", "Deploy runs bun", "--quiet");
    await runCli(cwd, dbPath, "update", "1", "Deploy runs bun run deploy");
    const history = await runCli(cwd, dbPath, "history", "1");
    const [snapshot] = history.json.results ?? [];
    expect(snapshot?.["snapshot_at"]).toMatch(ISO_UTC);
    expect(snapshot?.["created_at"]).toMatch(ISO_UTC);
    const restored = await runCli(
      cwd,
      dbPath,
      "restore",
      "1",
      "--revision",
      String(snapshot?.revision_id),
      "--expected-update-count",
      "1",
    );
    expect(restored.code, restored.stderr).toBe(0);

    // A round trip through export carries ISO times into import.
    const exported = await runCliStdout(cwd, dbPath, ["export"]);
    const file = join(cwd, "export.json");
    await writeFile(file, exported.stdout);
    const target = await createProject();
    const imported = await runCli(target.cwd, target.dbPath, "import", file);
    expect(imported.code, imported.stderr).toBe(0);

    const sqliteForm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    for (const path of [dbPath, target.dbPath]) {
      const stored = await storedTimestamps(path);
      expect(stored).toHaveLength(2);
      for (const value of stored) {
        expect(value).toMatch(sqliteForm);
      }
    }
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
    const old = await getMemory(cwd, dbPath, String(results[0]?.id));
    expect(old.json.superseded_by).toBe(results[1]?.id);
    expect(old.json.superseded_by).not.toBe(90);
    const replacement = await getMemory(cwd, dbPath, String(results[1]?.id));
    expect(replacement.json.content).toBe("replacement convention");
  });

  it.each([
    { content: "x".repeat(2001) },
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
      (await getMemory(cwd, dbPath, String(id))).json.expires_after_days,
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
    expect((await getMemory(cwd, dbPath, String(id))).json.content).toBe(
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
