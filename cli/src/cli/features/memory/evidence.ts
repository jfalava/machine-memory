import {
  EVIDENCE_KINDS,
  VALIDATION_GAP_MAX_CHARS,
  VALIDATION_GAPS_MAX,
  evidenceWriteError,
  type Certainty,
  type EvidenceKind,
} from "@machine-memory/contract";

import { getFlagValue, usageError } from "../../../cli-utils";
import {
  jsonStringArray,
  parseJson,
  storedStringArray,
  type JsonValue,
} from "../../../json";

const CLEAR_VALUES = new Set(["", "[]", "none"]);

function isEvidenceKind(value: string): value is EvidenceKind {
  return EVIDENCE_KINDS.some((kind) => kind === value);
}

/** Rows from a pre-migration remote schema have no column: [] means unspecified. */
export function parseStoredEvidence(
  value: JsonValue | undefined,
): EvidenceKind[] {
  return [...new Set(storedStringArray(value).filter(isEvidenceKind))];
}

export function parseStoredValidationGaps(
  value: JsonValue | undefined,
): string[] {
  return storedStringArray(value).filter((gap) => gap.trim().length > 0);
}

function flagJsonArray(raw: string, flag: string): string[] {
  try {
    const parsed = jsonStringArray(parseJson(raw));
    if (parsed !== undefined) {
      return [...parsed];
    }
  } catch {}
  return usageError(`Invalid ${flag} value: expected a JSON string array.`);
}

/** `--evidence a,b` or a JSON array; `none` or `[]` clears it on update. */
export function parseEvidenceFlag(args: string[]): EvidenceKind[] | undefined {
  const raw = getFlagValue(args, "--evidence");
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (CLEAR_VALUES.has(trimmed)) {
    return [];
  }
  const values = (
    trimmed.startsWith("[")
      ? flagJsonArray(trimmed, "--evidence")
      : trimmed.split(",")
  ).map((value) => value.trim());
  const invalid = values.filter((value) => !isEvidenceKind(value));
  if (invalid.length > 0) {
    usageError(
      `Invalid --evidence value ${invalid.map((value) => `'${value}'`).join(", ")}. Use a comma-separated list of: ${EVIDENCE_KINDS.join(", ")}.`,
    );
  }
  return [...new Set(values.filter(isEvidenceKind))];
}

/** One gap as plain text, several as a JSON array; `none` or `[]` clears them. */
export function parseValidationGapsFlag(args: string[]): string[] | undefined {
  const raw = getFlagValue(args, "--validation-gaps");
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (CLEAR_VALUES.has(trimmed)) {
    return [];
  }
  const gaps = (
    trimmed.startsWith("[")
      ? flagJsonArray(trimmed, "--validation-gaps")
      : [trimmed]
  ).map((gap) => gap.trim());
  if (
    gaps.length > VALIDATION_GAPS_MAX ||
    gaps.some((gap) => gap === "" || gap.length > VALIDATION_GAP_MAX_CHARS)
  ) {
    usageError(
      `Invalid --validation-gaps: give at most ${VALIDATION_GAPS_MAX} nonblank gaps of at most ${VALIDATION_GAP_MAX_CHARS} characters.`,
    );
  }
  return gaps;
}

/** Rejects a write that asserts `verified` without naming any evidence. */
export function assertEvidenceWrite(
  patch: { certainty?: Certainty; evidence?: EvidenceKind[] },
  existing?: { certainty: Certainty; evidence: EvidenceKind[] },
): void {
  const error = evidenceWriteError(patch, existing);
  if (error !== undefined) {
    usageError(error);
  }
}
