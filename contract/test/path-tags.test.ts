import { describe, expect, it } from "vitest";

import {
  coverageReport,
  normalizeTagMapPath,
  pathTagMappingsFromRows,
  suggestPathTags,
} from "../src/index";

describe("path tag map", () => {
  const mappings = [
    { path_prefix: "src", tags: ["area:src"] },
    { path_prefix: "src/cli", tags: ["area:cli", "area:src"] },
    { path_prefix: "docs/", tags: ["area:docs"] },
  ];

  it("gives a path the tags of every matching prefix, longest prefix first", () => {
    expect(
      suggestPathTags(mappings, ".\\src\\cli\\app.ts, docs/a.md,README.md"),
    ).toEqual({
      tags: ["area:cli", "area:src", "area:docs"],
      matches: [
        {
          path: "src/cli/app.ts",
          prefix: "src/cli",
          tags: ["area:cli", "area:src"],
        },
        { path: "src/cli/app.ts", prefix: "src", tags: ["area:src"] },
        { path: "docs/a.md", prefix: "docs/", tags: ["area:docs"] },
      ],
      unmatched: ["README.md"],
    });
    // A prefix that ends in a slash names a directory only.
    expect(suggestPathTags(mappings, "docs.md").unmatched).toEqual(["docs.md"]);
    expect(suggestPathTags(mappings, " , ")).toEqual({
      tags: [],
      matches: [],
      unmatched: [],
    });
  });

  it("stores paths with forward slashes and tags in canonical form", () => {
    expect(normalizeTagMapPath(" ./src\\cli ")).toBe("src/cli");
    expect(
      pathTagMappingsFromRows([
        { path_prefix: "src", tags: "Area:SRC, area:src,topic:code" },
      ]),
    ).toEqual([{ path_prefix: "src", tags: ["area:src", "topic:code"] }]);
  });
});

describe("coverage", () => {
  it("lists directories no segment of which is a tag, and counts tags", () => {
    expect(
      coverageReport(
        ["api/", "api/src/", "CLI/commands/", "docs/", "/"],
        ["api, kind:decision", "cli,API", ""],
      ),
    ).toEqual({
      uncovered_paths: ["docs/"],
      tag_distribution: { api: 1, "kind:decision": 1, cli: 1, API: 1 },
    });
  });
});
