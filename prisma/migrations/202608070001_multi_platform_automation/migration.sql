-- Add explicit content-channel scope without changing existing XIAOHONGSHU behavior.
ALTER TABLE "campaigns" ADD COLUMN "contentChannel" TEXT NOT NULL DEFAULT 'XIAOHONGSHU';
ALTER TABLE "topic_rules" ADD COLUMN "contentChannel" TEXT NOT NULL DEFAULT 'XIAOHONGSHU';
ALTER TABLE "audit_batches" ADD COLUMN "channel" TEXT;
ALTER TABLE "audit_batches" ADD COLUMN "queueOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "note_records" ADD COLUMN "contentChannel" TEXT;
ALTER TABLE "note_topics" ADD COLUMN "source" TEXT;
ALTER TABLE "import_records" ADD COLUMN "channelDistribution" TEXT NOT NULL DEFAULT '{}';

-- Historical records are backfilled only when their task lineage identifies one platform unambiguously.
UPDATE "note_records"
SET "contentChannel" = 'XIAOHONGSHU'
WHERE "id" IN (
  SELECT DISTINCT ar."noteId"
  FROM "audit_results" ar
  JOIN "audit_tasks" at ON at."id" = ar."auditTaskId"
  WHERE COALESCE(at."channel", at."platform") = 'XIAOHONGSHU'
)
AND "id" NOT IN (
  SELECT DISTINCT ar."noteId"
  FROM "audit_results" ar
  JOIN "audit_tasks" at ON at."id" = ar."auditTaskId"
  WHERE COALESCE(at."channel", at."platform") = 'DOUYIN'
);

UPDATE "note_records"
SET "contentChannel" = 'DOUYIN'
WHERE "id" IN (
  SELECT DISTINCT ar."noteId"
  FROM "audit_results" ar
  JOIN "audit_tasks" at ON at."id" = ar."auditTaskId"
  WHERE COALESCE(at."channel", at."platform") = 'DOUYIN'
)
AND "id" NOT IN (
  SELECT DISTINCT ar."noteId"
  FROM "audit_results" ar
  JOIN "audit_tasks" at ON at."id" = ar."auditTaskId"
  WHERE COALESCE(at."channel", at."platform") = 'XIAOHONGSHU'
);

DROP INDEX IF EXISTS "note_records_platformNoteId_key";
CREATE UNIQUE INDEX "note_records_contentChannel_platformNoteId_key"
  ON "note_records"("contentChannel", "platformNoteId");
DROP INDEX IF EXISTS "campaigns_month_status_idx";
CREATE INDEX "campaigns_contentChannel_month_status_idx"
  ON "campaigns"("contentChannel", "month", "status");
DROP INDEX IF EXISTS "topic_rules_scope_status_idx";
CREATE INDEX "topic_rules_contentChannel_scope_status_idx"
  ON "topic_rules"("contentChannel", "scope", "status");
CREATE INDEX "audit_batches_channel_status_idx"
  ON "audit_batches"("channel", "status");
CREATE INDEX "audit_batches_status_queueOrder_createdAt_idx"
  ON "audit_batches"("status", "queueOrder", "createdAt");
DROP INDEX IF EXISTS "note_records_pageStatus_idx";
CREATE INDEX "note_records_contentChannel_pageStatus_idx"
  ON "note_records"("contentChannel", "pageStatus");
