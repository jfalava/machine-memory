import { describe, test, expect } from "bun:test";
import { createCliHarness } from "../../../_support/cli-harness";

const harness = createCliHarness();
const { json } = harness;

describe("tag-map", () => {
  test("maps path prefixes to tags and applies them in add --path", () => {
    const mapped = json(
      "tag-map",
      "set",
      "sdk/src/schema.ts",
      "schema,types",
    ) as Record<string, unknown>;
    expect(mapped.status).toBe("ok");

    const suggested = json("tag-map", "suggest", "sdk/src/schema.ts") as Record<
      string,
      unknown
    >;
    expect(suggested.tags).toEqual(["schema", "types"]);

    const created = json(
      "add",
      "Schema contract notes",
      "--path",
      "sdk/src/schema.ts",
    ) as Record<string, unknown>;
    expect(created.tags).toBe("schema,types");
  });
});
