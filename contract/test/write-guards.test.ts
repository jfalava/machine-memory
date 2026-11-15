import { describe, expect, it } from "vitest";

import {
  assessReplacement,
  droppedNames,
  duplicateRefusal,
  editTags,
  editValidationGaps,
  nameHoldersFromRows,
  nearDuplicate,
  reviewCandidateRowsQuery,
  reviewNames,
  selectReviewCandidates,
  sharedIdentifiers,
  upsertRefusal,
} from "../src/index";

const STORED =
  "Keycap styling lives in src/ui/Keycap.tsx. Use shadow-inset for pressed keys. Built with bun@1.3.2, MAX_KEYS=12, released 2026-11-14 as v0.22.0.";

const assess = (
  next: string,
  options: {
    holders?: Map<string, number[]>;
    allowDrop?: boolean;
    memoryType?: "decision" | "status";
  } = {},
) =>
  assessReplacement({
    id: 12,
    previous: STORED,
    next,
    memoryType: options.memoryType ?? "decision",
    holders: options.holders ?? new Map(),
    allowDrop: options.allowDrop ?? false,
    allowDropHint: "--allow-drop",
  });

describe("write guards", () => {
  it("edits tags without touching the ones not named", () => {
    expect(
      editTags("area:cli,topic:og", {
        add: " Topic:OG-Image, area:cli",
        remove: "topic:og",
      }),
    ).toBe("area:cli,topic:og-image");
    expect(editTags("area:cli", { remove: "area:api" })).toBe("area:cli");
  });

  it("appends and removes validation gaps by exact text", () => {
    expect(
      editValidationGaps(["untested on Windows", "intent unconfirmed"], {
        add: ["one repository only", "intent unconfirmed"],
        remove: ["untested on Windows"],
      }),
    ).toEqual({
      gaps: ["intent unconfirmed", "one repository only"],
      error: undefined,
    });
    const missing = editValidationGaps(["intent unconfirmed"], {
      remove: ["untested on windows"],
    });
    expect(missing.gaps).toEqual(["intent unconfirmed"]);
    expect(missing.error).toContain(
      'No stored validation gap reads "untested on windows"',
    );
    const tooMany = editValidationGaps(
      Array.from({ length: 16 }, (_, index) => `gap ${index}`),
      { add: ["one more"] },
    );
    expect(tooMany.gaps).toHaveLength(16);
    expect(tooMany.error).toContain("at most 16");
  });

  it("counts a dropped name, but not a changed version, value or date", () => {
    expect(
      droppedNames(
        STORED,
        "Keycap styling lives in src/ui/Keycap.tsx. Built with bun@1.4.0, MAX_KEYS=16, released 2026-12-01 as v0.23.0.",
      ),
    ).toEqual(["shadow-inset"]);
    // Alternatives written as a|b are still present when written apart.
    expect(
      droppedNames(
        "reindex takes --failed-only|--unindexed|--all-repos.",
        "reindex takes --failed-only, --unindexed or --every-repo.",
      ),
    ).toEqual(["--all-repos"]);
  });

  it("lists review candidates that cite the premise or share a name few records carry", () => {
    expect(
      reviewNames(
        "bun@1.3.2 runs src/ui/Keycap.tsx with --hot since 2026-11-01 (v0.23.0).",
      ),
    ).toEqual(["bun", "src/ui/keycap.tsx", "--hot"]);

    const holders = new Map([
      ["src/ui/keycap.tsx", [2]],
      ["shadow-inset", [2, 3, 4]],
      // Four records carry it: too common to say which one relies on the premise.
      ["--remote", [3, 5, 6, 7]],
    ]);
    const rows = [
      {
        id: 2,
        content: "Keycap tests render src/ui/Keycap.tsx with shadow-inset.",
      },
      {
        id: 3,
        content: "shadow-inset is defined in the theme; run with --remote.",
      },
      { id: 5, content: "Deploys pass --remote." },
      { id: 8, content: "Pressed keys follow the keycap decision (12)." },
      { id: 9, content: "Step (1) installs, step 12 of 14 deploys." },
    ];
    const [keycapTests, theme, , citing, listMarker] = rows;
    expect(
      selectReviewCandidates([{ id: 12, holders, rows }], new Set([12])),
    ).toEqual([
      { row: citing, shared_identifiers: [], cites: true },
      {
        row: keycapTests,
        shared_identifiers: ["src/ui/keycap.tsx", "shadow-inset"],
        cites: false,
      },
      { row: theme, shared_identifiers: ["shadow-inset"], cites: false },
    ]);
    // A bare (1) is a list marker, not a reference to memory 1.
    expect(
      selectReviewCandidates(
        [
          {
            id: 1,
            holders: new Map(),
            rows: [listMarker, { id: 10, content: "See #1." }].filter(
              (row) => row !== undefined,
            ),
          },
        ],
        new Set([1]),
      ).map((candidate) => candidate.row.id),
    ).toEqual([10]);

    const query = reviewCandidateRowsQuery({
      repository: "acme/app",
      premiseId: 12,
      holders,
    });
    expect(query.params).toEqual([
      "acme/app",
      12,
      "[2,3,4]",
      "#12",
      "(12",
      ", 12",
      "record 12",
      "memory 12",
    ]);
  });

  it("refuses an update that drops a name no other record carries", () => {
    const next =
      "Keycap styling uses shadow-inset for pressed keys; built with bun@1.3.2 and MAX_KEYS=12.";
    const refused = assess(next);
    expect(refused.action).toBe("refuse");
    // Reported as the stored content spells it; compared in lower case.
    expect(refused.orphaned_identifiers).toEqual(["src/ui/Keycap.tsx"]);
    expect(refused.refusal).toContain(
      "Update of memory 12 refused: it drops `src/ui/Keycap.tsx`, which no other active record mentions.",
    );
    expect(refused.refusal).toContain("--allow-drop");

    // The same name held by another record is reported, not refused.
    const held = assess(next, {
      holders: new Map([["src/ui/keycap.tsx", [40, 41, 42, 43]]]),
    });
    expect(held.action).toBe("update");
    expect(held.held_elsewhere).toEqual([
      { identifier: "src/ui/Keycap.tsx", ids: [40, 41, 42] },
    ]);
    expect(held.refusal).toBeUndefined();

    expect(assess(next, { allowDrop: true }).action).toBe("update");
    // Status records are snapshots; replacing one is the normal case.
    expect(assess(next, { memoryType: "status" }).action).toBe("update");
    expect(assess(STORED).action).toBe("update");
  });

  it("refuses content that shares almost nothing with what it replaces", () => {
    const holders = new Map([
      ["src/ui/keycap.tsx", [40]],
      ["shadow-inset", [40]],
      ["bun", [40]],
      ["max_keys", [40]],
    ]);
    const refused = assess("Deploys run from the stable branch.", { holders });
    expect(refused.orphaned_identifiers).toEqual([]);
    expect(refused.text_overlap).toBeLessThan(0.15);
    expect(refused.action).toBe("refuse");
    expect(refused.refusal).toContain(
      "add it as a new record and deprecate 12",
    );
    // Two or three stored terms say nothing about overlap.
    expect(
      assessReplacement({
        id: 3,
        previous: "Use bun for installs.",
        next: "Switch to pnpm instead.",
        memoryType: "decision",
        holders: new Map(),
        allowDrop: false,
        allowDropHint: "--allow-drop",
      }).action,
    ).toBe("update");
  });

  it("reads the holders of each dropped name from query rows", () => {
    expect(
      nameHoldersFromRows([
        { name: "shadow-inset", ids: "4,9" },
        { name: "src/ui/keycap.tsx", ids: null },
      ]),
    ).toEqual(new Map([["shadow-inset", [4, 9]]]));
  });

  it("finds the nearest record only at the doctor's duplicate threshold", () => {
    const text = "Deploys run from the stable branch after CI passes.";
    expect(
      nearDuplicate(text, [
        { id: 3, text: "Deploys run from the stable branch." },
        {
          id: 4,
          text: "Deploys run from the stable branch after CI passes twice.",
        },
        { id: 5, text: "Releases are tagged by hand." },
      ]),
    ).toEqual({ id: 4, text_overlap: 0.875 });
    expect(
      nearDuplicate(text, [
        { id: 3, text: "Deploys run from the stable branch." },
      ]),
    ).toBeUndefined();
    expect(
      duplicateRefusal(
        { id: 4, text_overlap: 0.875 },
        { updateId: (id) => `--update-id ${id}`, createNew: "--create-new" },
      ),
    ).toBe(
      "Memory #4 already states nearly the same thing (text_overlap 0.875, at or above 0.78). Nothing was written. To change that record, repeat the add with --update-id 4. If this is a different fact, repeat it with --create-new.",
    );
  });

  it("explains a refused upsert with the bar, the candidates and both ways forward", () => {
    expect(
      sharedIdentifiers(
        "Use shadow-inset in src/ui/Keycap.tsx.",
        "src/ui/Keycap.tsx now uses box-shadow.",
      ),
    ).toEqual(["src/ui/keycap.tsx"]);
    const message = upsertRefusal(
      [
        {
          id: 9,
          rank_score: 40,
          text_overlap: 0.31,
          memory_type: "decision",
          content_head: "Use shadow-inset",
          shared_identifiers: ["src/ui/keycap.tsx"],
        },
        {
          id: 11,
          rank_score: 22,
          text_overlap: 0.1,
          memory_type: "gotcha",
          content_head: "Keys repeat",
          shared_identifiers: [],
        },
      ],
      32,
      { updateId: (id) => `--update-id ${id}`, createNew: "--create-new" },
    );
    expect(message).toContain(
      "the best candidate #9 has rank_score 40 (needs 32) and text_overlap 0.31 (needs 0.62)",
    );
    expect(message).toContain(
      '#9 decision "Use shadow-inset" (rank_score 40, text_overlap 0.31, shares src/ui/keycap.tsx); #11 gotcha "Keys repeat" (rank_score 22, text_overlap 0.1)',
    );
    expect(message).toContain("--update-id 9");
    expect(message).toContain("--create-new");
  });
});
