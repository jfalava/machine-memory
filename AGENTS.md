<!-- machine-memory:start -->

## Project memory

This project uses `machine-memory` with its database at `machine-memory.db`.
On first setup, `bun run cli/src/app.ts update-agents-md` can use local memory, connect an existing remote Worker, or provision the Alchemy D1 stack. Remote provisioning accepts `--stack-name`, `--database-name`, and `--api-name` through `bun run cli/src/app.ts remote provision`.

Before editing, run exactly one focused retrieval command from the repository root:

- Known files: `bun run cli/src/app.ts suggest --files "path/a.ts,path/b.ts" --json-min`
- Known topic: `bun run cli/src/app.ts query "topic" --json-min`
- Broad audit: `bun run cli/src/app.ts list --tags "area:..." --json-min`

Fetch full records only when the result looks relevant: `bun run cli/src/app.ts get <id>` or `bun run cli/src/app.ts get <id,id,...>`.

At task end, persist only durable decisions, constraints, preferences, and non-obvious gotchas. Update an existing canonical record when possible; do not store obvious code facts, routine test results, or temporary progress. Use status memories only for short-lived work and give them an expiry.

Use exact file paths and put filenames, keys, routes, thresholds, and other retrieval anchors in the first sentence. Prefer path-based tags with `--path` and `tag-map`; use `--upsert-match` only after checking that the match is the intended canonical record.

Run `bun run cli/src/app.ts doctor` during maintenance, not every task. Ensure `machine-memory.db` is writable before memory writes.
<!-- machine-memory:end -->
