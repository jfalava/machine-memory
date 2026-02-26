import { Database } from "bun:sqlite";
import { resolve, dirname } from "node:path";
import {
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
  chmodSync,
} from "node:fs";

const VERSION = "0.1.0";
const REPO = "jfalava/machine-memory";
const DB_PATH = resolve(process.cwd(), ".agents", "memory.db");

function ensureDb(): Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const instance = new Database(DB_PATH);
  instance.run("PRAGMA journal_mode=WAL");
  instance.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      context TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  instance.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, tags, context, content='memories', content_rowid='id')
  `);
  instance.run(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags, context)
      VALUES (new.id, new.content, new.tags, new.context);
    END
  `);
  instance.run(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags, context)
      VALUES ('delete', old.id, old.content, old.tags, old.context);
    END
  `);
  instance.run(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags, context)
      VALUES ('delete', old.id, old.content, old.tags, old.context);
      INSERT INTO memories_fts(rowid, content, tags, context)
      VALUES (new.id, new.content, new.tags, new.context);
    END
  `);
  return instance;
}

function printJson(data: unknown) {
  // eslint-disable-next-line no-console -- CLI output is the intended interface
  console.log(JSON.stringify(data));
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {return undefined;}
  return args[idx + 1];
}

function getPlatformAssetName(): string {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `machine-memory-${platform}-${arch}`;
}

const API_BASE = process.env["MACHINE_MEMORY_API_URL"] ?? `https://api.github.com/repos/${REPO}`;
const BIN_PATH = process.env["MACHINE_MEMORY_BIN_PATH"] ?? process.execPath;

async function upgrade() {
  const res = await fetch(
    `${API_BASE}/releases/latest`,
    {
      headers: { Accept: "application/vnd.github+json" },
    },
  );
  if (!res.ok) {
    printJson({ error: `Failed to fetch latest release: ${res.status}` });
    process.exit(1);
  }

  const release = (await res.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };

  const latest = release.tag_name.replace(/^v/, "");
  if (latest === VERSION) {
    printJson({ message: "Already up to date", version: VERSION });
    return;
  }

  const assetName = getPlatformAssetName();
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    printJson({
      error: `No binary found for ${assetName}`,
      available: release.assets.map((a) => a.name),
    });
    process.exit(1);
  }

  const tmpPath = `${BIN_PATH}.tmp`;

  const download = await fetch(asset.browser_download_url);
  if (!download.ok) {
    printJson({ error: `Download failed: ${download.status}` });
    process.exit(1);
  }

  const { writeFile } = await import("node:fs/promises");
  const buffer = new Uint8Array(await download.arrayBuffer());
  await writeFile(tmpPath, buffer);
  chmodSync(tmpPath, 0o755);

  try {
    renameSync(BIN_PATH, `${BIN_PATH}.bak`);
    renameSync(tmpPath, BIN_PATH);
    unlinkSync(`${BIN_PATH}.bak`);
  } catch (e) {
    if (existsSync(`${BIN_PATH}.bak`)) {
      renameSync(`${BIN_PATH}.bak`, BIN_PATH);
    }
    if (existsSync(tmpPath)) {unlinkSync(tmpPath);}
    throw e;
  }

  printJson({ message: "Upgraded", from: VERSION, to: latest });
}

const [command, ...args] = process.argv.slice(2);

if (!command) {
  printJson({
    error:
      "No command provided. Commands: add, query, get, update, delete, list, version, upgrade",
  });
  process.exit(1);
}

// Commands that don't need the database
if (command === "version") {
  printJson({ version: VERSION });
  process.exit(0);
}
if (command === "upgrade") {
  await upgrade();
  process.exit(0);
}

// Commands that need the database
const memoryDb = ensureDb();

switch (command) {
  case "add": {
    const content = args[0];
    if (!content) {
      printJson({
        error: "Usage: add <content> [--tags <tags>] [--context <context>]",
      });
      process.exit(1);
    }
    const tags = getFlagValue(args, "--tags") ?? "";
    const memo = getFlagValue(args, "--context") ?? "";
    const result = memoryDb.run(
      "INSERT INTO memories (content, tags, context) VALUES (?, ?, ?)",
      [content, tags, memo],
    );
    printJson({ id: result.lastInsertRowid, content, tags, context: memo });
    break;
  }

  case "query": {
    const term = args[0];
    if (!term) {
      printJson({ error: "Usage: query <search_term>" });
      process.exit(1);
    }
    const rows = memoryDb
      .query(
        `SELECT m.* FROM memories m
         JOIN memories_fts f ON m.id = f.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank`,
      )
      .all(term);
    printJson(rows);
    break;
  }

  case "get": {
    const id = args[0];
    if (!id) {
      printJson({ error: "Usage: get <id>" });
      process.exit(1);
    }
    const row = memoryDb.query("SELECT * FROM memories WHERE id = ?").get(Number(id));
    printJson(row ?? { error: "Not found" });
    break;
  }

  case "update": {
    const id = args[0];
    const content = args[1];
    if (!id || !content) {
      printJson({
        error:
          "Usage: update <id> <content> [--tags <tags>] [--context <context>]",
      });
      process.exit(1);
    }
    const tags = getFlagValue(args, "--tags");
    const memo = getFlagValue(args, "--context");
    const sets = ["content = ?", "updated_at = datetime('now')"];
    const params: (string | number)[] = [content];
    if (tags !== undefined) {
      sets.push("tags = ?");
      params.push(tags);
    }
    if (memo !== undefined) {
      sets.push("context = ?");
      params.push(memo);
    }
    params.push(Number(id));
    memoryDb.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, params);
    const updated = memoryDb
      .query("SELECT * FROM memories WHERE id = ?")
      .get(Number(id));
    printJson(updated ?? { error: "Not found" });
    break;
  }

  case "delete": {
    const id = args[0];
    if (!id) {
      printJson({ error: "Usage: delete <id>" });
      process.exit(1);
    }
    memoryDb.run("DELETE FROM memories WHERE id = ?", [Number(id)]);
    printJson({ deleted: Number(id) });
    break;
  }

  case "list": {
    const tag = getFlagValue(args, "--tags");
    let rows;
    if (tag) {
      rows = memoryDb
        .query(
          "SELECT * FROM memories WHERE tags LIKE ? ORDER BY updated_at DESC",
        )
        .all(`%${tag}%`);
    } else {
      rows = memoryDb.query("SELECT * FROM memories ORDER BY updated_at DESC").all();
    }
    printJson(rows);
    break;
  }

  default:
    printJson({
      error: `Unknown command: ${command}. Commands: add, query, get, update, delete, list, version, upgrade`,
    });
    process.exit(1);
}

memoryDb.close();
