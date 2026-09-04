import {
  UPSERT_DEFAULT_MIN_SCORE,
  UPSERT_MIN_SIMILARITY,
  type EmbeddingSizeReport,
} from "@machine-memory/contract";
import {
  assertMemoryEmbeddingBudget,
  insertMemory,
  rowById,
  upsertVector,
  validateNamespace,
} from "./db";
import { compareMemoryFact, contentHead } from "./facts";
import { detectMemoryConflicts, findBestMemoryMatch } from "./scoring";
import type { MemoryAddArgs } from "./tool-schemas";
import type { McpBindings, MemoryRow } from "./types";

export async function addMemory(
  bindings: McpBindings,
  args: MemoryAddArgs,
): Promise<{
  written_to: string;
  id: number;
  memory: MemoryRow;
  size: EmbeddingSizeReport;
  potential_conflicts: Array<MemoryRow & { score: number }>;
}> {
  validateNamespace(args.repository);
  const memory_type = args.memory_type ?? "convention";
  const certainty = args.certainty ?? "inferred";
  const status = args.status ?? "active";
  if (args.expires_after_days !== undefined && memory_type !== "status") {
    throw new Error("expires_after_days is only valid for status memories.");
  }
  const tags = args.tags ?? "";
  const context = args.context ?? "";
  const prospective = {
    content: args.content,
    tags,
    context,
    memory_type,
    status,
    certainty,
  };
  const size = assertMemoryEmbeddingBudget(prospective);
  const id = await insertMemory(bindings.DB, {
    repository: args.repository,
    content: args.content,
    tags,
    context,
    memory_type,
    status,
    certainty,
    source_agent: "mcp",
    refs: "[]",
    expires_after_days: args.expires_after_days ?? null,
  });
  const row = await rowById(bindings.DB, args.repository, id);
  if (row) {
    await upsertVector(bindings, row).catch((cause) => {
      console.error(
        `memory ${id} saved but vector sync failed: ${String(cause)}`,
      );
    });
  }
  const created: MemoryRow = row ?? {
    id,
    repository: args.repository,
    content: args.content,
    tags,
    context,
    memory_type,
    status,
    certainty,
  };
  const potential_conflicts = await detectMemoryConflicts(
    bindings.DB,
    args.repository,
    { content: args.content, tags, context },
  );
  return {
    written_to: args.repository,
    id: created.id,
    memory: created,
    size,
    potential_conflicts,
  };
}

export type UpsertMatchInfo = {
  readonly id: number;
  readonly score: number;
  readonly similarity: number;
  readonly memory_type: string;
  readonly status: string;
  readonly content_head: string;
};

export type MemoryWriteResult = {
  readonly mode?: string;
  readonly written_to: string;
  readonly id: number;
  readonly memory: MemoryRow;
  readonly size: EmbeddingSizeReport;
  readonly upsert_match?: UpsertMatchInfo;
  readonly potential_conflicts?: Array<MemoryRow & { score: number }>;
};

function upsertMatchInfo(
  row: MemoryRow,
  score: number,
  content: string,
  tags: string,
  context: string,
): UpsertMatchInfo {
  return {
    id: row.id,
    score,
    similarity: compareMemoryFact(
      [row.content, row.tags, row.context].join(" "),
      [content, tags, context].join(" "),
    ).similarity,
    memory_type: row.memory_type,
    status: row.status,
    content_head: contentHead(row.content),
  };
}

/**
 * Port of the CLI `add --upsert-match` flow: a strong match (similarity >=
 * 0.62 AND score >= threshold) is updated in place, otherwise a new record
 * is created. A weak match refuses to create unless `force` is true — the
 * MCP equivalent of the CLI's interactive confirm, since workers have no TTY.
 */
async function applyStrongUpsertUpdate(
  bindings: McpBindings,
  args: MemoryAddArgs,
  best: { row: MemoryRow; score: number },
  info: UpsertMatchInfo,
): Promise<MemoryWriteResult> {
  const prospective = {
    content: args.content,
    tags: args.tags ?? best.row.tags,
    context: args.context ?? best.row.context,
    memory_type: args.memory_type ?? best.row.memory_type,
    status: best.row.status,
    certainty: args.certainty ?? best.row.certainty,
  };
  const size = assertMemoryEmbeddingBudget(prospective);
  const update = updateClause({
    content: args.content,
    tags: args.tags,
    context: args.context,
    memory_type: args.memory_type,
    certainty: args.certainty,
    expires_after_days: args.expires_after_days,
    superseded_by: undefined,
  });
  if (update === null) {
    return {
      mode: "updated",
      id: best.row.id,
      written_to: args.repository,
      memory: best.row,
      size,
      upsert_match: info,
    };
  }
  await bindings.DB.prepare(
    `UPDATE memories SET ${update.sets.join(", ")} WHERE repository = ? AND id = ?`,
  )
    .bind(...update.params, args.repository, best.row.id)
    .run();
  const row = await rowById(bindings.DB, args.repository, best.row.id);
  if (row) {
    await upsertVector(bindings, row).catch((cause) => {
      console.error(
        `memory ${best.row.id} updated but vector sync failed: ${String(cause)}`,
      );
    });
  }
  return {
    mode: "updated",
    id: best.row.id,
    written_to: args.repository,
    memory: row ?? best.row,
    size,
    upsert_match: info,
  };
}

export async function addMemoryUpsert(
  bindings: McpBindings,
  args: MemoryAddArgs,
  upsertQuery: string,
): Promise<MemoryWriteResult> {
  validateNamespace(args.repository);
  const minScore = args.upsert_threshold ?? UPSERT_DEFAULT_MIN_SCORE;
  const memory_type = args.memory_type ?? "convention";
  if (args.expires_after_days !== undefined && memory_type !== "status") {
    throw new Error("expires_after_days is only valid for status memories.");
  }
  const tags = args.tags ?? "";
  const context = args.context ?? "";
  const best = await findBestMemoryMatch(
    bindings.DB,
    args.repository,
    upsertQuery,
  );
  if (!best) {
    return addMemory(bindings, args);
  }
  const info = upsertMatchInfo(
    best.row,
    best.score,
    args.content,
    tags,
    context,
  );
  const strong =
    info.similarity >= UPSERT_MIN_SIMILARITY && best.score >= minScore;
  if (!strong && !args.force) {
    throw new Error(
      `Best match #${info.id} is not a strong upsert match (score ${info.score}, similarity ${info.similarity}; needs score >= ${minScore} AND similarity >= ${UPSERT_MIN_SIMILARITY}). ` +
        `Refusing to silently create a new record: inspect it with memory_get, rerun with force true to create anyway, or lower the bar with upsert_threshold 0-100. ` +
        `Match: ${JSON.stringify(info)}`,
    );
  }
  if (!strong) {
    return { ...(await addMemory(bindings, args)), upsert_match: info };
  }
  return applyStrongUpsertUpdate(bindings, args, best, info);
}

export type UpdateClause = {
  sets: string[];
  params: (string | number)[];
};

function appendUpdate(
  clauses: UpdateClause,
  field: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    clauses.sets.push(`${field} = ?`);
    clauses.params.push(value);
  }
}

export function updateClause(args: {
  content?: string;
  tags?: string;
  context?: string;
  memory_type?: string;
  certainty?: string;
  status?: string;
  expires_after_days?: number;
  superseded_by?: number;
}): UpdateClause | null {
  const clauses: UpdateClause = { sets: [], params: [] };
  appendUpdate(clauses, "content", args.content);
  appendUpdate(clauses, "tags", args.tags);
  appendUpdate(clauses, "context", args.context);
  appendUpdate(clauses, "memory_type", args.memory_type);
  appendUpdate(clauses, "certainty", args.certainty);
  appendUpdate(clauses, "status", args.status);
  if (args.expires_after_days !== undefined) {
    clauses.sets.push("expires_after_days = ?");
    clauses.params.push(args.expires_after_days);
  }
  if (args.superseded_by !== undefined) {
    clauses.sets.push("superseded_by = ?");
    clauses.params.push(args.superseded_by);
  }
  if (clauses.sets.length === 0) {
    return null;
  }
  clauses.sets.push("updated_at = datetime('now')");
  clauses.sets.push("update_count = COALESCE(update_count, 0) + 1");
  return clauses;
}
