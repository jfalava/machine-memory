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
  const memories = [
    {
      text: "contract/src/search.ts owns CLI/API relevance. See `tools/oxlint`.",
      tags: "area:contract",
    },
    {
      // A URL, an API route and the word "cli" name no directory; a reference does.
      text: 'The cli docs are at https://x.dev/docs/mcp and POST /product/api/list. ["docs/public/install"]',
      tags: "Area:Router, kind:reference",
    },
    { text: "Requests enter in router/src/index.ts.", tags: "area:router" },
  ];
  const mappings = [{ path_prefix: "router/src", tags: ["area:router"] }];

  it("covers a directory when a memory names a path in it or is tagged for it", () => {
    expect(
      coverageReport(
        [
          "contract/",
          "contract/src/",
          "contract/src/product/",
          "cli/",
          "api/",
          "product/",
          "docs/",
          "docs/public/",
          "docs-old/",
          "tools/oxlint",
          "router/",
          "router/src/",
          "router/src/handlers/",
          "router/test/",
          "/",
        ],
        memories,
        mappings,
      ),
    ).toEqual({
      uncovered_paths: [
        // A path covers its parents, not its siblings or children.
        "contract/src/product/",
        "cli/",
        "api/",
        "product/",
        "docs-old/",
        "router/test/",
      ],
      covered_paths: {
        "contract/": 1,
        "contract/src/": 1,
        "docs/": 1,
        "docs/public/": 1,
        "tools/oxlint": 1,
        // Memory 2 names a path here and carries the mapped tag: counted once,
        // next to memory 1, which only carries the tag.
        "router/": 2,
        "router/src/": 2,
        "router/src/handlers/": 2,
      },
      tag_distribution: {
        "area:contract": 1,
        "Area:Router": 1,
        "kind:reference": 1,
        "area:router": 1,
      },
    });
  });

  it("covers nothing through tags without a tag map", () => {
    const report = coverageReport(
      ["router/", "router/src/handlers/"],
      memories,
      [],
    );
    expect(report.uncovered_paths).toEqual(["router/src/handlers/"]);
    expect(report.covered_paths).toEqual({ "router/": 1 });
  });
});
