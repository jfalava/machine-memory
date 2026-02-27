# machine-memory

Persistent project-scoped memory for LLM agents. Stores facts, decisions, conventions, and gotchas in a local SQLite database so future agent sessions can recall them.

By default, the database lives at `.agents/memory.db` relative to the project root (git-ignored by default). You can override it with `MACHINE_MEMORY_DB_PATH` (absolute or cwd-relative path).

## Install

Download the latest binary for your platform from [Releases](https://github.com/jfalava/machine-memory/releases) and place it somewhere on your `$PATH`.

Or build from source:

```sh
bun install
bun run build
```

## Usage

All output is JSON — designed to be parsed by an LLM agent, not read by a human.

Run `machine-memory help` to get full usage information as JSON.

### Commands

```sh
# Store a memory
machine-memory add "Auth uses JWT with RS256" --tags "auth,architecture" --context "Found in src/auth/jwt.ts"
machine-memory add "Auth uses JWT with RS256" --no-conflicts
machine-memory add "Auth uses JWT with RS256" --brief
machine-memory add "Auth uses JWT with RS256" --json-min

# Store richer metadata (type, certainty, provenance, refs, TTL hint)
machine-memory add "Sessions are cached for 5m" \
  --tags "auth,cache" \
  --type "decision" \
  --certainty "hard" \
  --source-agent "gpt-5-codex" \
  --refs '["docs/adr/session-cache.md","https://github.com/org/repo/pull/123"]' \
  --expires-after-days 30

# Full-text search
machine-memory query "auth"
machine-memory query "auth" --type "decision" --certainty "hard"
machine-memory query "auth" --brief
machine-memory query "auth" --json-min

# List all memories (or filter by tag)
machine-memory list
machine-memory list --tags "database"
machine-memory list --type "gotcha" --certainty "soft"

# Get a single memory by ID
machine-memory get 1

# Update a memory
machine-memory update 1 "Auth uses JWT with RS256, keys in VAULT_* env vars" --tags "auth,security"
machine-memory update 1 "Auth uses JWT with RS256" --certainty "hard" --updated-by "gpt-5-codex"

# Deprecate / supersede stale memories
machine-memory deprecate 12
machine-memory deprecate 12 --superseded-by 42

# Path-based suggestions for agents at task start
machine-memory suggest --files "src/auth/jwt.ts,src/middleware/session.ts"
machine-memory suggest --files "src/auth/jwt.ts,src/middleware/session.ts" --brief
machine-memory suggest --files "src/auth/jwt.ts,src/middleware/session.ts" --json-min

# Apply/repair schema migration explicitly
machine-memory migrate

# Coverage / health checks
machine-memory coverage --root .
machine-memory gc --dry-run
machine-memory stats

# Bulk sync
machine-memory import memories.json
machine-memory export
machine-memory export --type "decision" --certainty "hard" --since "2026-02-01T00:00:00Z"

# Delete a memory
machine-memory delete 1

# Show version
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
- `memory_type` (`decision | convention | gotcha | preference | constraint`)
- `certainty` (`hard | soft | uncertain`, defaults to `soft`)
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
- `query` and `suggest` return a numeric `score` and are sorted descending by score.
- Empty `query` results return a diagnostic object with `derived_terms`, `filters`, and `hints`.
- Reads open the DB in query-only mode; schema writes run via write commands and `migrate`.

### Command Reference

- `add <content>`
  - Flags: `--tags`, `--context`, `--type`, `--certainty`, `--source-agent`, `--updated-by`, `--refs`, `--expires-after-days`, `--no-conflicts`, `--brief`, `--json-min`
  - Returns inserted memory (plus `potential_conflicts` unless `--no-conflicts`/minimal output)
- `query <search_term>`
  - Flags: `--tags`, `--type`, `--certainty`, `--include-deprecated`, `--brief`, `--json-min`
  - Returns ranked matches with `score`; empty results return diagnostics/hints
- `list`
  - Flags: `--tags`, `--type`, `--certainty`, `--status`, `--include-deprecated`
- `get <id>`
- `update <id> <content>`
  - Flags: `--tags`, `--context`, `--type`, `--certainty`, `--updated-by`, `--refs`, `--expires-after-days <n|null>`
  - Increments `update_count`
- `deprecate <id>`
  - Flags: `--superseded-by <id>`, `--updated-by`
  - Sets status to `deprecated` or `superseded_by`
- `delete <id>`
- `suggest --files "<csv paths>"`
  - Flags: `--brief`, `--json-min`
  - Derives keywords from file paths and runs FTS-based suggestions
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

- `machine-memory add "description" --tags "tag1,tag2" --context "why this matters" --type "decision" --certainty "soft"`

Store: architectural decisions, project conventions, non-obvious gotchas, environment/tooling notes, and user preferences.
Do NOT store: things obvious from reading the code, temporary information, or duplicates of existing memories.

### When to update, deprecate, or delete

- If a memory is outdated, update it: `machine-memory update <id> "new content"`
- If a memory is replaced by a newer one, deprecate it: `machine-memory deprecate <old_id> --superseded-by <new_id>`
- If a memory is wrong or no longer relevant, delete it: `machine-memory delete <id>`
```

## Self-update

The binary can update itself:

```sh
machine-memory upgrade
```

This checks GitHub releases for a newer version, downloads the correct binary for your platform, and replaces itself in-place.
