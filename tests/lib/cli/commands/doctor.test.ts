import { describe, test, expect } from "bun:test";
import { createCliHarness } from "../../../_support/cli-harness";

const harness = createCliHarness();
const { json, dbRun } = harness;

function seedDoctorFixture() {
  const seedRows = [
    ["duplicate seed", "--tags", "dup", "--context", "same"],
    ["duplicate seed", "--tags", "dup", "--context", "same"],
    ["JWT tokens are signed with RS256 and rotated weekly", "--tags", "jwt"],
    ["JWT token signatures use RS256 with weekly rotation", "--tags", "jwt"],
    ["status phase 1", "--type", "status", "--tags", "deploy,phase"],
    ["status phase 2", "--type", "status", "--tags", "deploy"],
    ["tag cleanup target", "--tags", "clean"],
    ["missing tags target"],
    ["refs cleanup target", "--tags", "refs"],
  ];
  for (const seed of seedRows) {
    json("add", ...seed);
  }
  dbRun("UPDATE memories SET tags = 'clean, clean ,ops,,' WHERE id = 7");
  dbRun("UPDATE memories SET refs = '{\"bad\":true}' WHERE id = 9");
}

describe("doctor", () => {
  test("detects duplicates, stale status overlaps, tag issues, and malformed refs", () => {
    seedDoctorFixture();

    const result = json("doctor") as Record<string, unknown>;
    const summary = result.summary as Record<string, unknown>;
    const findings = result.findings as Record<string, unknown>;
    const commands = result.suggested_commands as string[];

    expect(summary.exact_duplicates).toBeGreaterThanOrEqual(1);
    expect(summary.near_duplicates).toBeGreaterThanOrEqual(1);
    expect(summary.stale_status_overlaps).toBeGreaterThanOrEqual(1);
    expect(summary.tag_hygiene).toBeGreaterThanOrEqual(1);
    expect(summary.malformed_refs).toBeGreaterThanOrEqual(1);

    const exact = findings.exact_duplicates as Record<string, unknown>[];
    const tagHygiene = findings.tag_hygiene as Record<string, unknown>[];
    const refs = findings.malformed_refs as Record<string, unknown>[];
    expect(exact[0]?.suggested_command).toContain("machine-memory delete");
    expect(
      tagHygiene.some((item) =>
        String(item.suggested_command).includes("machine-memory update"),
      ),
    ).toBe(true);
    expect(refs[0]?.suggested_command).toContain("--refs");
    expect(
      commands.some((item) => item.includes("machine-memory deprecate")),
    ).toBe(true);
  });

  test("supports --json-min output on doctor", () => {
    json("add", "doctor json min", "--tags", "doctor");
    const result = json("doctor", "--json-min") as Record<string, unknown>;
    expect(typeof result.count).toBe("number");
    expect(typeof result.suggested_commands_count).toBe("number");
  });
});
