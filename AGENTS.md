<!-- machine-memory:start -->
<!-- machine-memory:version 6 remote -->
## Project memory

This repository keeps durable project knowledge in `machine-memory`, in a remote database shared by every checkout. Every database command takes `--remote`. `machine-memory help workflow` explains each step below in full.

- Before changing code, scan once and read the records that bear on the task: `machine-memory suggest --files "a.ts,b.ts" --remote --json-min` for known files, or `machine-memory query "<topic>" --hybrid --remote --json-min` for a topic or a task that touches no files; then `machine-memory get <id,id> --remote`. Results are candidates: judge them by `match_strength`, and "nothing relevant" is a valid outcome.
- When the user's instruction contradicts a stored record, follow the user and update the record.
- Write one fact per record and start it with the command, path or identifier it is about. Store decisions, constraints, preferences, references and gotchas. Put delivery state in one `status` record with `--expires-after-days`. Leave out pixel values, UI state and deploy outcomes, and put facts about one machine in that machine's guidance file.
- Check size before writing: `machine-memory size "<text>"`, or `--dry-run` on `add` and `update`. Content, tags and context share one 2,000-byte limit.
- Change a record with `machine-memory update <id> "<whole new content>" --remote`. It replaces the content, so read the record first and keep the details that still hold. Leave the content out to change only tags, type or certainty. Create one with `machine-memory add "<content>" --upsert-match "<topic>" --type <type> --remote`, which updates a strong match instead of adding a duplicate.
- When a write reports `dropped` or `review_candidates` (also on stderr, in a `machine-memory:` line), restore details dropped by mistake, and update or deprecate the listed records that rely on what you changed.
- `--certainty verified` requires `--evidence`: `user_requirement`, `observed_implementation`, `verified_mechanism` or `tested_behavior`. Reading the code proves only `observed_implementation`.
- When delegating, scan once and pass the record ids to child agents. Children return findings with their evidence; the parent writes them.
- Before the final response, run `machine-memory checkpoint --remote --json-min`, then add, update or deprecate records for what the task established.

Project preference: replace obsolete systems when practical; preserve backwards compatibility only when it is explicitly required.
<!-- machine-memory:end -->
