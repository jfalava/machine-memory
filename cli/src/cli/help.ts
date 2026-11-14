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
      repository:
        "The repository slug a read ran against. Object-shaped read output carries it; bare row arrays carry it on each row.",
      warning:
        "A read found nothing and the repository has no memories at all: the slug is probably not the one the memories were written under. Lists repositories that do have memories. Also printed on stderr.",
      found_elsewhere:
        "get: missing ids that exist in another repository, as { id, repository }. Ids are unique across repositories.",
      stderr:
        "Lines starting with 'machine-memory:' report dropped content, review candidates, a repository without memories, or a stale AGENTS.md block, in every output mode, so filtering stdout cannot hide them.",
    },
    global_options: {
      pretty:
        "Render human-readable output for machine commands; existing human commands keep their normal output.",
      repo: "--repo <slug> (or MACHINE_MEMORY_REPO) targets another repository's memories without changing directory. A slug is the remote's path: owner/name, @namespace/name, or group/subgroup/name. The flag wins over the variable. Without it the slug is the path of the origin remote.",
      allow_new_repo:
        "--allow-new-repo lets add/import start a repository that has no memories yet. Without it they refuse when the database holds other repositories, whether the slug came from --repo or from the Git remote, and list those repositories.",
    },
    commands: {
      help: "help [<command>|workflow]: this catalog, one command, or the memory workflow in full (scan, what to store, writes, evidence, delegation, checkpoint).",
      add: {
        usage: ADD_USAGE,
        notes:
          "--dry-run prints the size report and, with --upsert-match, the action the real write takes (update, create or refuse) and the memory that would be matched, without writing; it exits 1 when the write would be refused. With --upsert-match, a best match that fails the strength bar (score below --upsert-threshold <0-100>, default 32, or similarity below 0.62) is refused unless --force (or an interactive confirm) creates a new record. Content that is empty, 'null' or 'undefined' is refused.",
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
          "Replaces the content of exactly one memory; several ids are refused. --expected-update-count <n> refuses the update when the stored update_count differs from the one you read. --dry-run prints the size report and any dropped details without writing. A content change returns dropped and review_candidates, and reports them on stderr. Content that is empty, 'null' or 'undefined' is refused. Accepts --brief|--json-min|--quiet.",
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

/**
 * The memory workflow in full. The AGENTS.md block that `init` writes names
 * each step in one line and points here for the detail.
 */
function workflowHelpPayload(): JsonObject {
  return {
    name: "machine-memory",
    version: VERSION,
    topic: "workflow",
    backend:
      "Every database command takes exactly one of --local or --remote; the AGENTS.md block says which one this repository uses. The examples below write <backend> for it.",
    scan: [
      'Before changing code, run one focused read: suggest --files "a.ts,b.ts" for known files, query "<topic>" for a topic or a task that touches no files (--hybrid on a remote database when wording may differ, --semantic for concepts, plain for exact names and paths), or list --tags "area:..." for a broad audit. Repeat only when the touched paths or the scope change.',
      "Read the full records that bear on the task with get <id,id,...> before relying on them.",
      "Results are ranked candidates, not an exhaustive or authoritative list. Scores only rank results within one response. Use match_strength (strong, weak, none) and exact_matches; no_strong_match means nothing matched well, and 'nothing relevant' is a valid outcome.",
      "A read that prints a warning about a repository without memories ran against the wrong slug: pass --repo <slug> with one of the repositories it lists.",
      "A stored record does not outrank the user: when an explicit instruction contradicts a record, follow the instruction and update the record.",
    ],
    what_to_store: [
      "One fact per record, starting with the command, API path, file path, key, threshold or identifier it is about, so exact searches find it.",
      "Durable knowledge goes in decision, constraint, preference, reference or gotcha records. A surprising library or tool behavior is a gotcha that leads with the library name, version, behavior and fix.",
      "Implementation, delivery and verification state goes in one status record with --expires-after-days, updated instead of duplicated. State exactly where work stands (local only, uncommitted, committed, pushed, deployed) and what verification remains; never describe local work as deployed.",
      "Leave out pixel values, UI state, deploy outcomes, routine test results and anything obvious from the code. Facts about one machine belong in that machine's guidance file, not in a repository's memory.",
      "Prefer --path and tag-map for tags; otherwise use scoped tags such as area:cli,topic:backend,kind:decision.",
    ],
    write: [
      'Check size first: size "<text>" or --dry-run on add and update; both exit 1 when over budget and name the deficit. See embedding_budget in machine-memory help.',
      'Change a record with update <id> "<whole new content>" <backend>, or update --match "<topic>" when the id is unknown. An update replaces the whole content: read the record first and carry over the details that still hold, such as source paths, versions and caveats. --expected-update-count <n> refuses the update when the record changed since you read it.',
      'Create a record with add "<content>" --upsert-match "<topic>" <backend>. A strong match is updated in place; a weak match is refused, because it may be the record you meant: inspect it with --dry-run, then update it by id or pass --force to create a new record.',
      "update --dry-run and diff <id> report dropped identifiers and sentences before writing. After a write, dropped and review_candidates are also reported on stderr.",
      "Recover an overwrite with history <id>, then restore <id> --revision <revision_id> --expected-update-count <current_update_count>, using the current count from history. Delete is permanent and removes history; prefer deprecate.",
    ],
    reconcile: [
      "When a decision changes or is reversed, update or deprecate the other active records that rely on the old premise. Updates and deprecations return review_candidates (strong ones name the same path or identifier): resolve each one or confirm it still holds.",
      "Consolidate overlapping records instead of adding a partly redundant one. Use deprecate <id> --superseded-by <id> when a record is replaced.",
    ],
    evidence: [
      "Set certainty from evidence, not from how well a record describes the code. --certainty verified is rejected without --evidence.",
      "user_requirement: an explicit user requirement or preference. observed_implementation: what the code currently does. verified_mechanism: a confirmed technical mechanism. tested_behavior: end-user behavior exercised in tests or real use.",
      "Seeing that the code does X establishes observed_implementation only, not that X is intended or works on every platform. Record remaining limits with --validation-gaps and keep sources and versions in --refs or --context.",
    ],
    delegation: [
      "The parent agent owns memory. It scans once and passes the relevant record ids and constraints to child agents; a child scans only when its scope differs.",
      "Children do not write memory unless the parent delegates writes to exactly one child. Otherwise they return candidates: the finding, its evidence (file paths, commands, versions, test output), the evidence kind and related record ids.",
    ],
    checkpoint: [
      "Before the final response, run checkpoint <backend> --json-min: it lists the records written since --since (default 12 hours), the records related to the touched files, and review flags.",
      "Classify every validated finding of the task, including child results and mechanisms found while investigating approaches that were later abandoned: already covered (cite the id; change it only when evidence, scope or wording is wrong), new durable knowledge (add), superseded or conflicting (update or deprecate, including dependents), transient status (one expiring status record), or intentionally omitted (with a reason).",
    ],
    maintenance: [
      "Run doctor during maintenance, not every task, and review its suggestions before applying them.",
      "On a remote database, records are canonical and vectors are a retrieval index that syncs after each write; run reindex --remote only after provisioning or changing the index or model.",
    ],
    full_help: "machine-memory help",
  };
}

/** Help for one command or the workflow topic; the full catalog for `help` or an unknown name. */
export function commandHelpPayload(command: string | undefined): JsonObject {
  if (command === "workflow") {
    return workflowHelpPayload();
  }
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
