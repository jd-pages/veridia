ALTER TABLE "note_records" ADD COLUMN "noteType" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "note_records" ADD COLUMN "imageExtractionStatus" TEXT NOT NULL DEFAULT 'NOT_CHECKED';

ALTER TABLE "audit_results" ADD COLUMN "noteType" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "audit_results" ADD COLUMN "imageExtractionStatus" TEXT NOT NULL DEFAULT 'NOT_CHECKED';
ALTER TABLE "audit_results" ADD COLUMN "imageStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED';

CREATE INDEX "audit_results_imageStatus_auditedAt_idx"
ON "audit_results"("imageStatus", "auditedAt");

-- 上一版关闭图片审核时把所有活动的最低数量统一归零，原值已经无法从该列恢复。
-- 系统原默认值和现行活动口径均为 2 张，因此仅恢复当前启用活动；历史审核结果不更新。
UPDATE "campaigns"
SET "minImageCount" = 2
WHERE "minImageCount" = 0
  AND "status" = 'ACTIVE'
  AND "deletedAt" IS NULL;
