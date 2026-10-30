import { describe, expect, it } from "vitest";

import {
  droppedDetails,
  gotchaOverlaps,
  hasDroppedDetails,
  premiseQuery,
  reviewsDependents,
} from "../src/index";

describe("reconciliation helpers", () => {
  it("reports identifiers and sentences a replacement drops, as originally written", () => {
    const previous =
      "Keycap styling lives in src/ui/Keycap.tsx. Use shadow-inset for pressed keys. Shortcuts use TanStack Hotkeys.";
    const dropped = droppedDetails(
      previous,
      "Shortcuts use TanStack Hotkeys in focused forms.",
    );
    expect(dropped.identifiers).toEqual(["src/ui/Keycap.tsx", "shadow-inset"]);
    expect(dropped.sentences).toEqual([
      "Keycap styling lives in src/ui/Keycap.tsx.",
      "Use shadow-inset for pressed keys.",
    ]);
    expect(hasDroppedDetails(dropped)).toBe(true);
  });

  it("treats carried-over details and short fragments as kept", () => {
    const previous = "Node overlay pins nodejs_24. See flake.nix. Done.";
    const dropped = droppedDetails(
      previous,
      "Node overlay pins nodejs_24 until native addons rebuild; see flake.nix.",
    );
    expect(dropped).toEqual({ identifiers: [], sentences: [] });
    expect(hasDroppedDetails(dropped)).toBe(false);
  });

  it("puts identifiers first in the premise search text", () => {
    const query = premiseQuery(
      "Keep nixpkgs-security unchanged; Home Manager reimports nixpkgs.",
    );
    expect(query.identifiers).toEqual(["nixpkgs-security"]);
    expect(query.leadingText.startsWith("nixpkgs-security ")).toBe(true);
  });

  it("asks for dependent review only for durable records", () => {
    expect(reviewsDependents("decision")).toBe(true);
    expect(reviewsDependents("gotcha")).toBe(true);
    expect(reviewsDependents("status")).toBe(false);
  });

  it("pairs gotchas that name the same identifiers", () => {
    const overlaps = gotchaOverlaps([
      {
        id: 1,
        memory_type: "gotcha",
        content:
          "alchemy@2.0.0-beta.83 polls Durable Objects; patch lib/cloudflare/worker.js.",
      },
      {
        id: 2,
        memory_type: "gotcha",
        content:
          "alchemy@2.0.0-beta.83 precreate: keep the lib/cloudflare/worker.js patch registered.",
      },
      {
        id: 3,
        memory_type: "decision",
        content:
          "alchemy@2.0.0-beta.83 lib/cloudflare/worker.js is patched on purpose.",
      },
      {
        id: 4,
        memory_type: "gotcha",
        content: "D1 rejects CASE in triggers; use iif().",
      },
    ]);
    expect(overlaps).toEqual([
      {
        ids: [1, 2],
        shared_identifiers: [
          "alchemy@2.0.0-beta.83",
          "lib/cloudflare/worker.js",
        ],
      },
    ]);
  });
});
