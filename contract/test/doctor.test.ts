import { describe, expect, it } from "vitest";

import { analyzeMemoryDoctor, type JsonObject } from "../src/index";

const NOW = Date.parse("2026-11-15T00:00:00Z");

/** A stored row, newest first in the list given to the doctor. */
function row(id: number, fields: JsonObject): JsonObject {
  return {
    id,
    content: `fact ${id}`,
    tags: "area:cli,topic:unrelated",
    context: "",
    memory_type: "decision",
    certainty: "inferred",
    evidence: "[]",
    refs: "[]",
    expires_after_days: null,
    updated_at: "2026-11-14 00:00:00",
    ...fields,
  };
}

function findings(rows: JsonObject[], kind: string) {
  return analyzeMemoryDoctor("o/r", rows, NOW).findings.filter(
    (finding) => finding.kind === kind,
  );
}

describe("doctor", () => {
  it("calls a status stale only when a newer status shares its topic", () => {
    const status = (id: number, tags: string) =>
      row(id, {
        content: `status ${id} of the rollout`,
        tags,
        memory_type: "status",
        expires_after_days: 30,
      });
    const stale = findings(
      [
        status(4, "area:api,topic:deploy,kind:status"),
        // Shares only the area and kind:status with 4: a different subject.
        status(3, "area:api,topic:indexing,kind:status"),
        status(2, "area:cli,topic:deploy,kind:status"),
        // No topic at all, so nothing says what it is about.
        status(1, "area:api,kind:status"),
      ],
      "stale_status_overlap",
    );
    expect(stale.map((finding) => [finding.ids, finding.details])).toEqual([
      [
        [2, 4],
        { stale_id: 2, superseded_by: 4, shared_tags: ["topic:deploy"] },
      ],
    ]);
  });

  it("needs more than one common word to call a record transient", () => {
    const transient = findings(
      [
        row(1, { content: "The parser now accepts tabs." }),
        row(2, { content: "Tests pass on Node 22." }),
        row(3, { content: "Fixed in the current release." }),
        row(4, { content: "The build is currently red." }),
        row(5, { content: "Work in progress on the importer." }),
        // A status record is where transient wording belongs.
        row(6, {
          content: "Tests failing, fix in progress.",
          memory_type: "status",
          expires_after_days: 30,
        }),
      ],
      "transient_non_status",
    );
    expect(
      transient.map((finding) => [
        finding.ids[0],
        finding.details.matched_terms,
      ]),
    ).toEqual([
      [3, ["current", "fixed"]],
      [4, ["currently"]],
      [5, ["progress", "in progress"]],
    ]);
  });

  it("reports status records past their expiry, by how many days", () => {
    const status = (id: number, updatedAt: string, days: number | null) =>
      row(id, {
        memory_type: "status",
        updated_at: updatedAt,
        expires_after_days: days,
      });
    const expired = findings(
      [
        status(1, "2026-11-01 00:00:00", 14),
        status(2, "2026-11-01 00:00:00", 10),
        status(3, "2026-10-01 00:00:00", null),
        row(4, { updated_at: "2020-01-01 00:00:00" }),
      ],
      "expired_status",
    );
    expect(expired.map((finding) => [finding.ids, finding.details])).toEqual([
      [[1], { expires_after_days: 14, days_overdue: 0 }],
      [[2], { expires_after_days: 10, days_overdue: 4 }],
    ]);
  });

  it("pairs tags that extend one another and points at the rarer one", () => {
    const similar = findings(
      [
        row(1, { tags: "area:web,topic:og" }),
        row(2, { tags: "area:web,topic:og-image" }),
        row(3, { tags: "area:web,topic:og-image" }),
        row(4, { tags: "area:website,topic:ogre" }),
        row(5, { tags: "area:web,topic:hook" }),
        row(6, { tags: "area:web,topic:hooks" }),
        row(7, { tags: "area:web,topic:hooks" }),
      ],
      "similar_tags",
    );
    expect(
      similar.map((finding) => [finding.details.tags, finding.ids]),
    ).toEqual([
      [["topic:hook", "topic:hooks"], [5]],
      [["topic:og", "topic:og-image"], [1]],
    ]);
  });
});
