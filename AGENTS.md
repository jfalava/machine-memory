# Project memory

This project uses `machine-memory` for persistent agent context stored at `.agents/memory.db`.

## Before starting work

- Run `machine-memory suggest --files "<paths you expect to touch>"` to get relevant memories before coding.
- Run `machine-memory query <topic>` to check for relevant context about the area you're working on.
- Run `machine-memory stats` (or `coverage --root .`) as a health check if you're doing larger work.
- Run `machine-memory help` if you need to discover available commands.

## When to store memories

After completing a task, store anything a future agent session would benefit from knowing:

- `machine-memory add "description" --tags "tag1,tag2" --context "why this matters" --type "decision" --certainty "inferred"`

Store: architectural decisions, reference docs/specs, status snapshots, project conventions, non-obvious gotchas, environment/tooling notes, and user preferences.
Do NOT store: things obvious from reading the code, temporary information, or duplicates of existing memories.

## When to update, deprecate, or delete

- If a memory is outdated, update it: `machine-memory update <id> "new content"` or `machine-memory update --match "topic" --from-file ./notes.md`
- If a memory is replaced by a newer one, deprecate it: `machine-memory deprecate <old_id> --superseded-by <new_id>` or `machine-memory deprecate --match "old topic"`
- If a memory is wrong or no longer relevant, delete it: `machine-memory delete <id>`
