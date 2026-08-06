-- Add stable import-source links without changing existing audit conclusions.
ALTER TABLE "audit_batches" ADD COLUMN "importRecordId" TEXT REFERENCES "import_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "audit_tasks" ADD COLUMN "importRecordId" TEXT REFERENCES "import_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "audit_batches_importRecordId_idx" ON "audit_batches"("importRecordId");
CREATE INDEX "audit_tasks_importRecordId_idx" ON "audit_tasks"("importRecordId");

-- Backfill only an unambiguous one-to-one legacy pairing. The batch name used by
-- formal Excel imports is deterministic; same-name imports remain unmatched when
-- more than one candidate exists in the ten-second window.
WITH "candidates" AS (
  SELECT
    "b"."id" AS "batchId",
    "i"."id" AS "importRecordId"
  FROM "audit_batches" AS "b"
  INNER JOIN "import_records" AS "i"
    ON "b"."source" = 'EXCEL'
   AND "i"."importType" = 'AUDIT_TASK'
   AND "i"."status" = 'COMPLETED'
   AND "b"."name" = ('表格自动审核 · ' || "i"."fileName")
   AND COALESCE("b"."createdBy", '') = COALESCE("i"."createdBy", '')
   AND "b"."totalCount" = "i"."validCount"
   AND ABS(CAST("b"."createdAt" AS INTEGER) - CAST("i"."createdAt" AS INTEGER)) <= 10000
  WHERE "b"."importRecordId" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "audit_batches" AS "linked_batch"
      WHERE "linked_batch"."importRecordId" = "i"."id"
    )
),
"unique_matches" AS (
  SELECT "candidate"."batchId", "candidate"."importRecordId"
  FROM "candidates" AS "candidate"
  WHERE (SELECT COUNT(*) FROM "candidates" AS "by_batch" WHERE "by_batch"."batchId" = "candidate"."batchId") = 1
    AND (SELECT COUNT(*) FROM "candidates" AS "by_import" WHERE "by_import"."importRecordId" = "candidate"."importRecordId") = 1
)
UPDATE "audit_batches"
SET "importRecordId" = (
  SELECT "unique_matches"."importRecordId"
  FROM "unique_matches"
  WHERE "unique_matches"."batchId" = "audit_batches"."id"
)
WHERE "id" IN (SELECT "batchId" FROM "unique_matches")
  AND "importRecordId" IS NULL;

UPDATE "audit_tasks"
SET "importRecordId" = (
  SELECT "audit_batches"."importRecordId"
  FROM "audit_batches"
  WHERE "audit_batches"."id" = "audit_tasks"."batchId"
)
WHERE "importRecordId" IS NULL
  AND "batchId" IN (
    SELECT "id" FROM "audit_batches" WHERE "importRecordId" IS NOT NULL
  );
