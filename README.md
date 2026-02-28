# machine-memory

Persistent project-scoped memory for LLM agents. Stores facts, decisions, references, status snapshots, and other project context in a local SQLite database so future agent sessions can recall them.

By default, the database lives at `.agents/memory.db` relative to the project root (git-ignored by default). You can override it with `MACHINE_MEMORY_DB_PATH` (absolute or cwd-relative path).

## Install

Download the latest binary for your platform from [Releases](https://github.com/jfalava/machine-memory/releases) and place it somewhere on your `$PATH`.

Or build from source:

```sh
bun install
bun run build
```

## Usage

Default output is JSON — designed to be parsed by an LLM agent.  
`--brief` on `query`, `list`, and `suggest` emits compact text lines for fast scanning.

Run `machine-memory help` (or `machine-memory --help`) to get full usage information as JSON.

### Commands

#### Store a memory

```sh
machine-memory add "Auth uses JWT with RS256" --tags "auth,architecture" --context "Found in src/auth/jwt.ts"
machine-memory add "Auth uses JWT with RS256" --no-conflicts
machine-memory add "Auth uses JWT with RS256" --brief
machine-memory add "Auth uses JWT with RS256" --json-min
machine-memory add "Auth uses JWT with RS256" --quiet
machine-memory add "Schema contract lives in SDK" --path "sdk/src/schema.ts"
machine-memory add --from-file ./docs/api-field-notes.md --type "reference"
```

#### Store richer metadata (type, certainty, provenance, refs, TTL hint)

```sh
machine-memory add "Sessions are cached for 5m" \
  --tags "auth,cache" \
  --type "decision" \
  --certainty "verified" \
  --source-agent "gpt-5-codex" \
  --refs '["docs/adr/session-cache.md","https://github.com/org/repo/pull/123"]' \
  --expires-after-days 30
```

#### Full-text search

```sh
machine-memory query "auth"
machine-memory query "auth" --type "decision" --certainty "verified"
machine-memory query "non-english"
machine-memory query "auth" --brief
machine-memory query "auth" --json-min
machine-memory query "auth" --quiet
```

#### List all memories (or filter by tag)

```sh
machine-memory list
machine-memory list --tags "database"
machine-memory list --type "gotcha" --certainty "inferred"
machine-memory list --brief
```

#### Get a single memory by ID

```sh
machine-memory get 1
```

#### Update a memory

```sh
machine-memory update 1 "Auth uses JWT with RS256, keys in VAULT_* env vars" --tags "auth,security"
machine-memory update 1,4,7 "Resolved after migration v2"
machine-memory update 1 "Auth uses JWT with RS256" --certainty "verified" --updated-by "gpt-5-codex"
machine-memory update --match "views schema" --from-file ./notes/views-schema.md --type "reference"
```

#### Deprecate / supersede stale memories

```sh
machine-memory deprecate 12
machine-memory deprecate 1,4,7 --superseded-by 12
machine-memory deprecate 12 --superseded-by 42
machine-memory deprecate --match "legacy views status fields"
```

#### Verify inferred facts against stored memory

```sh
machine-memory verify 12 "Auth currently uses RS256 JWT signatures"
machine-memory diff 12 "Auth now uses EdDSA JWT signatures"
```

#### Path-to-tag mapping for consistent tagging

```sh
machine-memory tag-map set "sdk/src/schema.ts" "schema,types"
machine-memory tag-map suggest "sdk/src/schema.ts"
machine-memory tag-map list
machine-memory tag-map delete "sdk/src/schema.ts"
```

#### Path-based suggestions for agents at task start

```sh
machine-memory suggest --files "src/auth/jwt.ts,src/middleware/session.ts"
machine-memory suggest --files "src/auth/jwt.ts,src/middleware/session.ts" --brief
machine-memory suggest --files "src/auth/jwt.ts,src/middleware/session.ts" --json-min
machine-memory suggest --files-json '["src/app/blog/$slug.tsx","src/app/blog/[slug]/page.tsx"]'
machine-memory suggest --files "src/auth/jwt.ts,src/middleware/session.ts" --quiet
```

#### Apply/repair schema migration explicitly

```sh
machine-memory migrate
```

#### Coverage / health checks

```sh
machine-memory coverage --root .
machine-memory gc --dry-run
machine-memory stats
```

#### Bulk sync

```sh
machine-memory import memories.json
machine-memory export
machine-memory export --type "decision" --certainty "verified" --since "2026-02-01T00:00:00Z"
```

#### Delete a memory

```sh
machine-memory delete 1
```

#### Show version

```sh
machine-memory version

# Self-update to latest release
machine-memory upgrade
```

### Memory Schema (JSON fields)

Each stored memory includes the original fields plus structured metadata:

- `id`
- `content`
- `tags` (comma-separated string)
- `context`
- `memory_type` (`decision | convention | gotcha | preference | constraint | reference | status`)
- `certainty` (`verified | inferred | speculative`, defaults to `inferred`)
- `status` (`active | deprecated | superseded_by`, defaults to `active`)
- `superseded_by` (ID or `null`)
- `source_agent`
- `last_updated_by`
- `update_count`
- `refs` (JSON array in CLI output; stored internally as JSON string)
- `expires_after_days` (TTL hint; no auto-deprecation)
- `created_at`
- `updated_at`

Notes:

- `query`, `list`, and `export` return only active memories by default.
- Use `--include-deprecated` (or `--status ...` on `list`) to inspect deprecated/superseded entries.
- `add` returns `potential_conflicts` by default; use `--no-conflicts` to skip conflict search.
- Adding a new `--type status` memory with overlapping tags returns `status_cascade` with a suggested `deprecate` command.
- `query` and `suggest` return a numeric `score` and are sorted descending by score.
- `--brief` lines use: `[ID] <Certainty> <Type>: <Content> (#Tags)`.
- Empty `query` results return a diagnostic object with `derived_terms`, `filters`, and `hints`.
- Reads open the DB in query-only mode; schema writes run via write commands and `migrate`.
- For shell-expanded paths like `$slug.tsx`, prefer single quotes or `--files-json`.

### Command Reference

- `add (<content> | --from-file <path>)`
  - Flags: `--tags`, `--path`, `--context`, `--type`, `--certainty`, `--source-agent`, `--updated-by`, `--refs`, `--expires-after-days`, `--from-file`, `--no-conflicts`, `--brief`, `--json-min`, `--quiet`
  - Returns inserted memory (plus `potential_conflicts` unless `--no-conflicts`/minimal output)
  - For `--type status`, returns `status_cascade` when older active status memories share tags
- `query <search_term>`
  - Flags: `--tags`, `--type`, `--certainty`, `--include-deprecated`, `--brief`, `--json-min`, `--quiet`
  - Returns ranked matches with `score`; empty results return diagnostics/hints
- `list`
  - Flags: `--tags`, `--type`, `--certainty`, `--status`, `--include-deprecated`, `--brief`
- `get <id>`
- `update (<id|id,id,...> | --match <query>) (<content> | --from-file <path>)`
  - Flags: `--tags`, `--context`, `--type`, `--certainty`, `--updated-by`, `--refs`, `--expires-after-days <n|null>`, `--match`, `--from-file`
  - Increments `update_count`
- `deprecate (<id|id,id,...> | --match <query>)`
  - Flags: `--superseded-by <id>`, `--updated-by`, `--match`
  - Sets status to `deprecated` or `superseded_by`
- `delete <id|id,id,...>`
- `suggest --files "<csv paths>"`
  - Alternate input: `--files-json '["path/one.ts","path/two.ts"]'` (shell-safe for `$` paths)
  - Flags: `--brief`, `--json-min`, `--quiet`
  - Derives keywords from file paths and merges FTS with path-neighborhood matches
- `verify <id> <fact>`
  - Returns `ok: true|false` and `result: consistent|conflict`
- `diff <id> <new_content>`
  - Returns `conflict`, `similarity`, and term-level changes
- `tag-map <list|set|delete|suggest>`
  - Stores path-prefix to tag mappings in `.agents/path-tags.json`
- `migrate`
  - Ensures schema/FTS/triggers are up to date
- `coverage [--root <path>]`
  - Returns `uncovered_paths` and `tag_distribution`
- `gc --dry-run`
  - Returns active memories whose `updated_at + expires_after_days` is in the past
- `stats`
  - Returns totals, breakdowns, tag frequency, stale counts, etc.
- `import <memories.json>`
  - Accepts a JSON array matching the schema and returns per-entry `success | conflict | skip`
- `export`
  - Flags: `--tags`, `--type`, `--certainty`, `--since <ISO date>`
  - Exports active memories by default

### What to store

This is **not** a general-purpose note-taking tool. It's for things an agent needs to remember across sessions:

- **Architectural decisions** — "We chose Drizzle over Prisma because..."
- **Reference docs/specs** — "Runs API status enum: `running | errored | finished`"
- **Status snapshots** — "Coverage audit shows missing memory tags for `sdk/`"
- **Project conventions** — "All API routes return `{ data, error }` shape"
- **Non-obvious gotchas** — "The users table uses UUIDs, not auto-increment"
- **Environment/tooling notes** — "Run `machine-memory migrate` after pulling main"
- **User preferences** — "User prefers explicit error handling over try/catch"

### What to add to your AGENTS.md

Copy this block into your project's `AGENTS.md` (or `CLAUDE.md`, `.cursorrules`, etc.):

```markdown
## Project memory

This project uses `machine-memory` for persistent agent context stored at `.agents/memory.db`.

### Before starting work

- Run `machine-memory suggest --files "<paths you expect to touch>"` to get relevant memories before coding.
- Run `machine-memory query <topic>` to check for relevant context about the area you're working on.
- Run `machine-memory stats` (or `coverage --root .`) as a health check if you're doing larger work.
- Run `machine-memory help` if you need to discover available commands.

### When to store memories

After completing a task, store anything a future agent session would benefit from knowing:

- `machine-memory add "description" --tags "tag1,tag2" --context "why this matters" --type "decision" --certainty "inferred"`

Store: architectural decisions, reference docs/specs, status snapshots, project conventions, non-obvious gotchas, environment/tooling notes, and user preferences.
Do NOT store: things obvious from reading the code, temporary information, or duplicates of existing memories.

### When to update, deprecate, or delete

- If a memory is outdated, update it: `machine-memory update <id> "new content"` or `machine-memory update --match "topic" --from-file ./notes.md`
- If a memory is replaced by a newer one, deprecate it: `machine-memory deprecate <old_id> --superseded-by <new_id>` or `machine-memory deprecate --match "old topic"`
- If a memory is wrong or no longer relevant, delete it: `machine-memory delete <id>`
```

> [!NOTE]
> Add the following to your `.gitignore` (the `.db-shm` and `.db-wal` files are SQLite runtime artifacts):  
> `.agents/memory.db-shm`  
> `.agents/memory.db-wal`

## Self-update

The binary can update itself:

```sh
machine-memory upgrade
```

This checks GitHub releases for a newer version, downloads the correct binary for your platform, and replaces itself in-place.
