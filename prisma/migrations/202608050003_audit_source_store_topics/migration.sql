ALTER TABLE "audit_tasks" ADD COLUMN "channel" TEXT;
ALTER TABLE "audit_tasks" ADD COLUMN "commercePlatform" TEXT;
ALTER TABLE "audit_tasks" ADD COLUMN "expectedStoreTopic" TEXT;
ALTER TABLE "audit_tasks" ADD COLUMN "storeMappingStatus" TEXT;

UPDATE "audit_tasks"
SET "channel" = "platform"
WHERE "channel" IS NULL
  AND "platform" IN ('XIAOHONGSHU', 'DOUYIN');

CREATE INDEX "audit_tasks_channel_idx" ON "audit_tasks"("channel");
CREATE INDEX "audit_tasks_commercePlatform_idx" ON "audit_tasks"("commercePlatform");

ALTER TABLE "audit_results" ADD COLUMN "storeTopicStatus" TEXT NOT NULL DEFAULT 'NOT_CHECKED';
ALTER TABLE "audit_results" ADD COLUMN "expectedStoreTopic" TEXT;
ALTER TABLE "audit_results" ADD COLUMN "matchedStoreTopic" TEXT;
ALTER TABLE "audit_results" ADD COLUMN "storeTopicFailureReason" TEXT;
