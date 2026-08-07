-- Preserve every audit result version while keeping one stable visible slot.
-- Existing rows remain current. For legacy in-place re-audits, recover the
-- original task only when a single unambiguous import-row candidate exists.

ALTER TABLE "audit_results" ADD COLUMN "originTaskId" TEXT;
ALTER TABLE "audit_results" ADD COLUMN "resultSlotOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "audit_results" ADD COLUMN "resultSlotCreatedAt" DATETIME;
ALTER TABLE "audit_results" ADD COLUMN "supersededAt" DATETIME;
ALTER TABLE "audit_results" ADD COLUMN "supersededByResultId" TEXT;

UPDATE "audit_results"
SET "originTaskId" = "auditTaskId"
WHERE "originTaskId" IS NULL;

WITH "legacy_origin_candidates" AS (
  SELECT
    "result"."id" AS "resultId",
    MIN("origin"."id") AS "originTaskId",
    COUNT(*) AS "candidateCount"
  FROM "audit_results" AS "result"
  JOIN "audit_tasks" AS "replacement"
    ON "replacement"."id" = "result"."auditTaskId"
   AND "replacement"."replacesResultId" = "result"."id"
  JOIN "audit_tasks" AS "origin"
    ON "origin"."id" <> "replacement"."id"
   AND "origin"."replacesResultId" IS NULL
   AND "origin"."importRecordId" = "replacement"."importRecordId"
   AND "origin"."normalizedUrl" = "replacement"."normalizedUrl"
   AND "origin"."productId" = "replacement"."productId"
   AND "origin"."orderNumber" IS "replacement"."orderNumber"
   AND "origin"."createdAt" < "replacement"."createdAt"
  WHERE "replacement"."importRecordId" IS NOT NULL
  GROUP BY "result"."id"
)
UPDATE "audit_results"
SET "originTaskId" = (
  SELECT "originTaskId"
  FROM "legacy_origin_candidates"
  WHERE "resultId" = "audit_results"."id"
    AND "candidateCount" = 1
)
WHERE "id" IN (
  SELECT "resultId"
  FROM "legacy_origin_candidates"
  WHERE "candidateCount" = 1
);

UPDATE "audit_results"
SET "resultSlotOrder" = COALESCE(
  (
    SELECT "task"."queueOrder"
    FROM "audit_tasks" AS "task"
    WHERE "task"."id" = "audit_results"."originTaskId"
  ),
  0
);

UPDATE "audit_results"
SET "resultSlotCreatedAt" = COALESCE(
  (
    SELECT "import"."createdAt"
    FROM "audit_tasks" AS "task"
    JOIN "import_records" AS "import"
      ON "import"."id" = "task"."importRecordId"
    WHERE "task"."id" = "audit_results"."originTaskId"
  ),
  (
    SELECT "batch"."createdAt"
    FROM "audit_tasks" AS "task"
    JOIN "audit_batches" AS "batch"
      ON "batch"."id" = "task"."batchId"
    WHERE "task"."id" = "audit_results"."originTaskId"
  ),
  (
    SELECT "task"."createdAt"
    FROM "audit_tasks" AS "task"
    WHERE "task"."id" = "audit_results"."originTaskId"
  ),
  "createdAt"
)
WHERE "resultSlotCreatedAt" IS NULL;

CREATE INDEX "audit_results_originTaskId_idx"
ON "audit_results"("originTaskId");

CREATE INDEX "audit_results_supersededByResultId_idx"
ON "audit_results"("supersededByResultId");

CREATE INDEX "audit_results_supersededAt_resultSlotCreatedAt_resultSlotOrder_idx"
ON "audit_results"("supersededAt", "resultSlotCreatedAt", "resultSlotOrder");
