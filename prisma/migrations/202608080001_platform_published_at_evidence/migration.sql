-- Preserve the platform publication evidence separately from imported Excel
-- metadata. Existing records remain unchanged and are not backfilled.
ALTER TABLE "note_records" ADD COLUMN "publishedAtRaw" TEXT;
ALTER TABLE "note_records" ADD COLUMN "publishedAtSource" TEXT;
