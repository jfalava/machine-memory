# machine-memory

Persistent project-scoped memory for LLM agents.

Stores facts, decisions, references, status snapshots, and other project context so future agent sessions can recall them.

Machine Memory gives LLM agents a persistent, project-scoped place to store and retrieve facts, decisions, references, and short-lived status snapshots.

## [Official Docs](https://machine-memory.jfa.dev/)

## Monorepo layout

This repository is a monorepo:

- `docs/` — The documentation site, built with [Nimbus Docs](https://nimbus-docs.com/).
- `cli/` — The `machine-memory` command-line interface for managing memories, built with [Effect](https://www.effect.website/)
- `remote-db/cloudflare/` — The remote Cloudflare IaC, built with [Alchemy](https://alchemy.run/cloudflare/).

## Embedding budget

Every memory's composed embedding text (content + Tags/Context lines + fixed type/status/certainty lines) must stay **below 512 BGE tokens**, and its conservative byte estimate (**UTF-8 bytes + 2**) must be **at most 512**. Either limit alone rejects the write before anything is stored.

Preflight without writing:

```sh
machine-memory size "<text>" --remote          # token count, byte estimate, pass/fail per limit, which limit binds
machine-memory add "<text>" --dry-run --remote # same report before a real add
machine-memory update <id> "<text>" --dry-run --remote
```

`--token-report` attaches the per-part token breakdown to a real `add`/`update`. On failure, the error states the exact byte or token deficit and suggests a mechanical trim.

## Output fields

- `conflict_count` — active memories that may conflict with newly added content.
- `status_cascade_count` — for a new `status` memory: other active status memories sharing its tags, i.e. candidates to deprecate.
