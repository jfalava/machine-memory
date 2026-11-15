-- delivered_model names the embedding model of the vector the index holds for
-- a memory. The index is replaced when the model changes, so a memory whose
-- vector came from another model, or from before this column existed (NULL),
-- has no vector that semantic search can find until it is reindexed. Index
-- status and doctor report those memories as unindexed.
ALTER TABLE memory_vector_sync ADD COLUMN delivered_model TEXT;

-- queued_at exists since migration 0008, which shipped with the bge-m3 index:
-- a write queued since then and delivered afterwards is in that index.
UPDATE memory_vector_sync SET delivered_model = '@cf/baai/bge-m3'
WHERE queued_at > 0 AND delivered_generation = generation
  AND last_delivered_at >= queued_at;
