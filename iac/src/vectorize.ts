import * as Cloudflare from "@alchemy.run/cloudflare";
import { EMBEDDING_DIMENSIONS } from "@machine-memory/contract";
import type { Input } from "alchemy";

import { vectorIndexName } from "./config";

/**
 * The Vectorize index reserved for semantic embeddings of machine memories.
 *
 * Dimensions and metric are immutable once the index is created, and vectors
 * from different models must never share an index. The name is versioned:
 * raise it (vectorIndexName in deploy-config.ts) whenever EMBEDDING_MODEL
 * changes, then refill the new index with `machine-memory reindex`.
 */
export const VectorIndex = Cloudflare.Vectorize.Index(
  "machine-memory-vector-index",
  {
    name: vectorIndexName,
    dimensions: EMBEDDING_DIMENSIONS,
    metric: "cosine",
    description: "Semantic embeddings for machine-memory records.",
  },
);

/** Metadata indexes must exist before vectors using these fields are inserted. */
export const createVectorMetadataIndexes = (indexName: Input<string>) => ({
  status: Cloudflare.Vectorize.MetadataIndex("machine-memory-vector-status", {
    indexName,
    propertyName: "status",
    indexType: "string",
  }),
  memoryType: Cloudflare.Vectorize.MetadataIndex(
    "machine-memory-vector-memory-type",
    {
      indexName,
      propertyName: "memory_type",
      indexType: "string",
    },
  ),
  certainty: Cloudflare.Vectorize.MetadataIndex(
    "machine-memory-vector-certainty",
    {
      indexName,
      propertyName: "certainty",
      indexType: "string",
    },
  ),
});
