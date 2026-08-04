<!-- machine-memory:start -->
## Project memory

This project uses `machine-memory` with a shared remote Worker-backed database.
Remote credentials are stored in the OS keychain. To change them, use `machine-memory remote setup`; to provision a new Alchemy D1 stack, use `machine-memory remote provision` with optional `--stack-name`, `--database-name`, and `--api-name`.
Every database-backed command requires exactly one backend flag. Use `--remote` for this repository and do not pass both flags.
Run `machine-memory doctor` during maintenance, not every task. Do not create or rely on a local `machine-memory.db` for this repository.

Before editing, run exactly one focused retrieval command from the repository root:

- Known files: `machine-memory suggest --files "path/a.ts,path/b.ts" --remote --json-min`
- Known topic: `machine-memory query "topic" --remote --json-min`
- Broad audit: `machine-memory list --tags "area:..." --remote --json-min`

Fetch full records only when the result looks relevant: `machine-memory get <id> --remote` or `machine-memory get <id,id,...> --remote`.

At task end, persist only durable decisions, constraints, preferences, and non-obvious gotchas. Update an existing canonical record when possible; do not store obvious code facts, routine test results, or temporary progress. Use status memories only for short-lived work and give them an expiry. Persist with `machine-memory add ... --remote` or update the canonical record with `machine-memory update ... --remote`.

Use exact file paths and put filenames, keys, routes, thresholds, and other retrieval anchors in the first sentence. Prefer path-based tags with `--path` and `tag-map`; use `--upsert-match` only after checking that the match is the intended canonical record.
<!-- machine-memory:end -->
