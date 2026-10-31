import { EVIDENCE_KINDS } from "@machine-memory/contract";

import {
  CERTAINTY_LEVELS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  VERSION,
} from "../constants";
import type { JsonObject } from "../json";
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
      "Persistent project-scoped memory for LLM agents. Stores facts, decisions, references, status snapshots, and other project context in a remote Cloudflare D1 database (--remote) or a local SQLite database (--local) so future agent sessions can recall them.",
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
      match_strength:
        "Absolute per-result relevance for query/suggest/sweep. strong: every query identifier found literally (or one plus strong term coverage), at least 60% of query terms, a suggested file path or file name, or semantic similarity >= 0.75. weak: a partial identifier hit, at least 30% of terms, or similarity >= 0.68. Otherwise none. Scores rank within one response; match_strength is comparable across queries.",
      no_strong_match:
        "True when no returned result is strong. Treat the results as loosely related candidates, not as the answer.",
      exact_matches:
        "Query identifiers (paths, flags, snake/kebab/camel case, dotted or tag-like tokens) or suggested file paths found literally in the memory.",
      term_coverage:
        "Fraction of distinct query terms found in the memory's content, tags, context, or refs.",
      evidence:
        "Kinds of evidence behind a claim (see enums.evidence); [] means unspecified. add/update reject --certainty verified without at least one kind. Legacy verified rows keep their certainty until re-asserted; doctor lists them as verified_without_evidence. Not embedded.",
      validation_gaps:
        "Known limits of a claim's validation, e.g. unconfirmed intent or untested platforms. --validation-gaps takes one plain-text gap or a JSON array; none clears. Not embedded. --json-min reports validation_gap_count.",
      dropped:
        "update/diff/add --upsert-match: identifiers and sentences of the old content that the new content no longer carries. Updates replace the whole content, so carry valid details over or confirm they are obsolete.",
      review_candidates:
        "update/deprecate/add --upsert-match: other active records that may rely on the changed or retired premise (strong = shares a literal path or identifier). Update or deprecate them too. Minimal output lists review_candidate_ids.",
      snippet:
        "First 140 characters of content in --json-min summaries, for triage before a full get.",
    },
    global_options: {
      pretty:
        "Render human-readable output for machine commands; existing human commands keep their normal output.",
      repo: "--repo <owner/name> (or MACHINE_MEMORY_REPO) targets another repository's memories without changing directory. The flag wins over the variable.",
      allow_new_repo:
        "--allow-new-repo lets add/import write to a --repo that has no memories yet; without it a mistyped slug is refused.",
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
      history: {
        usage: `history <id> [--limit <n>] [--offset <n>]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
        description:
          "List complete previous snapshots for a memory, newest first. Use the current_update_count with restore.",
      },
      size: {
        usage: SIZE_USAGE,
        description:
          "Report the embedding budget for a prospective memory (token count, byte+2 estimate, binding limit) without touching the database. Exit code 1 means it would be rejected.",
      },
      update: {
        usage: UPDATE_USAGE,
        notes:
          "--dry-run prints the per-target size report and any dropped details without writing. A content change returns dropped and review_candidates. Accepts --brief|--json-min|--quiet.",
      },
      restore: {
        usage: `restore <id> --revision <revision_id> --expected-update-count <n>${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
        description:
          "Restore one historical snapshot in place. The expected update count prevents overwriting a newer mutation.",
      },
      deprecate: {
        usage: DEPRECATE_USAGE,
        notes:
          "Returns review_candidates: active records that may rely on the retired premise.",
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
        notes:
          "verified_without_evidence and gotcha_overlap findings carry hints, not suggested commands: only a reviewer knows the right evidence or merge.",
      },
      checkpoint: {
        usage: `checkpoint [--files "src/a.ts,src/b.ts" | --files-json '[...]'] [--query <search_term>] [--since <ISO date>] [--limit <n>]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
        description:
          "End-of-task review: memories written since --since (default 12 hours ago), memories related to the touched files (default: changed files in the Git working tree, else the last commit), review flags, and the five-way classification with commands.",
      },
      verify: { usage: `verify <id> <fact>${DATABASE_BACKEND_USAGE}` },
      diff: {
        usage: `diff <id> <new_content>${DATABASE_BACKEND_USAGE}`,
        notes:
          "Reports term changes plus dropped identifiers and sentences, the same check update applies.",
      },
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
      evidence: EVIDENCE_KINDS,
      status: MEMORY_STATUSES,
    },
    what_to_store: [
      "Architectural decisions (e.g. 'we chose Drizzle over Prisma because...')",
      "Project references/docs (e.g. 'API fields for run status: running, errored, finished')",
      "Point-in-time status snapshots (e.g. 'coverage audit: 82%, missing sdk/')",
      "Non-obvious gotchas (e.g. 'the users table uses UUIDs, not auto-increment')",
      "Environment/tooling notes (e.g. 'run bun run db:migrate after pulling main')",
      "User preferences (e.g. 'user prefers explicit error handling over try/catch')",
    ],
  };
}

/**
 * What each command's focused help includes beyond its own entry. Commands
 * not listed get their entry plus the shared database and global options.
 */
const HELP_FOCUS = {
  add: {
    sections: ["embedding_budget"],
    fields: [
      "conflict_count",
      "status_cascade_count",
      "tokens",
      "evidence",
      "validation_gaps",
      "dropped",
      "review_candidates",
    ],
    enums: ["memory_type", "certainty", "evidence", "status"],
  },
  update: {
    sections: ["embedding_budget"],
    fields: [
      "tokens",
      "evidence",
      "validation_gaps",
      "dropped",
      "review_candidates",
    ],
    enums: ["memory_type", "certainty", "evidence"],
  },
  size: {
    sections: ["embedding_budget"],
    fields: ["tokens"],
    enums: ["memory_type", "certainty"],
  },
  deprecate: { sections: [], fields: ["review_candidates"], enums: [] },
  diff: { sections: [], fields: ["dropped"], enums: [] },
  query: {
    sections: [],
    fields: [
      "match_strength",
      "no_strong_match",
      "exact_matches",
      "term_coverage",
      "snippet",
      "evidence",
    ],
    enums: ["memory_type", "certainty", "status"],
  },
  suggest: {
    sections: [],
    fields: [
      "match_strength",
      "no_strong_match",
      "exact_matches",
      "term_coverage",
      "snippet",
      "evidence",
    ],
    enums: ["memory_type", "certainty", "status"],
  },
  sweep: {
    sections: [],
    fields: ["match_strength", "no_strong_match", "exact_matches", "snippet"],
    enums: [],
  },
  checkpoint: {
    sections: [],
    fields: ["match_strength", "snippet", "evidence", "validation_gaps"],
    enums: ["evidence"],
  },
  get: { sections: [], fields: ["evidence", "validation_gaps"], enums: [] },
  list: {
    sections: [],
    fields: ["evidence", "validation_gaps"],
    enums: ["memory_type", "certainty", "status"],
  },
  export: { sections: [], fields: [], enums: ["memory_type", "certainty"] },
} as const satisfies {
  [command: string]: {
    sections: readonly ["embedding_budget"] | readonly [];
    fields: readonly string[];
    enums: readonly string[];
  };
};

function pick(source: JsonObject, keys: readonly string[]): JsonObject {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => keys.includes(key)),
  );
}

/** Help for one command; the full catalog for `help` or an unknown name. */
export function commandHelpPayload(command: string | undefined): JsonObject {
  const full = helpPayload();
  const entry = Object.entries(full.commands).find(
    ([name]) => name === command,
  );
  if (command === undefined || command === "help" || entry === undefined) {
    return full;
  }
  const focus = Object.entries(HELP_FOCUS).find(
    ([name]) => name === command,
  )?.[1];
  const usage = JSON.stringify(entry[1]);
  const payload: JsonObject = {
    name: full.name,
    version: full.version,
    command,
    commands: { [command]: entry[1] },
    global_options: full.global_options,
    full_help: "machine-memory help",
  };
  if (usage.includes("--local|--remote")) {
    payload.database = full.database;
  }
  if (focus !== undefined) {
    if (focus.sections.length > 0) {
      payload.embedding_budget = full.embedding_budget;
    }
    if (focus.fields.length > 0) {
      payload.output_fields = pick(full.output_fields, focus.fields);
    }
    if (focus.enums.length > 0) {
      payload.enums = pick(full.enums, focus.enums);
    }
  }
  return payload;
}
