# Agent memory workflow

The database is `.agents/memory.db` relative to the repository root. Run memory commands from that root so the agent and project use the same database and path-tag map.

## Retrieval

Run one focused retrieval command before editing:

```sh
# When the files are known; use exact files, not a directory.
machine-memory suggest --files "src/auth/jwt.ts,src/middleware/session.ts" --tags "area:auth" --json-min

# When only the topic is known.
machine-memory query "JWT key rotation" --json-min

# Only for a deliberate broad audit.
machine-memory list --tags "area:auth" --json-min
```

`--json-min` returns ordered IDs and compact score/type/tag summaries. Fetch only selected records, batching IDs when useful:

```sh
machine-memory get 120,131
```

Use `--brief` when a human needs to read the full candidate sentence. Use `--limit N` when a task needs a smaller or larger candidate set. `sweep` is available for diagnostics, but it combines multiple retrieval strategies and should not be the default pre-edit workflow.

Path mappings make `suggest --files` inherit project tags and make `add --path` consistent:

```sh
machine-memory tag-map set "src/auth" "area:auth,topic:identity"
machine-memory tag-map list
```

## Writing

Store durable decisions, constraints, preferences, references, and non-obvious gotchas. Put exact filenames, storage keys, routes, thresholds, and command names in the first sentence. Do not store facts obvious from the code, routine test results, or temporary progress.

For recurring feature threads, inspect the likely canonical record before using an upsert:

```sh
machine-memory query "auth key rotation" --json-min
machine-memory get 131
machine-memory add "..." --upsert-match "auth key rotation" --type decision
```

Use `--type status` only for temporary work and pair it with `--expires-after-days`. Treat `status_cascade` suggestions as candidates: inspect and verify or diff the proposed replacement before deprecating anything.

## Maintenance

Run these periodically, not on every task:

```sh
machine-memory doctor --json-min
machine-memory gc --dry-run
machine-memory stats
```

Both `.agents/` and `.agents/memory.db` must be writable. SQLite may also need to create journal/WAL sidecar files in `.agents`; direct elevated SQLite access is a recovery workaround, not the normal agent workflow.
