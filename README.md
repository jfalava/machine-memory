# machine-memory

Persistent project-scoped memory for LLM agents.

Stores facts, decisions, references, status snapshots, and other project context so future agent sessions can recall them.

Machine Memory gives LLM agents a persistent, project-scoped place to store and retrieve facts, decisions, references, and short-lived status snapshots.

## [Official Docs](https://machine-memory.jfa.dev/)

## Monorepo layout

This repository is a monorepo:

- `docs/` — The documentation site, built with [Nimbus Docs](https://nimbus-docs.com/).
- `cli/` — The `machine-memory` command-line interface for managing memories.
- `remote-db/d1/` — The remote database IaC, built with [Alchemy](https://alchemy.run/cloudflare/).
