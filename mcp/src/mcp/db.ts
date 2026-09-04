import {
  composeEmbeddingText,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embeddingSizeReport,
  MAX_NAMESPACE_BYTES,
  validateEmbeddingText,
  type EmbeddingDocumentParts,
} from "@machine-memory/contract";
import { Schema } from "effect";
import type { McpBindings, MemoryRow } from "./types";

export const ROW_SELECT =
  "id, repository, content, tags, context, memory_type, status, certainty";

export function embeddingText(input: EmbeddingDocumentParts): string {
  return composeEmbeddingText(input);
}

export function assertMemoryEmbeddingBudget(
  input: EmbeddingDocumentParts,
): ReturnType<typeof embeddingSizeReport> {
  const text = validateEmbeddingText(embeddingText(input), "Document text");
  return embeddingSizeReport(text);
}

export function measureMemoryEmbeddingBudget(
  input: EmbeddingDocumentParts,
): ReturnType<typeof embeddingSizeReport> {
  return embeddingSizeReport(embeddingText(input));
}

export function validateNamespace(repository: string): void {
  if (new TextEncoder().encode(repository).byteLength > MAX_NAMESPACE_BYTES) {
    throw new Error(
      `repository must be at most ${MAX_NAMESPACE_BYTES} UTF-8 bytes.`,
    );
  }
}

const EmbeddingOutputSchema = Schema.Struct({
  data: Schema.Array(Schema.Array(Schema.Number)),
});

export async function embedText(ai: Ai, text: string): Promise<number[]> {
  const output = await ai.run(EMBEDDING_MODEL, { text: [text] });
  const parsed = Schema.decodeUnknownSync(EmbeddingOutputSchema)(output);
  const embedding = parsed.data[0];
  if (embedding === undefined || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Workers AI returned an embedding with an invalid dimension; expected ${EMBEDDING_DIMENSIONS}.`,
    );
  }
  return [...embedding];
}

export async function rowById(
  db: D1Database,
  repository: string,
  id: number,
): Promise<MemoryRow | undefined> {
  const result = await db
    .prepare(
      `SELECT ${ROW_SELECT} FROM memories WHERE repository = ? AND id = ?`,
    )
    .bind(repository, id)
    .first<MemoryRow>();
  return result ?? undefined;
}

export type InsertInput = {
  repository: string;
  content: string;
  tags: string;
  context: string;
  memory_type: string;
  status: string;
  certainty: string;
  source_agent: string;
  refs: string;
  expires_after_days: number | null;
};

export async function insertMemory(
  db: D1Database,
  input: InsertInput,
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO memories (
        repository, content, tags, context, memory_type, status,
        superseded_by, source_agent, last_updated_by, update_count,
        certainty, refs, expires_after_days, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      input.repository,
      input.content,
      input.tags,
      input.context,
      input.memory_type,
      input.status,
      input.source_agent,
      input.source_agent,
      input.certainty,
      input.refs,
      input.expires_after_days,
    )
    .run();
  return Number(result.meta.last_row_id);
}

export async function upsertVector(
  bindings: McpBindings,
  row: MemoryRow,
): Promise<void> {
  const values = await embedText(bindings.AI, embeddingText(row));
  await bindings.VECTORIZE.upsert([
    {
      id: String(row.id),
      namespace: row.repository,
      values,
      metadata: {
        status: row.status,
        memory_type: row.memory_type,
        certainty: row.certainty,
      },
    },
  ]);
}
