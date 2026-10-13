-- Additive only: never change identities, templates, aliases or AuditResults.
CREATE TABLE "store_brand_topic_policies" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "storeTopicRuleId" TEXT NOT NULL,
  "brandName" TEXT NOT NULL,
  "contentChannel" TEXT NOT NULL,
  "requireStoreTopic" BOOLEAN NOT NULL DEFAULT false,
  "useSharedTemplate" BOOLEAN NOT NULL DEFAULT true,
  "topicConfig" TEXT NOT NULL DEFAULT '{"acceptedTopics":[],"requiredTopics":[]}',
  "reviewStatus" TEXT NOT NULL DEFAULT 'CONFIRMED',
  "managedBy" TEXT NOT NULL DEFAULT 'ADMIN',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "store_brand_topic_policies_storeTopicRuleId_fkey" FOREIGN KEY ("storeTopicRuleId") REFERENCES "store_topic_rules" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "store_brand_topic_policies_storeTopicRuleId_brandName_contentChannel_key" ON "store_brand_topic_policies"("storeTopicRuleId", "brandName", "contentChannel");
CREATE INDEX "store_brand_topic_policies_brandName_contentChannel_idx" ON "store_brand_topic_policies"("brandName", "contentChannel");
-- This is editable historical initialization, not a runtime brand whitelist.
-- Danone's prior global template contract is preserved. Nestle was explicitly
-- excluded. Other historical associations, including Kabrita, are not guessed.
INSERT INTO "store_brand_topic_policies"
  ("id","storeTopicRuleId","brandName","contentChannel","requireStoreTopic","reviewStatus","managedBy","updatedAt")
SELECT 'legacy-' || s."id" || '-' || b."brandName" || '-' || c.channel,
 s."id", b."brandName", c.channel,
 CASE WHEN b."brandName" = '达能' THEN EXISTS(
   SELECT 1 FROM "store_topic_entries" t WHERE t."storeTopicRuleId" = s."id" AND t."enabled" = true AND t."deletedAt" IS NULL
   AND (t."topicType" IN ('ACCEPTED','ACCEPTED_ALIAS') OR (c.channel = 'XIAOHONGSHU' AND t."topicType" = 'REQUIRED'))
 ) ELSE false END,
 CASE WHEN b."brandName" IN ('达能','雀巢') THEN 'CONFIRMED' ELSE 'PENDING_REVIEW' END,
 'LEGACY', CURRENT_TIMESTAMP
FROM "store_topic_rules" s
CROSS JOIN (SELECT DISTINCT "brandName" FROM "products" WHERE "deletedAt" IS NULL AND "brandName" <> '') b
CROSS JOIN (SELECT 'XIAOHONGSHU' AS channel UNION ALL SELECT 'DOUYIN') c;
