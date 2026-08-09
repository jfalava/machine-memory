import {
  CERTAINTY_LEVELS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  VERSION,
} from "../constants";
import {
  ADD_USAGE,
  DEPRECATE_USAGE,
  UPDATE_USAGE,
} from "./features/memory/usage";

const DATABASE_BACKEND_USAGE = " (--local|--remote)";

export function helpPayload() {
  return {
    name: "machine-memory",
    version: VERSION,
    description:
      "Persistent project-scoped memory for LLM agents. Stores facts, decisions, references, status snapshots, and other project context in a local SQLite database so future agent sessions can recall them.",
    database:
      "Every database-backed command requires exactly one of --local or --remote. Remote credentials come from MACHINE_MEMORY_DB_URL/MACHINE_MEMORY_DB_TOKEN or the OS keychain.",
    commands: {
      help: "Show this help message",
      add: {
        usage: ADD_USAGE,
      },
      query: {
        usage: `query <search_term> [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--include-deprecated] [--limit <n>] [--semantic|--hybrid] [--explain-score]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
      },
      list: {
        usage: `list [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--status <status>] [--include-deprecated] [--limit <n>]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
      },
      get: { usage: `get <id|id,id,...>${DATABASE_BACKEND_USAGE}` },
      update: {
        usage: UPDATE_USAGE,
      },
      deprecate: {
        usage: DEPRECATE_USAGE,
      },
      delete: { usage: `delete <id|id,id,...>${DATABASE_BACKEND_USAGE}` },
      suggest: {
        usage: `suggest (--files "src/a.ts,src/b.ts" | --files-json '["src/a.ts","src/b.ts"]') [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--include-deprecated] [--limit <n>] [--explain-score]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
      },
      sweep: {
        usage: `sweep (--files "src/a.ts,src/b.ts" | --files-json '["src/a.ts","src/b.ts"]') [--query <search_term>] [--tags <tag>] [--limit <n>]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
      },
      doctor: {
        usage: `doctor${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
      },
      verify: { usage: `verify <id> <fact>${DATABASE_BACKEND_USAGE}` },
      diff: { usage: `diff <id> <new_content>${DATABASE_BACKEND_USAGE}` },
      "tag-map": {
        usage:
          "tag-map <list|set|delete|suggest> [path_prefix] [tags_csv|path]",
      },
      migrate: { usage: `migrate${DATABASE_BACKEND_USAGE}` },
      coverage: { usage: `coverage [--root <path>]${DATABASE_BACKEND_USAGE}` },
      gc: { usage: `gc --dry-run${DATABASE_BACKEND_USAGE}` },
      stats: { usage: `stats${DATABASE_BACKEND_USAGE}` },
      import: { usage: `import <memories.json>${DATABASE_BACKEND_USAGE}` },
      reindex: {
        usage: `reindex${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
      },
      export: {
        usage: `export [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--since <ISO date>]${DATABASE_BACKEND_USAGE}`,
      },
      version: { usage: "version" },
      upgrade: { usage: "upgrade" },
      init: {
        usage: "init (--local|--remote)",
        description:
          "Creates or replaces the managed machine-memory block in the current directory's AGENTS.md file",
      },
      remote: {
        setup: {
          usage: "remote setup [--url <worker-url>] [--token <worker-token>]",
          description:
            "Store Cloudflare D1 Worker credentials in the OS keychain",
        },
        provision: {
          usage:
            "remote provision [--stack-name <name>] [--database-name <name>] [--api-name <name>]",
          description:
            "Deploy the Alchemy D1 stack and store its Worker credentials",
        },
      },
    },
    enums: {
      memory_type: MEMORY_TYPES,
      certainty: CERTAINTY_LEVELS,
      status: MEMORY_STATUSES,
    },
    what_to_store: [
      "Architectural decisions (e.g. 'we chose Drizzle over Prisma because...')",
      "Project references/docs (e.g. 'API fields for run status: running, errored, finished')",
      "Point-in-time status snapshots (e.g. 'coverage audit: 82%, missing sdk/')",
      "Non-obvious gotchas (e.g. 'the users table uses UUIDs, not auto-increment')",
      "Environment/tooling notes (e.g. 'run machine-memory migrate --local after pulling main')",
      "User preferences (e.g. 'user prefers explicit error handling over try/catch')",
    ],
  };
}
