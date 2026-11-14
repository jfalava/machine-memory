import { describe, expect, it } from "vitest";

import { parseRepositoryRemote, similarRepositories } from "../src/repository";

describe("repository slugs", () => {
  it("uses the remote's whole path as the slug", () => {
    for (const [remote, slug] of [
      ["git@github.com:jfalava/machine-memory.git", "jfalava/machine-memory"],
      ["https://github.com/jfalava/jfa.dev", "jfalava/jfa.dev"],
      ["https://ampcode.com/@jfalava/clanka", "@jfalava/clanka"],
      ["git@gitlab.com:group/subgroup/project.git", "group/subgroup/project"],
      [
        "ssh://git@gitlab.com:2222/group/subgroup/project.git/",
        "group/subgroup/project",
      ],
      ["https://git.sr.ht/~user/repo", "~user/repo"],
    ] as const) {
      expect(parseRepositoryRemote(remote)).toBe(slug);
    }
  });

  it("infers nothing from a remote whose path is not a slug", () => {
    for (const remote of [
      "",
      "https://example.com/solo.git",
      "https://dev.azure.com/org/My%20Project/_git/repo",
      `git@gitlab.com:group/${"x".repeat(70)}.git`,
      "/srv/git/project.git/not a slug",
    ]) {
      expect(parseRepositoryRemote(remote)).toBe(undefined);
    }
  });

  it("names repositories with a similar name or path tail, else all others", () => {
    const known = [
      "@jfalava/clanka",
      "jfalava/machines",
      "subgroup/project",
      "other/Clanka",
    ];
    expect(similarRepositories("jfalava/clanka", known)).toEqual([
      "@jfalava/clanka",
      "other/Clanka",
    ]);
    expect(similarRepositories("group/subgroup/project", known)).toEqual([
      "subgroup/project",
    ]);
    expect(similarRepositories("jfalava/machine", known)).toEqual([
      "jfalava/machines",
    ]);
    expect(
      similarRepositories("jfalava/new", [...known, "jfalava/new"]),
    ).toEqual(known);
  });
});
