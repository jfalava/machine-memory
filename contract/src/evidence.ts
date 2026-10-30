import { Schema } from "effect";

import {
  DEFAULT_CERTAINTY,
  EVIDENCE_KINDS,
  VALIDATION_GAP_MAX_CHARS,
  VALIDATION_GAPS_MAX,
  type Certainty,
  type EvidenceKind,
} from "./literals";

export const EvidenceKindSchema = Schema.Literals(EVIDENCE_KINDS);

export const EvidenceSchema = Schema.Array(EvidenceKindSchema).check(
  Schema.makeFilter(
    (kinds: readonly EvidenceKind[]) => new Set(kinds).size === kinds.length,
    { expected: "evidence kinds must be unique." },
  ),
);

const ValidationGapSchema = Schema.String.check(
  Schema.isMaxLength(VALIDATION_GAP_MAX_CHARS),
  Schema.makeFilter((gap: string) => gap.trim().length > 0, {
    expected: "a validation gap must not be blank.",
  }),
);

export const ValidationGapsSchema = Schema.Array(ValidationGapSchema).check(
  Schema.isMaxLength(VALIDATION_GAPS_MAX),
);

/** SQLite and D1 store both fields as JSON text. Pre-migration rows omit them. */
export const StoredEvidenceFieldsSchema = Schema.Struct({
  evidence: Schema.optionalKey(Schema.fromJsonString(EvidenceSchema)),
  validation_gaps: Schema.optionalKey(
    Schema.fromJsonString(ValidationGapsSchema),
  ),
});

export const EVIDENCE_REQUIRED_MESSAGE = `certainty verified requires at least one evidence kind (${EVIDENCE_KINDS.join(", ")}). Name what was actually established, or use certainty inferred.`;

/**
 * `verified` must name its evidence whenever a write asserts it: on create, or
 * when the write sets certainty or evidence. Legacy verified rows without
 * evidence stay readable and editable until someone re-asserts them.
 */
export function evidenceWriteError(
  patch: {
    readonly certainty?: Certainty;
    readonly evidence?: readonly EvidenceKind[];
  },
  existing?: {
    readonly certainty: Certainty;
    readonly evidence: readonly EvidenceKind[];
  },
): string | undefined {
  const asserts =
    existing === undefined ||
    patch.certainty !== undefined ||
    patch.evidence !== undefined;
  const certainty = patch.certainty ?? existing?.certainty ?? DEFAULT_CERTAINTY;
  const evidence = patch.evidence ?? existing?.evidence ?? [];
  return asserts && certainty === "verified" && evidence.length === 0
    ? EVIDENCE_REQUIRED_MESSAGE
    : undefined;
}
