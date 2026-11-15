import { Schema } from "effect";

import { MAX_EMBEDDING_BYTES } from "./literals";

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** The fields of a memory that are embedded: everything a search should find. */
export type EmbeddingDocumentParts = {
  readonly content: string;
  readonly tags: string;
  readonly context: string;
};

/** Each field as it appears in the embedded text; an absent field is "". */
function embeddedParts(document: EmbeddingDocumentParts) {
  return {
    content: document.content,
    tags: document.tags ? `\nTags: ${document.tags}` : "",
    context: document.context ? `\nContext: ${document.context}` : "",
  };
}

/**
 * The text that is embedded for a memory (API, MCP and CLI). Memory type,
 * status and certainty are vector metadata, so they are not part of the text.
 * The SQL triggers in iac/migrations/0007 measure this same composition.
 */
export function composeEmbeddingText(document: EmbeddingDocumentParts): string {
  const parts = embeddedParts(document);
  return parts.content + parts.tags + parts.context;
}

export const EmbeddingSizeReportSchema = Schema.Struct({
  /** UTF-8 bytes of the embedded text: content, tags and context together. */
  bytes: Schema.Finite,
  max_bytes: Schema.Finite,
  within_budget: Schema.Boolean,
  over_by_bytes: Schema.Finite,
  remaining_bytes: Schema.Finite,
  /** Bytes each field contributes, its label and separator included. */
  parts: Schema.Struct({
    content: Schema.Finite,
    tags: Schema.Finite,
    context: Schema.Finite,
  }),
});
export type EmbeddingSizeReport = typeof EmbeddingSizeReportSchema.Type;

/**
 * Measures a memory against the one size limit: MAX_EMBEDDING_BYTES of
 * embedded text. A token is at least one byte, so text within the cap always
 * fits the embedding model and nothing needs to count tokens.
 */
export function embeddingSizeReport(
  document: EmbeddingDocumentParts,
): EmbeddingSizeReport {
  const parts = embeddedParts(document);
  const sizes = {
    content: utf8Bytes(parts.content),
    tags: utf8Bytes(parts.tags),
    context: utf8Bytes(parts.context),
  };
  const bytes = sizes.content + sizes.tags + sizes.context;
  const overBy = Math.max(0, bytes - MAX_EMBEDDING_BYTES);
  return {
    bytes,
    max_bytes: MAX_EMBEDDING_BYTES,
    within_budget: overBy === 0,
    over_by_bytes: overBy,
    remaining_bytes: MAX_EMBEDDING_BYTES - bytes,
    parts: sizes,
  };
}

const formatBytes = (value: number) => value.toLocaleString("en-US");

/** Leads with the number to act on: how many bytes to remove. */
export function embeddingBudgetMessage(
  label: string,
  report: EmbeddingSizeReport,
): string {
  return `${label} is over by ${formatBytes(report.over_by_bytes)} bytes of ${formatBytes(report.max_bytes)}: content ${formatBytes(report.parts.content)}, tags ${formatBytes(report.parts.tags)}, context ${formatBytes(report.parts.context)} bytes. Shorten it, or split it into one record per fact.`;
}

/** Why `text`, such as a search query, cannot be embedded; undefined when it fits. */
export function embeddingTextError(
  text: string,
  label: string,
): string | undefined {
  const overBy = utf8Bytes(text) - MAX_EMBEDDING_BYTES;
  return overBy > 0
    ? `${label} is over by ${formatBytes(overBy)} bytes of ${formatBytes(MAX_EMBEDDING_BYTES)}.`
    : undefined;
}

export function validateEmbeddingText(text: string, label: string): string {
  const error = embeddingTextError(text, label);
  if (error !== undefined) {
    throw new Error(error);
  }
  return text;
}
