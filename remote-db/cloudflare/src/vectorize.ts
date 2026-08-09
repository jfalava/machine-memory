import * as Cloudflare from "alchemy/Cloudflare";
import type { Input } from "alchemy";
import { vectorIndexName } from "./config";

/**
 * The Vectorize index reserved for semantic embeddings of machine memories.
 *
 * Dimensions and metric are immutable once the index is created. The name is
 * versioned so a future embedding-model migration can create a replacement
 * index without silently mixing incompatible vectors.
 */
export const VectorIndex = Cloudflare.Vectorize.Index(
  "machine-memory-vector-index",
  {
    name: vectorIndexName,
    dimensions: 768,
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
