import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  EVIDENCE_REQUIRED_MESSAGE,
  EvidenceSchema,
  StoredEvidenceFieldsSchema,
  ValidationGapsSchema,
  evidenceWriteError,
} from "../src/index";

describe("evidence metadata", () => {
  it("accepts unique evidence kinds and rejects unknown or repeated ones", () => {
    const decode = Schema.decodeUnknownSync(EvidenceSchema);
    expect(decode(["user_requirement", "tested_behavior"])).toEqual([
      "user_requirement",
      "tested_behavior",
    ]);
    expect(() => decode(["verified"])).toThrow();
    expect(() => decode(["tested_behavior", "tested_behavior"])).toThrow(
      "unique",
    );
  });

  it("bounds validation gaps", () => {
    const decode = Schema.decodeUnknownSync(ValidationGapsSchema);
    expect(decode(["Safari not tested"])).toEqual(["Safari not tested"]);
    expect(() => decode(["  "])).toThrow("blank");
    expect(() => decode(["x".repeat(301)])).toThrow();
    expect(() => decode(Array.from({ length: 17 }, () => "gap"))).toThrow();
  });

  it("decodes stored JSON text and tolerates pre-migration rows", () => {
    const decode = Schema.decodeUnknownSync(StoredEvidenceFieldsSchema);
    expect(
      decode({
        evidence: '["observed_implementation"]',
        validation_gaps: '["Intent unconfirmed"]',
      }),
    ).toEqual({
      evidence: ["observed_implementation"],
      validation_gaps: ["Intent unconfirmed"],
    });
    expect(decode({})).toEqual({});
  });

  it("requires evidence whenever a write asserts verified", () => {
    expect(evidenceWriteError({ certainty: "verified" })).toBe(
      EVIDENCE_REQUIRED_MESSAGE,
    );
    expect(
      evidenceWriteError({
        certainty: "verified",
        evidence: ["observed_implementation"],
      }),
    ).toBeUndefined();
    expect(evidenceWriteError({ certainty: "inferred" })).toBeUndefined();
    expect(evidenceWriteError({})).toBeUndefined();
  });

  it("lets legacy verified rows change content but not re-assert certainty bare", () => {
    const legacy = { certainty: "verified", evidence: [] } as const;
    expect(evidenceWriteError({}, legacy)).toBeUndefined();
    expect(evidenceWriteError({ certainty: "verified" }, legacy)).toBe(
      EVIDENCE_REQUIRED_MESSAGE,
    );
    expect(evidenceWriteError({ evidence: [] }, legacy)).toBe(
      EVIDENCE_REQUIRED_MESSAGE,
    );
    expect(
      evidenceWriteError({ certainty: "inferred" }, legacy),
    ).toBeUndefined();
    expect(
      evidenceWriteError(
        { certainty: "verified" },
        { certainty: "inferred", evidence: ["verified_mechanism"] },
      ),
    ).toBeUndefined();
  });
});
