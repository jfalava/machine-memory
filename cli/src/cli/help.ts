import {
  CERTAINTY_LEVELS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  VERSION,
} from "../constants";
import {
  ADD_USAGE,
  DEPRECATE_USAGE,
  SIZE_USAGE,
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
    embedding_budget: {
      limit:
        "A memory's composed embedding text must stay below 512 BGE tokens AND its conservative byte estimate (UTF-8 bytes + 2) must be at most 512. Either limit alone rejects the write before anything is stored.",
      composed_text:
        "content, plus Tags:/Context: lines when present, plus fixed Memory type/Status/Certainty lines.",
      preflight:
        'machine-memory size "<text>" reports token count, byte estimate, pass/fail per limit, and which limit binds. add/update accept --dry-run for the same report without writing, and --token-report to attach the breakdown to a real write.',
    },
    output_fields: {
      conflict_count:
        "Number of active memories that may conflict with newly added content (also listed in potential_conflicts).",
      status_cascade_count:
        "For a newly added status memory: how many other active status memories share its tags and are candidates to deprecate (see status_cascade.suggested_command).",
      tokens:
        "Per-part BGE token breakdown with bytes_estimate (UTF-8 bytes + 2) attached when --token-report is passed or a write fails the size gate.",
    },
    global_options: {
      pretty:
        "Render human-readable output for machine commands; existing human commands keep their normal output.",
    },
    commands: {
      help: "Show this help message",
      add: {
        usage: ADD_USAGE,
        notes:
          "--dry-run prints the size report (and, with --upsert-match, the memory that would be matched) without writing. With --upsert-match, a best match that fails the strength bar (score below --upsert-threshold <0-100>, default 32, or similarity below 0.62) requires --force or interactive confirm before a new record is created.",
      },
      query: {
        usage: `query <search_term> [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--include-deprecated] [--limit <n>] [--semantic|--hybrid] [--explain-score]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
      },
      list: {
        usage: `list [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--status <status>] [--include-deprecated] [--limit <n>]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
      },
      get: {
        usage: `get <id|id,id,...>${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
      },
      size: {
        usage: SIZE_USAGE,
        description:
          "Report the embedding budget for a prospective memory (token count, byte+2 estimate, binding limit) without touching the database. Exit code 1 means it would be rejected.",
      },
      update: {
        usage: UPDATE_USAGE,
        notes:
          "--dry-run prints the per-target size report without writing. Accepts --brief|--json-min|--quiet.",
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
        usage: `reindex --remote [--brief|--json-min|--quiet]`,
      },
      export: {
        usage: `export [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--since <ISO date>]${DATABASE_BACKEND_USAGE}`,
      },
      version: { usage: "version" },
      upgrade: { usage: "upgrade" },
      init: {
        usage: "init (--local|--remote|--mcp)",
        description:
          "Creates or replaces the managed machine-memory block in the current directory's AGENTS.md file (CLI local/remote or MCP-only)",
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
      local: {
        export: {
          usage: "local export [local-db-path] --remote",
          description:
            "Read a local SQLite database and export its repository memories into the remote D1 database",
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
