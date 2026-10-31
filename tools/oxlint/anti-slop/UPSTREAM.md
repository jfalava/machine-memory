# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Snapshot: `13909c9` (2026-10-13), `skills/install-anti-slop/assets/anti-slop/`.
  This is byte-identical to the `install-anti-slop` skill bundle installed on
  2026-10-18.
- Previous base: `6d53855` (`src/`, tests excluded). The tree vendored in
  25f75dc/fc26d5d matched it exactly, so the update applied every upstream
  change and dropped no local edits.
- Local deviations: none in this directory. Upstream `*.test.ts` files are not
  vendored; all 24 passed under Node with `oxlint`/`@oxlint/plugins` 1.90.0.
  `RuleTester` does not run under Bun.

## Configuration (root `oxlint.config.ts`)

- Enabled the rules that are new since `6d53855`: `oxc/no-accumulating-spread`,
  `no-array-filter-map`, `no-reduce-accumulator-copy`, and the Effect rules
  `no-manual-effect-error-tag`, `no-manual-tag-comparison`,
  `no-manual-tagged-construction` and `prefer-effect-match`.
- Deliberately off: `require-readable-spacing`. It reported about 2,850
  blank-line findings, is whitespace-only, and overlaps oxfmt.
