import type { EmbeddingSizeReport } from "@machine-memory/contract";
import { assertMemoryEmbeddingBudget, rowById, upsertVector } from "./db";
import { errorResult, textMessage, textResult } from "./text";
import type { MemoryUpdateArgs } from "./tool-schemas";
import type {
  ErrorToolResult,
  McpBindings,
  MemoryRow,
  TextToolResult,
} from "./types";
import { updateClause } from "./write";
import { findBestMemoryMatch } from "./scoring";

export type UpdateTarget =
  | { readonly kind: "id"; readonly targetId: number }
  | {
      readonly kind: "matched";
      readonly targetId: number;
      readonly matched: {
        readonly query: string;
        readonly id: number;
        readonly score: number;
      };
    }
  | { readonly kind: "rejection"; readonly message: string }
  | { readonly kind: "empty"; readonly message: string };

export async function resolveUpdateTarget(
  db: D1Database,
  repository: string,
  id: number | undefined,
  match: string | undefined,
): Promise<UpdateTarget> {
  const matchQuery = match?.trim() || undefined;
  if (id !== undefined && matchQuery !== undefined) {
    return {
      kind: "rejection",
      message: "Provide either the numeric id or a match query, not both.",
    };
  }
  if (matchQuery !== undefined) {
    const best = await findBestMemoryMatch(db, repository, matchQuery);
    if (!best) {
      return {
        kind: "empty",
        message: `No active memory matched '${matchQuery}' in repository '${repository}'.`,
      };
    }
    return {
      kind: "matched",
      targetId: best.row.id,
      matched: { query: matchQuery, id: best.row.id, score: best.score },
    };
  }
  if (id === undefined) {
    return {
      kind: "rejection",
      message: "Provide either the numeric id or a match query.",
    };
  }
  return { kind: "id", targetId: id };
}

export type ResolvedUpdateTarget = Extract<
  UpdateTarget,
  { kind: "id" } | { kind: "matched" }
>;

function updateGuardResult(
  existing: MemoryRow | undefined,
  args: MemoryUpdateArgs,
  targetId: number,
): TextToolResult | ErrorToolResult | null {
  if (!existing) {
    return textMessage(
      `No memory found with id ${targetId} in repository '${args.repository}'. Verify the repository slug with list_repositories before retrying.`,
    );
  }
  if (args.superseded_by !== undefined && args.superseded_by === targetId) {
    return errorResult(new Error("A memory cannot supersede itself."));
  }
  const prospectiveType = args.memory_type ?? existing.memory_type;
  if (args.expires_after_days !== undefined && prospectiveType !== "status") {
    return errorResult(
      new Error("expires_after_days is only valid for status memories."),
    );
  }
  return null;
}

type ProspectiveMemoryDocument = {
  readonly content: string;
  readonly tags: string;
  readonly context: string;
  readonly memory_type: string;
  readonly status: string;
  readonly certainty: string;
};

function updateProspectiveDocument(
  existing: MemoryRow,
  args: MemoryUpdateArgs,
): ProspectiveMemoryDocument {
  return {
    content: args.content ?? existing.content,
    tags: args.tags ?? existing.tags,
    context: args.context ?? existing.context,
    memory_type: args.memory_type ?? existing.memory_type,
    status: args.status ?? existing.status,
    certainty: args.certainty ?? existing.certainty,
  };
}

export async function applyMemoryUpdate(
  bindings: McpBindings,
  args: MemoryUpdateArgs,
  target: ResolvedUpdateTarget,
): Promise<TextToolResult | ErrorToolResult> {
  const targetId = target.targetId;
  const existing = await rowById(bindings.DB, args.repository, targetId);
  const guard = updateGuardResult(existing, args, targetId);
  if (guard) {
    return guard;
  }
  if (!existing) {
    return textMessage(
      `No memory found with id ${targetId} in repository '${args.repository}'.`,
    );
  }
  const size = assertMemoryEmbeddingBudget(
    updateProspectiveDocument(existing, args),
  );
  const update = updateClause(args);
  if (update === null) {
    return updateNoopResult(existing, size, target);
  }
  await bindings.DB.prepare(
    `UPDATE memories SET ${update.sets.join(", ")} WHERE repository = ? AND id = ?`,
  )
    .bind(...update.params, args.repository, targetId)
    .run();
  const row = await rowById(bindings.DB, args.repository, targetId);
  if (row) {
    await upsertVector(bindings, row).catch((cause) => {
      console.error(
        `memory ${targetId} updated but vector sync failed: ${String(cause)}`,
      );
    });
  }
  return updateNoopResult(row ?? existing, size, target);
}

function updateNoopResult(
  row: MemoryRow,
  size: EmbeddingSizeReport,
  target: ResolvedUpdateTarget,
): TextToolResult {
  if (target.kind === "matched") {
    return textResult([{ ...row, size, matched: target.matched }]);
  }
  return textResult([{ ...row, size }]);
}
