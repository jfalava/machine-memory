<!-- machine-memory:start -->

## Project memory

This project uses `cli/dist/machine-memory-darwin-arm64` with its database at `.agents/memory.db`.

Before editing, run exactly one focused retrieval command from the repository root:

- Known files: `cli/dist/machine-memory-darwin-arm64 suggest --files "path/a.ts,path/b.ts" --json-min`
- Known topic: `cli/dist/machine-memory-darwin-arm64 query "topic" --json-min`
- Broad audit: `cli/dist/machine-memory-darwin-arm64 list --tags "area:..." --json-min`

Fetch full records only when the result looks relevant: `cli/dist/machine-memory-darwin-arm64 get <id>` or `cli/dist/machine-memory-darwin-arm64 get <id,id,...>`.

At task end, persist only durable decisions, constraints, preferences, and non-obvious gotchas. Update an existing canonical record when possible; do not store obvious code facts, routine test results, or temporary progress. Use status memories only for short-lived work and give them an expiry.

Use exact file paths and put filenames, keys, routes, thresholds, and other retrieval anchors in the first sentence. Prefer path-based tags with `--path` and `tag-map`; use `--upsert-match` only after checking that the match is the intended canonical record.

Run `cli/dist/machine-memory-darwin-arm64 doctor` during maintenance, not every task. Ensure both `.agents/` and `.agents/memory.db` are writable before memory writes.
<!-- machine-memory:end -->
