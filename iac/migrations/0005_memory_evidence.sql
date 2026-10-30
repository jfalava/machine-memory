-- Evidence metadata is canonical but never embedded. No backfill: [] means
-- unspecified, including on legacy verified rows.
ALTER TABLE memories ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memories ADD COLUMN validation_gaps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memory_history ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memory_history ADD COLUMN validation_gaps TEXT NOT NULL DEFAULT '[]';
