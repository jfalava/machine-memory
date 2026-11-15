import { Schema } from "effect";

import { NEAR_DUPLICATE_THRESHOLD, normalizeTags } from "./doctor";
import type { JsonValue } from "./json";
import {
  UPSERT_MIN_SIMILARITY,
  VALIDATION_GAP_MAX_CHARS,
  VALIDATION_GAPS_MAX,
  type MemoryType,
} from "./literals";
import { compareMemoryFact, factTerms, jaccardSimilarity } from "./ranking";
import { reviewsDependents } from "./reconcile";
import { extractQueryIdentifiers } from "./search";

/**
 * Rules that decide whether a write goes through. The CLI and the API both
 * call them, so a refusal reads the same from either.
 */

/** The stored tags after adding and removing comma-separated tags. */
export function editTags(
  current: string,
  edits: { readonly add?: string; readonly remove?: string },
): string {
  const removed = new Set(normalizeTags(edits.remove ?? ""));
  return normalizeTags(`${current},${edits.add ?? ""}`)
    .filter((tag) => !removed.has(tag))
    .join(",");
}

export type ValidationGapEdit = {
  readonly gaps: string[];
  /** Why the edit cannot be applied; the gaps are then unchanged. */
  readonly error: string | undefined;
};

/**
 * The stored validation gaps after appending new ones and removing others by
 * their exact text. Removing a gap that is not stored is an error, because the
 * caller believes something about the record that is not true.
 */
export function editValidationGaps(
  current: readonly string[],
  edits: {
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  },
): ValidationGapEdit {
  const remove = (edits.remove ?? []).map((gap) => gap.trim());
  const missing = remove.filter((gap) => !current.includes(gap));
  if (missing.length > 0) {
    return {
      gaps: [...current],
      error: `No stored validation gap reads ${missing.map((gap) => JSON.stringify(gap)).join(", ")}. Stored gaps: ${JSON.stringify(current)}.`,
    };
  }
  const gaps = current.filter((gap) => !remove.includes(gap));
  for (const gap of (edits.add ?? []).map((value) => value.trim())) {
    if (!gaps.includes(gap)) {
      gaps.push(gap);
    }
  }
  const invalid =
    gaps.length > VALIDATION_GAPS_MAX ||
    gaps.some((gap) => gap === "" || gap.length > VALIDATION_GAP_MAX_CHARS);
  return {
    gaps: invalid ? [...current] : gaps,
    error: invalid
      ? `A memory holds at most ${VALIDATION_GAPS_MAX} nonblank validation gaps of at most ${VALIDATION_GAP_MAX_CHARS} characters.`
      : undefined,
  };
}

/** A replacement keeping fewer than this share of the stored terms is a different fact. */
export const REPLACEMENT_MIN_OVERLAP = 0.15;
/** Below this many stored terms the share is noise: "Use bun." to "Use pnpm." is a normal edit. */
const REPLACEMENT_MIN_STORED_TERMS = 6;
const GUARD_IDENTIFIERS_CHECKED = 12;
const HOLDER_IDS_SHOWN = 3;

/**
 * The name an identifier stands for, without a trailing value or version:
 * `MAX_BYTES=2000` and `bun@1.3.2` are still present when the number changes.
 * Versions, dates and other tokens without a name return undefined; they
 * change legitimately and must not block an update.
 */
function identifierName(identifier: string): string | undefined {
  const name = identifier.split(/[=@]/)[0] ?? "";
  return /^\d/.test(name) || (name.match(/[a-z]/g) ?? []).length < 3
    ? undefined
    : name;
}

/**
 * Named things (paths, flags, symbols) of the stored content that the new
 * content no longer mentions, lowercased, at most twelve.
 */
export function droppedNames(previous: string, next: string): string[] {
  const nextLower = next.toLowerCase();
  const names: string[] = [];
  for (const identifier of extractQueryIdentifiers(previous)) {
    const name = identifierName(identifier);
    if (
      name !== undefined &&
      !nextLower.includes(name) &&
      !names.includes(name)
    ) {
      names.push(name);
    }
  }
  return names.slice(0, GUARD_IDENTIFIERS_CHECKED);
}

/** For each dropped name, the other active records whose content still carries it. */
export type NameHolders = ReadonlyMap<string, readonly number[]>;

/** One row per name: the ids of the other active records that contain it. */
export function nameHoldersQuery(input: {
  readonly repository: string;
  readonly excludeId: number;
  readonly names: readonly string[];
}) {
  return {
    sql: `SELECT j.value AS name,
      (SELECT group_concat(m.id) FROM memories m
        WHERE m.repository = ? AND m.status = 'active' AND m.id != ?
          AND instr(lower(m.content), j.value) > 0) AS ids
      FROM json_each(?) j`,
    params: [input.repository, input.excludeId, JSON.stringify(input.names)],
  };
}

const NameHolderRowSchema = Schema.Struct({
  name: Schema.String,
  ids: Schema.NullOr(Schema.String),
});

export function nameHoldersFromRows(rows: readonly JsonValue[]): NameHolders {
  const holders = new Map<string, number[]>();
  for (const raw of rows) {
    const row = Schema.decodeUnknownSync(NameHolderRowSchema)(raw);
    if (row.ids !== null && row.ids !== "") {
      holders.set(row.name, row.ids.split(",").map(Number));
    }
  }
  return holders;
}

/** The name as the stored content spells it; names are compared in lower case. */
function storedSpelling(stored: string, name: string): string {
  const at = stored.toLowerCase().indexOf(name);
  const spelled = at < 0 ? name : stored.slice(at, at + name.length);
  return spelled.toLowerCase() === name ? spelled : name;
}

export type ReplacementAssessment = {
  readonly action: "update" | "refuse";
  /** Share of terms the stored and the new content have in common, 0 to 1. */
  readonly text_overlap: number;
  /** Dropped names that no other active record carries, as the stored content spells them. */
  readonly orphaned_identifiers: string[];
  /** Dropped names other records still carry, with up to three of their ids. */
  readonly held_elsewhere: { identifier: string; ids: number[] }[];
  /** Why the update is refused and how to proceed; undefined when it goes through. */
  readonly refusal: string | undefined;
};

function replacementRefusal(
  input: { readonly id: number; readonly allowDropHint: string },
  facts: {
    readonly orphaned: readonly string[];
    readonly held: ReplacementAssessment["held_elsewhere"];
    readonly differentFact: boolean;
    readonly overlap: number;
  },
): string {
  const reasons: string[] = [];
  if (facts.orphaned.length > 0) {
    reasons.push(
      `it drops ${facts.orphaned.map((name) => `\`${name}\``).join(", ")}, which no other active record mentions`,
    );
  }
  if (facts.differentFact) {
    reasons.push(
      `the new content shares ${facts.overlap} of its terms with the stored content (a rewrite of the same fact shares at least ${REPLACEMENT_MIN_OVERLAP})`,
    );
  }
  const held =
    facts.held.length > 0
      ? ` Also dropped, but still held elsewhere: ${facts.held.map((entry) => `\`${entry.identifier}\` (${entry.ids.map((id) => `#${id}`).join(", ")})`).join(", ")}.`
      : "";
  return `Update of memory ${input.id} refused: ${reasons.join(", and ")}.${held} Nothing was written. If the stored details still hold, carry them over. If this is a different fact, add it as a new record and deprecate ${input.id} when it is obsolete. If the dropped details are obsolete, repeat the write with ${input.allowDropHint}.`;
}

/**
 * Whether new content may replace the stored content of a durable record. It
 * is refused when it drops a name no other active record carries, or when it
 * shares almost nothing with what it replaces. Status records are snapshots
 * and are always replaced.
 */
export function assessReplacement(input: {
  readonly id: number;
  readonly previous: string;
  readonly next: string;
  readonly memoryType: MemoryType;
  readonly holders: NameHolders;
  readonly allowDrop: boolean;
  /** How the caller overrides the refusal, such as `--allow-drop`. */
  readonly allowDropHint: string;
}): ReplacementAssessment {
  const overlap = compareMemoryFact(input.previous, input.next).similarity;
  const guarded =
    input.previous !== input.next && reviewsDependents(input.memoryType);
  const differentFact =
    overlap < REPLACEMENT_MIN_OVERLAP &&
    factTerms(input.previous).size >= REPLACEMENT_MIN_STORED_TERMS;
  const dropped = guarded ? droppedNames(input.previous, input.next) : [];
  const orphaned = dropped
    .filter((name) => !input.holders.has(name))
    .map((name) => storedSpelling(input.previous, name));
  const held = dropped
    .filter((name) => input.holders.has(name))
    .map((name) => ({
      identifier: storedSpelling(input.previous, name),
      ids: (input.holders.get(name) ?? []).slice(0, HOLDER_IDS_SHOWN),
    }));
  const refuse =
    guarded && !input.allowDrop && (orphaned.length > 0 || differentFact);
  return {
    action: refuse ? "refuse" : "update",
    text_overlap: overlap,
    orphaned_identifiers: orphaned,
    held_elsewhere: held,
    refusal: refuse
      ? replacementRefusal(input, { orphaned, held, differentFact, overlap })
      : undefined,
  };
}

export type DuplicateMatch = {
  readonly id: number;
  readonly text_overlap: number;
};

/**
 * The active record that already states nearly the same thing as a new one,
 * by the doctor's near-duplicate measure, or undefined.
 */
export function nearDuplicate(
  text: string,
  neighbours: ReadonlyArray<{ readonly id: number; readonly text: string }>,
): DuplicateMatch | undefined {
  const terms = factTerms(text);
  let best: DuplicateMatch | undefined;
  for (const neighbour of neighbours) {
    const overlap = jaccardSimilarity(terms, factTerms(neighbour.text));
    if (
      overlap >= NEAR_DUPLICATE_THRESHOLD &&
      (best === undefined || overlap > best.text_overlap)
    ) {
      best = { id: neighbour.id, text_overlap: overlap };
    }
  }
  return best;
}

/** How a caller names the two ways past a refused add, such as CLI flags. */
export type AddIntentHints = {
  readonly updateId: (id: number) => string;
  readonly createNew: string;
};

export function duplicateRefusal(
  duplicate: DuplicateMatch,
  hints: AddIntentHints,
): string {
  return `Memory #${duplicate.id} already states nearly the same thing (text_overlap ${duplicate.text_overlap}, at or above ${NEAR_DUPLICATE_THRESHOLD}). Nothing was written. To change that record, repeat the add with ${hints.updateId(duplicate.id)}. If this is a different fact, repeat it with ${hints.createNew}.`;
}

export type UpsertCandidate = {
  readonly id: number;
  readonly rank_score: number;
  readonly text_overlap: number;
  readonly memory_type: string;
  readonly content_head: string;
  readonly shared_identifiers: readonly string[];
};

/** Names the stored content and the new content both mention. */
export function sharedIdentifiers(stored: string, next: string): string[] {
  const nextLower = next.toLowerCase();
  return extractQueryIdentifiers(stored)
    .filter((identifier) => nextLower.includes(identifier))
    .slice(0, 6);
}

function candidateLine(candidate: UpsertCandidate): string {
  const shared =
    candidate.shared_identifiers.length > 0
      ? `, shares ${candidate.shared_identifiers.join(", ")}`
      : "";
  return `#${candidate.id} ${candidate.memory_type} ${JSON.stringify(candidate.content_head)} (rank_score ${candidate.rank_score}, text_overlap ${candidate.text_overlap}${shared})`;
}

/** Why a weak upsert match is refused: the bar, the candidates, and both ways forward. */
export function upsertRefusal(
  candidates: readonly UpsertCandidate[],
  minScore: number,
  hints: AddIntentHints,
): string {
  const best = candidates[0];
  if (best === undefined) {
    return "No candidate matched the upsert query.";
  }
  return `No record matches the upsert query strongly enough to update: the best candidate #${best.id} has rank_score ${best.rank_score} (needs ${minScore}) and text_overlap ${best.text_overlap} (needs ${UPSERT_MIN_SIMILARITY}). Candidates: ${candidates.map(candidateLine).join("; ")}. Nothing was written. If one of them states the same fact, repeat the add with ${hints.updateId(best.id)} (or that candidate's id). If this is a different fact, repeat it with ${hints.createNew}.`;
}
