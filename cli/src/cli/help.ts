import {
  CLI_LIMIT_MAX,
  EVIDENCE_KINDS,
  MATCH_THRESHOLDS,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  NEAR_DUPLICATE_THRESHOLD,
  REPLACEMENT_MIN_OVERLAP,
  UPSERT_DEFAULT_MIN_SCORE,
  UPSERT_MIN_SIMILARITY,
} from "@machine-memory/contract";

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
  INDEX_USAGE,
  REINDEX_USAGE,
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
        "A memory's embedded text is at most 2,000 UTF-8 bytes. Longer writes are refused before anything is stored, and the error says how many bytes to remove.",
      composed_text:
        "content, plus a Tags: line and a Context: line when present. Memory type, status, and certainty are not counted.",
      preflight:
        'machine-memory size "<text>" [--tags <tags>] [--context <context>] reports bytes, remaining_bytes, over_by_bytes, and the bytes each field uses. add and update accept --dry-run for the same report without writing.',
    },
    output_fields: {
      related:
        "add: active memories that strongly match the new one, listed so you can check it does not repeat or contradict them. Absent when none match strongly. --brief reports related_count.",
      upsert_match:
        "add --upsert-match: the record the query matched. rank_score (0 to 100) is how well the record matches the query; text_overlap (0 to 1) is the share of terms the record and the new content have in common. A match is strong only when both pass their bars. shared_identifiers lists the paths, flags and symbols both texts name. --dry-run reports the same record as would_match.",
      replacement:
        "update/add --dry-run, when content is replaced: action (update or refuse), text_overlap with the stored content, orphaned_identifiers (names the new content drops that no other active memory mentions) and held_elsewhere (dropped names another memory still carries, with its ids).",
      path_tag_matches:
        "add --path: for each path, the tag-map prefix that matched and the tags it added. A path that matches no prefix is reported on stderr and adds no tags.",
      status_cascade_count:
        "For a newly added status memory: how many other active status memories share its tags and are candidates to deprecate (see status_cascade.suggested_command).",
      size: "On a successful add or update: bytes the record's embedded text uses and remaining_bytes of the 2,000-byte limit. size and --dry-run return the full report with over_by_bytes and per-field parts.",
      match_strength: `Absolute per-result relevance for query/suggest/sweep. strong: every query identifier found literally (or one plus strong term coverage), at least 60% of query terms, a suggested file path or file name, or semantic similarity >= ${MATCH_THRESHOLDS.strongSemantic}. weak: a partial identifier hit, at least 30% of terms, or similarity >= ${MATCH_THRESHOLDS.weakSemantic}. Otherwise none. Scores rank within one response; match_strength is comparable across queries.`,
      no_strong_match:
        "True when no returned result is strong. Treat the results as loosely related candidates, not as the answer.",
      exact_matches:
        "Query identifiers (paths, flags, snake/kebab/camel case, dotted or tag-like tokens) or suggested file paths found literally in the memory.",
      term_coverage:
        "Fraction of distinct query terms found in the memory's content, tags, context, or refs.",
      matched_terms:
        "Full output only: the query terms found in the memory. matched_in lists the fields that hold them or an exact match: content, tags, context or refs.",
      generic_files:
        "suggest/sweep: the manifests and lockfiles among the files. Their names were not searched, so an empty result for them does not mean nothing is recorded.",
      evidence:
        "Kinds of evidence behind a claim (see enums.evidence); [] means unspecified. add/update reject --certainty verified without at least one kind. Legacy verified rows keep their certainty until re-asserted; doctor lists them as verified_without_evidence. Not embedded.",
      validation_gaps:
        "Known limits of a claim's validation, e.g. unconfirmed intent or untested platforms. --validation-gaps takes one plain-text gap or a JSON array and replaces the stored gaps; none clears. update --add-gap and --remove-gap change single gaps. Not embedded. --json-min reports validation_gap_count.",
      dropped:
        "update/diff/add --upsert-match/add --update-id: identifiers and sentences of the old content that the new content no longer carries. Updates replace the whole content, so carry valid details over or confirm they are obsolete.",
      review_candidates:
        "update/deprecate/add --upsert-match: other active records that may rely on the changed or retired premise (strong = shares a literal path or identifier). Update or deprecate them too. Minimal output lists review_candidate_ids.",
      results:
        "get, query, list, suggest, sweep and export all print one object: repository, count, the fields of that command, then results, an array even for one memory or none. The output mode changes only what each result carries: the whole memory by default, a summary with --json-min, the id alone with --quiet. --brief prints one text line per memory instead.",
      snippet:
        "First 140 characters of content in --json-min summaries, for triage before a full get. get --json-min carries the whole content instead.",
      repository:
        "The repository slug a read ran against; the first field of every read's output.",
      source_agent:
        "source_agent is who created a memory and last_updated_by who last changed it, as <agent>:<thread>, such as amp:T-1234. add, update and deprecate fill them from the agent harness they run under (Amp, Claude Code, Codex), or from MACHINE_MEMORY_AGENT when it is set; --source-agent and --updated-by override both. list, export and checkpoint take --mine to read only what this session wrote, or --by <writer>, where a bare agent name such as amp covers every thread of that agent.",
      total_count:
        "list: how many memories match the filters, of which this page holds count. has_more is true while offset + count is below it; pass --offset to read the next page.",
      warning:
        "A read found nothing and the repository has no memories at all: the slug is probably not the one the memories were written under. Lists repositories that do have memories. Also printed on stderr.",
      found_elsewhere:
        "get: missing_ids lists requested ids the repository does not hold; found_elsewhere lists those another repository holds, as { id, repository }. Ids are unique across repositories. A miss is not an error: get exits 0 with count 0.",
      stderr:
        "Lines starting with 'machine-memory:' report dropped content, review candidates, a repository without memories, or a stale AGENTS.md block, in every output mode, so filtering stdout cannot hide them.",
    },
    global_options: {
      pretty:
        "Render human-readable output for machine commands; existing human commands keep their normal output.",
      repo: "--repo <slug> (or MACHINE_MEMORY_REPO) targets another repository's memories without changing directory. A slug is the remote's path: owner/name, @namespace/name, or group/subgroup/name. The flag wins over the variable. Without either, the slug is the one init pinned in .agents/machine-memory.json, and without a pin it is the path of the origin remote.",
      ascii:
        "--ascii, on any command, prints only 7-bit ASCII: every other character becomes a \\uXXXX escape. JSON parsers read the escapes back as the original text, so nothing is lost. Use it when a shell or tool treats the output as binary.",
      allow_new_repo:
        "--allow-new-repo lets add/import start a repository that has no memories yet. Without it they refuse when the database holds other repositories, whether the slug came from --repo or from the Git remote, and list those repositories.",
    },
    commands: {
      help: "help [<command>|workflow]: this catalog, one command, or the memory workflow in full (scan, what to store, writes, evidence, delegation, checkpoint).",
      add: {
        usage: ADD_USAGE,
        notes: `A plain add is refused when an active memory already states nearly the same thing (text_overlap at or above ${NEAR_DUPLICATE_THRESHOLD}); the error names that memory. --update-id <id> replaces that memory's content and keeps the fields you omit. --create-new says you read the existing memories and this is a different fact. --upsert-match <query> finds the target by topic: a strong match (rank_score at or above --upsert-threshold <0-100>, default ${UPSERT_DEFAULT_MIN_SCORE}, and text_overlap at or above ${UPSERT_MIN_SIMILARITY}) is updated in place, a weak match is refused with up to three candidates, and no match creates a record. Replacing content is refused when it drops a path, flag or symbol that no other active memory mentions; carry the detail over, or pass --allow-drop when it is obsolete. --dry-run prints the action the real write takes (update, create or refuse), the reason for a refusal in note, and the size report, without writing; it exits 1 when the write would be refused. --path takes one path or several separated by commas. Content that is empty, 'null' or 'undefined' is refused.`,
      },
      query: {
        usage: `query <search_term> [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--include-deprecated] [--limit <n>] [--semantic|--hybrid] [--explain-score]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
        notes: `--limit defaults to ${SEARCH_LIMIT_DEFAULT}; the most is ${CLI_LIMIT_MAX}, or ${SEARCH_LIMIT_MAX} with --semantic or --hybrid. suggest and sweep use the same default. query, suggest and sweep leave out a status memory past its expiry unless --type status is given; list and get still return it, and doctor reports it as expired_status.`,
      },
      list: {
        usage: `list [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--status <status>] [--include-deprecated] [--limit <n>] [--offset <n>] [--by <writer> | --mine]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
        notes: `Newest first. --limit defaults to ${CLI_LIMIT_MAX}, which is also the most. Read on with --offset while has_more is true.`,
      },
      get: {
        usage: `get <id|id,id,...>${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
        notes:
          "Prints the same object for one id and for several; the memories are in results. --json-min keeps the whole content of each memory.",
      },
      history: {
        usage: `history <id> [--limit <n>] [--offset <n>]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
        description:
          "List complete previous snapshots for a memory, newest first. Use the current_update_count with restore.",
      },
      size: {
        usage: SIZE_USAGE,
        description:
          "Report the size of a prospective memory against the 2,000-byte limit without touching the database. Exit code 1 means the write would be refused.",
      },
      update: {
        usage: UPDATE_USAGE,
        notes: `Only the fields you give change. Leave the content out to change only metadata, on one id or several: update 5,6 --type decision. --add-tags and --remove-tags edit the stored tags, --add-gap and --remove-gap edit the stored validation gaps, and --clear-context empties the context; --tags, --context and --validation-gaps replace the stored value instead. Content replaces the whole stored content of exactly one memory. It is refused when it drops a path, flag or symbol that no other active memory mentions, or shares less than ${REPLACEMENT_MIN_OVERLAP} of its terms with the stored content: carry the detail over, add a new memory when this is a different fact, or pass --allow-drop when the detail is obsolete. --expected-update-count <n> refuses the update when the stored update_count differs from the one you read. --dry-run prints the size report, dropped details and the replacement decision without writing, and exits 1 when the write would be refused. A content change returns dropped and review_candidates, and reports them on stderr. Content that is empty, 'null' or 'undefined' is refused. Accepts --brief|--json-min|--quiet.`,
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
        notes:
          "Manifests and lockfiles (package.json, bunfig.toml, *.lock) are named in memories about unrelated things. suggest searches their directories, not their names, and lists them in generic_files. Use query to find a memory about such a file.",
      },
      sweep: {
        usage: `sweep (--files "src/a.ts,src/b.ts" | --files-json '["src/a.ts","src/b.ts"]') [--query <search_term>] [--tags <tag>] [--limit <n>]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
      },
      doctor: {
        usage: `doctor [--only <kind,kind>] [--since <ISO date>]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
        notes:
          "--only keeps the named finding kinds or groups. --since keeps findings that involve a memory changed since that date, which separates new findings from the backlog. --json-min prints counts_by_kind and ids_by_kind instead of the findings. canonical_thread_overlap and similar_tags describe the collection, not a defect in one record: they are counted in informational_counts and listed only with --only. verified_without_evidence and gotcha_overlap findings carry hints, not suggested commands: only a reviewer knows the right evidence or merge.",
      },
      checkpoint: {
        usage: `checkpoint [--files "src/a.ts,src/b.ts" | --files-json '[...]'] [--query <search_term>] [--since <ISO date>] [--limit <n>] [--by <writer> | --mine] [--last-commit]${DATABASE_BACKEND_USAGE} [--brief|--json-min|--quiet]`,
        description:
          "End-of-task review: the five-way classification with commands, memories written since --since (default 12 hours ago), memories related to the touched files, and review flags. files_source says where the files came from: flag, working_tree (changed and untracked files), last_commit (only with --last-commit, for a task that already committed), or none, when the tree is clean and no related memories were looked up.",
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
      import: {
        usage: `import <memories.json> [--review]${DATABASE_BACKEND_USAGE}`,
        notes:
          "Takes the output of export, or a JSON array of memories. Without --review it restores a backup: every entry is checked first, and one invalid entry stops the import before anything is written; an entry that strongly matches an active memory is reported as conflict with those memories in related, and is not inserted. With --review it writes a candidate file from add --emit-candidate: each candidate passes or fails on its own, with the checks of a plain add (size limit, evidence for verified, near-duplicate). results lists each as written with its id, or declined with a reason and a note to hand back to the agent that found it.",
      },
      reindex: {
        usage: REINDEX_USAGE,
        description:
          "Queue records for the semantic index again: the whole current repository by default, only records whose last index write failed with --failed-only, the given records with --id, or every repository with --all-repos. Returns at once; watch progress with index status.",
      },
      index: {
        usage: INDEX_USAGE,
        description:
          "Report where records stand in the semantic index: pending (written, not indexed yet), retrying (last index write failed and will be tried again), parked (cannot be indexed until the record changes or reindex re-queues it), oldest_pending_seconds, and failures grouped by error with record ids. stats reports the same under index.",
      },
      export: {
        usage: `export [--tags <tag>] [--type <memory_type>] [--certainty <certainty>] [--since <ISO date>] [--by <writer> | --mine]${DATABASE_BACKEND_USAGE}`,
        notes:
          "Prints every matching memory in results, newest first, with no limit. import reads that output.",
      },
      version: { usage: "version" },
      upgrade: { usage: "upgrade" },
      init: {
        usage: "init (--local|--remote|--mcp)",
        description:
          "Creates or replaces the managed machine-memory block in the current directory's AGENTS.md file (CLI local/remote or MCP-only), and pins this checkout's repository slug in .agents/machine-memory.json. Commit the pin: it keeps the slug the same when the origin remote differs between clones or changes. init --repo <slug> pins another slug.",
      },
      repo: {
        list: {
          usage: `repo list${DATABASE_BACKEND_USAGE}`,
          description:
            "Every repository with memories and its total, active, deprecated and superseded counts, plus current (the slug this checkout resolves to), source (explicit, pin or origin) and pin.",
        },
        merge: {
          usage: `repo merge <from> <into> [--dry-run]${DATABASE_BACKEND_USAGE}`,
          description:
            "Moves a repository's active memories under another slug, for memories written under two slugs of one project. It copies them into <into> under new ids and deprecates the originals; id_map lists each { from_id, into_id }. Deprecated and superseded memories stay in <from>. Run it again after an interruption: a memory already copied is not copied twice.",
        },
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
        status: {
          usage: "remote status",
          description:
            "Asks the configured Worker for its version and schema level and prints them next to this CLI's version: cli_version, worker_version, versions_match, authenticated, schema_level and schema_expected, with a note that names the fix when they differ. Run it first when a --remote command fails in a way the command does not explain. Exits 1 when the Worker is unreachable, refuses the token, or is too old to answer.",
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
      "source_agent",
      "related",
      "upsert_match",
      "replacement",
      "path_tag_matches",
      "status_cascade_count",
      "size",
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
      "source_agent",
      "size",
      "evidence",
      "validation_gaps",
      "dropped",
      "replacement",
      "review_candidates",
    ],
    enums: ["memory_type", "certainty", "evidence"],
  },
  size: {
    sections: ["embedding_budget"],
    fields: ["size"],
    enums: [],
  },
  deprecate: {
    sections: [],
    fields: ["review_candidates", "source_agent"],
    enums: [],
  },
  diff: { sections: [], fields: ["dropped"], enums: [] },
  query: {
    sections: [],
    fields: [
      "results",
      "match_strength",
      "no_strong_match",
      "exact_matches",
      "term_coverage",
      "matched_terms",
      "snippet",
      "evidence",
    ],
    enums: ["memory_type", "certainty", "status"],
  },
  suggest: {
    sections: [],
    fields: [
      "results",
      "match_strength",
      "no_strong_match",
      "exact_matches",
      "term_coverage",
      "matched_terms",
      "generic_files",
      "snippet",
      "evidence",
    ],
    enums: ["memory_type", "certainty", "status"],
  },
  sweep: {
    sections: [],
    fields: [
      "results",
      "match_strength",
      "no_strong_match",
      "exact_matches",
      "snippet",
    ],
    enums: [],
  },
  checkpoint: {
    sections: [],
    fields: [
      "source_agent",
      "match_strength",
      "snippet",
      "evidence",
      "validation_gaps",
    ],
    enums: ["evidence"],
  },
  get: {
    sections: [],
    fields: ["results", "found_elsewhere", "evidence", "validation_gaps"],
    enums: [],
  },
  list: {
    sections: [],
    fields: [
      "results",
      "total_count",
      "snippet",
      "source_agent",
      "evidence",
      "validation_gaps",
    ],
    enums: ["memory_type", "certainty", "status"],
  },
  export: {
    sections: [],
    fields: ["results", "source_agent"],
    enums: ["memory_type", "certainty"],
  },
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
      'Change a record with update <id> "<whole new content>" <backend>, or update --match "<topic>" when the id is unknown. Content replaces the whole stored content: read the record first and carry over the details that still hold, such as source paths, versions and caveats. --expected-update-count <n> refuses the update when the record changed since you read it.',
      "Change only metadata by leaving the content out: update <id> --type decision, --add-tags, --remove-tags, --add-gap, --remove-gap, --clear-context, --certainty with --evidence. The stored content is untouched.",
      "A content replacement is refused when it drops a path, flag or symbol that no other active record mentions, or shares almost nothing with the stored content. The error lists what would be lost. Carry it over, add a new record and deprecate the old one when the fact changed, or pass --allow-drop when the detail is obsolete.",
      'Create a record with add "<content>" --upsert-match "<topic>" <backend>. A strong match is updated in place. A weak match is refused with up to three candidates, and a plain add is refused when a record already states nearly the same thing. Read the record the error names, then repeat the add with --update-id <id> when it states the same fact, or --create-new when yours is a different fact.',
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
      'A child with the CLI can return its candidates as a file: add "<content>" --emit-candidate <file> <backend>, with the flags of a real add. It checks the memory the way add does, writes nothing to the database, and appends the memory to <file>. The parent then runs import <file> --review <backend>, which writes the candidates that pass and lists the declined ones with reasons.',
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
