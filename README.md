# machine-memory

`machine-memory` is a local, project-scoped memory store for LLM agents. It
keeps decisions, conventions, gotchas, references, preferences, constraints,
and status snapshots in SQLite under `.agents/memory.db`.

The CLI is intentionally agent-first: commands return JSON by default and
support compact output for shell pipelines.

## Install

Download the binary for your platform from the latest GitHub release and put
it on `PATH`:

```sh
machine-memory version
```

On macOS and Linux, ensure the downloaded file is executable:

```sh
chmod +x machine-memory-*
```

The macOS release is an ad-hoc signed Apple Silicon binary. If macOS blocks a
downloaded binary, approve it in System Settings → Privacy & Security or
remove the quarantine attribute after verifying the download.

## Database

By default, the database is `.agents/memory.db` relative to the current
working directory. Override it with `MACHINE_MEMORY_DB_PATH`:

```sh
MACHINE_MEMORY_DB_PATH=/tmp/project-memory.db machine-memory list
```

For a shared remote database, set `MACHINE_MEMORY_DB_URL` to the `/query`
endpoint of the D1 adapter and provide the same bearer token used when the
adapter was deployed:

```sh
MACHINE_MEMORY_DB_URL=https://memory-api.example.workers.dev/query \
MACHINE_MEMORY_DB_TOKEN=... machine-memory list
```

On a developer machine, save those credentials interactively in the OS
keychain instead:

```sh
machine-memory remote setup
```

The setup command also accepts `--url <worker-url>` and `--token <token>`.

The adapter is an Alchemy-managed Cloudflare Worker in `remote-db/d1`. It
creates a D1 database, applies the memory schema and FTS5 triggers, and uses
`@effect/sql-d1` for remote reads. Deploy it with a token in the environment:

```sh
cd remote-db/d1
MACHINE_MEMORY_DB_TOKEN=... bun run deploy
```

Use the Worker URL printed by Alchemy with `/query` appended. The remote
backend takes precedence over `MACHINE_MEMORY_DB_PATH`; omitting
`MACHINE_MEMORY_DB_URL` keeps the existing local SQLite behavior.

Local write commands create the database and apply schema migrations. The
remote adapter applies its migrations during deployment. Run the explicit
migration command after upgrading a local database or when a read command
reports an outdated schema:

```sh
machine-memory migrate
```

## Core workflow

Store a durable decision:

```sh
machine-memory add \
  "Use Effect for CLI effects" \
  --type decision \
  --certainty verified \
  --tags architecture,cli
```

Retrieve memories by topic or file context:

```sh
machine-memory query "database locking"
machine-memory suggest --files "src/db.ts,cli/src/effect/database.ts"
```

Use compact formats when an agent only needs identifiers or a small summary:

```sh
machine-memory query "database" --json-min
machine-memory list --brief
machine-memory suggest --files "src/db.ts" --quiet
```

Fetch selected records in one call:

```sh
machine-memory get 12,18,21
```

Update or deprecate a canonical record by ID or a precise match:

```sh
machine-memory update --match "Use Effect for CLI effects" \
  "Use Effect for all CLI effects" \
  --updated-by agent
machine-memory deprecate 12 --superseded-by 21
```

## Commands

- `add`, `update`, `deprecate`, `delete`: write and lifecycle operations.
- `query`, `list`, `get`: direct retrieval.
- `suggest`, `sweep`: file-aware retrieval using full-text and path context.
- `doctor`, `verify`, `diff`, `coverage`, `gc`: maintenance and quality checks.
- `stats`, `import`, `export`, `migrate`: database administration.
- `tag-map`: map path prefixes to reusable tags.
- `update-agents-md`: add the current memory workflow instructions to
  `AGENTS.md`.
- `upgrade`: download and install the latest matching release binary.

Run `machine-memory help` for the complete flag reference.

## Memory model

Supported types are `decision`, `convention`, `gotcha`, `preference`,
`constraint`, `reference`, and `status`. Certainty is `verified`, `inferred`,
or `speculative`. Status memories can have an expiry:

```sh
machine-memory add "Release audit is blocked on signing" \
  --type status --expires-after-days 14
```

Use `doctor` during maintenance to find duplicates, stale status memories,
tag problems, malformed references, and type/expiry hygiene issues. It reports
suggested commands rather than changing records automatically.

## Development

Requirements: Bun.

```sh
bun install
bun run --cwd cli check
bun run --cwd cli typecheck
bun run --cwd cli build
```

Build release targets with:

```sh
bun run --cwd cli build:all
```

Upgrade requests use a 15-second timeout by default. Override it when needed:

```sh
MACHINE_MEMORY_UPGRADE_TIMEOUT_MS=30000 machine-memory upgrade
```

The upgrade command supports macOS, Linux, and Windows release assets. On
Windows it schedules replacement after the running executable exits.
