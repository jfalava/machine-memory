import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { CommandError, MemoryDatabaseError } from "../src/lib/effect/errors";
import { compareFact } from "../src/lib/cli/features/memory/compare";
import { normalizeSqliteRow, parseIdSpec } from "../src/lib/cli/shared";

describe("Effect application boundaries", () => {
  it("represents command failures as tagged errors", () => {
    const error = new CommandError({
      command: "query",
      message: "A search term is required.",
      cause: undefined,
    });

    expect(error._tag).toBe("CommandError");
    expect(error.message).toBe("A search term is required.");
  });

  it("keeps database failures in the typed error channel", async () => {
    const result = await Effect.runPromiseExit(
      Effect.fail(
        new MemoryDatabaseError({
          operation: "get",
          message: "locked",
          cause: undefined,
        }),
      ),
    );

    expect(result._tag).toBe("Failure");
  });

  it("preserves the existing pure memory semantics", () => {
    expect(parseIdSpec("3,1,3")).toEqual([3, 1]);
    expect(
      normalizeSqliteRow({ certainty: "hard", refs: '["docs/a.md"]' }),
    ).toMatchObject({
      certainty: "verified",
      refs: ["docs/a.md"],
    });
    expect(compareFact("Effect is used", "Effect is not used").conflict).toBe(
      true,
    );
  });
});
