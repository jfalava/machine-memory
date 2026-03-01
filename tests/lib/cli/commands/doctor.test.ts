import { describe, test, expect } from "bun:test";
import { createCliHarness } from "../../../_support/cli-harness";

const harness = createCliHarness();
const { json, dbRun } = harness;

function asObject(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function expectSummary(summary: Record<string, unknown>) {
  expect(summary.exact_duplicates).toBeGreaterThanOrEqual(1);
  expect(summary.near_duplicates).toBeGreaterThanOrEqual(1);
  expect(summary.stale_status_overlaps).toBeGreaterThanOrEqual(1);
  expect(summary.canonical_thread_overlaps).toBeGreaterThanOrEqual(1);
  expect(summary.status_missing_expiry).toBeGreaterThanOrEqual(1);
  expect(summary.type_boundary).toBeGreaterThanOrEqual(1);
  expect(summary.tag_hygiene).toBeGreaterThanOrEqual(1);
  expect(summary.malformed_refs).toBeGreaterThanOrEqual(1);
}

function expectFindings(
  findings: Record<string, unknown>,
  commands: string[],
) {
  const exact = findings.exact_duplicates as Record<string, unknown>[];
  const canonical = findings.canonical_thread_overlaps as Record<
    string,
    unknown
  >[];
  const statusExpiry = findings.status_expiry as Record<string, unknown>[];
  const typeBoundary = findings.type_boundary as Record<string, unknown>[];
  const tagHygiene = findings.tag_hygiene as Record<string, unknown>[];
  const refs = findings.malformed_refs as Record<string, unknown>[];
  expect(exact[0]?.suggested_command).toContain("machine-memory delete");
  expect(canonical[0]?.suggested_command).toContain("machine-memory deprecate");
  expect(statusExpiry[0]?.suggested_command).toContain("--expires-after-days");
  expect(
    typeBoundary.some((item) =>
      String(item.suggested_command).includes("--type status"),
    ),
  ).toBe(true);
  expect(
    tagHygiene.some((item) =>
      String(item.suggested_command).includes("machine-memory update"),
    ),
  ).toBe(true);
  expect(refs[0]?.suggested_command).toContain("--refs");
  expect(commands.some((item) => item.includes("machine-memory deprecate"))).toBe(
    true,
  );
}

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
    [
      "Lint status snapshot: currently failing on CI",
      "--type",
      "status",
      "--tags",
      "area:cli,topic:lint,kind:status",
    ],
    [
      "Lint status snapshot: fixed on main branch",
      "--type",
      "status",
      "--tags",
      "area:cli,topic:lint,kind:status",
    ],
    [
      "Lint workflow currently failing for node20",
      "--type",
      "decision",
      "--tags",
      "area:cli,topic:lint,kind:decision",
    ],
    [
      "Architecture decision: clients must use exponential backoff",
      "--type",
      "status",
      "--tags",
      "area:api,topic:retry,kind:status",
    ],
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

    const result = asObject(json("doctor"));
    const summary = asObject(result.summary);
    const findings = asObject(result.findings);
    const commands = result.suggested_commands as string[];
    expectSummary(summary);
    expectFindings(findings, commands);
  });

  test("supports --json-min output on doctor", () => {
    json("add", "doctor json min", "--tags", "doctor");
    const result = json("doctor", "--json-min") as Record<string, unknown>;
    expect(typeof result.count).toBe("number");
    expect(typeof result.suggested_commands_count).toBe("number");
  });
});
