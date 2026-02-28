import {
  CERTAINTY_LEVELS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  VERSION,
} from "../constants";
import { ADD_USAGE, DEPRECATE_USAGE, UPDATE_USAGE } from "./shared";

export function helpPayload() {
  return {
    name: "machine-memory",
    version: VERSION,
    description:
      "Persistent project-scoped memory for LLM agents. Stores facts, decisions, references, status snapshots, and other project context in a local SQLite database so future agent sessions can recall them.",
    database: ".agents/memory.db (relative to cwd)",
    commands: {
      help: "Show this help message",
      add: {
        usage: ADD_USAGE,
      },
      query: {
        usage:
          "query <search_term> [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--include-deprecated] [--brief|--json-min|--quiet]",
      },
      list: {
        usage:
          "list [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--status <status>] [--include-deprecated] [--brief]",
      },
      get: { usage: "get <id>" },
      update: {
        usage: UPDATE_USAGE,
      },
      deprecate: {
        usage: DEPRECATE_USAGE,
      },
      delete: { usage: "delete <id|id,id,...>" },
      suggest: {
        usage:
          'suggest (--files "src/a.ts,src/b.ts" | --files-json \'["src/a.ts","src/b.ts"]\') [--brief|--json-min|--quiet]',
      },
      verify: { usage: "verify <id> <fact>" },
      diff: { usage: "diff <id> <new_content>" },
      "tag-map": {
        usage:
          "tag-map <list|set|delete|suggest> [path_prefix] [tags_csv|path]",
      },
      migrate: { usage: "migrate" },
      coverage: { usage: "coverage [--root <path>]" },
      gc: { usage: "gc --dry-run" },
      stats: { usage: "stats" },
      import: { usage: "import <memories.json>" },
      export: {
        usage:
          "export [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--since <ISO date>]",
      },
      version: { usage: "version" },
      upgrade: { usage: "upgrade" },
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
      "Environment/tooling notes (e.g. 'run machine-memory migrate after pulling main')",
      "User preferences (e.g. 'user prefers explicit error handling over try/catch')",
    ],
  };
}
