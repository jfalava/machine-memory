# machine-memory

Persistent project-scoped memory for LLM agents. Stores facts, decisions, conventions, and gotchas in a local SQLite database so future agent sessions can recall them.

The database lives at `.agents/memory.db` relative to the project root. It's meant to be committed to the repo so any agent working on the project has access to it.

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

# Full-text search
machine-memory query "auth"

# List all memories (or filter by tag)
machine-memory list
machine-memory list --tags "database"

# Get a single memory by ID
machine-memory get 1

# Update a memory
machine-memory update 1 "Auth uses JWT with RS256, keys in VAULT_* env vars" --tags "auth,security"

# Delete a memory
machine-memory delete 1

# Show version
machine-memory version

# Self-update to latest release
machine-memory upgrade
```

### What to store

This is **not** a general-purpose note-taking tool. It's for things an agent needs to remember across sessions:

- **Architectural decisions** — "We chose Drizzle over Prisma because..."
- **Project conventions** — "All API routes return `{ data, error }` shape"
- **Non-obvious gotchas** — "The users table uses UUIDs, not auto-increment"
- **Environment/tooling notes** — "Run `bun db:migrate` after pulling main"
- **User preferences** — "User prefers explicit error handling over try/catch"

### What to add to your AGENTS.md

Copy this block into your project's `AGENTS.md` (or `CLAUDE.md`, `.cursorrules`, etc.):

````markdown
## Project memory

This project uses `machine-memory` for persistent agent context stored at `.agents/memory.db`.

### Before starting work

- Run `machine-memory query <topic>` to check for relevant context about the area you're working on.
- Run `machine-memory list` to see all stored project knowledge.
- Run `machine-memory help` if you need to discover available commands.

### When to store memories

After completing a task, store anything a future agent session would benefit from knowing:

- `machine-memory add "description" --tags "tag1,tag2" --context "why this matters"`

Store: architectural decisions, project conventions, non-obvious gotchas, environment/tooling notes, and user preferences.
Do NOT store: things obvious from reading the code, temporary information, or duplicates of existing memories.

### When to update or delete

- If a memory is outdated, update it: `machine-memory update <id> "new content"`
- If a memory is wrong or no longer relevant, delete it: `machine-memory delete <id>`
````

## Self-update

The binary can update itself:

```sh
machine-memory upgrade
```

This checks GitHub releases for a newer version, downloads the correct binary for your platform, and replaces itself in-place.

## Releasing

1. Bump `VERSION` in `index.ts` and `version` in `package.json`
2. Commit and tag:
   ```sh
   git tag v0.2.0
   git push --tags
   ```
3. GitHub Actions builds binaries for darwin-arm64, darwin-x64, linux-x64, and linux-arm64, then creates a release

## Development

```sh
bun install
bun test        # run tests
bun run build   # compile binary for current platform
```

### Cross-compilation

```sh
bun run build:all  # builds for all platforms into dist/
```

### Environment variables (for testing)

| Variable | Purpose |
|---|---|
| `MACHINE_MEMORY_API_URL` | Override GitHub API base URL |
| `MACHINE_MEMORY_BIN_PATH` | Override binary path for self-update |
