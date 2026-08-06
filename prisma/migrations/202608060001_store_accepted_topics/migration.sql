-- CreateTable
CREATE TABLE "store_topic_entries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "storeTopicRuleId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "normalizedTopic" TEXT NOT NULL,
  "topicType" TEXT NOT NULL DEFAULT 'ACCEPTED',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "deletedAt" DATETIME,
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_topic_entries_storeTopicRuleId_fkey"
    FOREIGN KEY ("storeTopicRuleId") REFERENCES "store_topic_rules" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- A topic cannot appear in both ACCEPTED and REQUIRED groups for one store.
CREATE UNIQUE INDEX "store_topic_entries_storeTopicRuleId_normalizedTopic_key"
  ON "store_topic_entries"("storeTopicRuleId", "normalizedTopic");

CREATE INDEX "store_topic_entries_storeTopicRuleId_topicType_enabled_deletedAt_sortOrder_idx"
  ON "store_topic_entries"("storeTopicRuleId", "topicType", "enabled", "deletedAt", "sortOrder");

-- Preserve each former single expectedTopic as the first ACCEPTED topic.
INSERT OR IGNORE INTO "store_topic_entries" (
  "id", "storeTopicRuleId", "topic", "normalizedTopic", "topicType",
  "sortOrder", "enabled", "createdBy", "updatedBy", "createdAt", "updatedAt"
)
SELECT
  'accepted-' || "id",
  "id",
  CASE
    WHEN substr(trim("expectedTopic"), 1, 1) = '#' THEN trim("expectedTopic")
    ELSE '#' || trim("expectedTopic")
  END,
  lower(CASE
    WHEN substr(trim("expectedTopic"), 1, 1) = '#' THEN substr(trim("expectedTopic"), 2)
    ELSE trim("expectedTopic")
  END),
  'ACCEPTED', 0, 1, "createdBy", "updatedBy", "createdAt", "updatedAt"
FROM "store_topic_rules"
WHERE trim("expectedTopic") <> '';

-- Twelve exact JD stores additionally require a separate clickable #京东.
INSERT OR IGNORE INTO "store_topic_entries" (
  "id", "storeTopicRuleId", "topic", "normalizedTopic", "topicType",
  "sortOrder", "enabled", "createdBy", "updatedBy", "createdAt", "updatedAt"
)
SELECT
  'required-jd-' || "id", "id", '#京东', '京东', 'REQUIRED', 0, 1,
  "createdBy", "updatedBy", "createdAt", "updatedAt"
FROM "store_topic_rules"
WHERE "commercePlatform" = 'JD'
  AND "normalizedStoreName" IN (
    '健康官方进口超市',
    '爱他美优选海外专卖店',
    'aptamil爱他美海外进口超市',
    '爱他美国际进口超市',
    'folo海外官方旗舰店',
    '国际平价会员店',
    '爱他美精选海外专卖店',
    '澳大利亚官方进口国家馆',
    '德国官方进口国家馆',
    '海星健康官方进口超市',
    '荷兰官方进口国家馆',
    '环球甄选旗舰店'
  );

-- Four exact TMALL stores additionally require a separate clickable #天猫.
INSERT OR IGNORE INTO "store_topic_entries" (
  "id", "storeTopicRuleId", "topic", "normalizedTopic", "topicType",
  "sortOrder", "enabled", "createdBy", "updatedBy", "createdAt", "updatedAt"
)
SELECT
  'required-tmall-' || "id", "id", '#天猫', '天猫', 'REQUIRED', 0, 1,
  "createdBy", "updatedBy", "createdAt", "updatedAt"
FROM "store_topic_rules"
WHERE "commercePlatform" = 'TMALL'
  AND "normalizedStoreName" IN (
    '爱他美金胜海外专卖店',
    'ayw海外专营店',
    'folo海外专营店',
    'bjf海外专营店'
  );

-- Two exact TAOBAO stores additionally require a separate clickable #淘宝.
INSERT OR IGNORE INTO "store_topic_entries" (
  "id", "storeTopicRuleId", "topic", "normalizedTopic", "topicType",
  "sortOrder", "enabled", "createdBy", "updatedBy", "createdAt", "updatedAt"
)
SELECT
  'required-taobao-' || "id", "id", '#淘宝', '淘宝', 'REQUIRED', 0, 1,
  "createdBy", "updatedBy", "createdAt", "updatedAt"
FROM "store_topic_rules"
WHERE "commercePlatform" = 'TAOBAO'
  AND "normalizedStoreName" IN (
    '国际进口超市',
    'alg阿莱购'
  );

-- Structured snapshots for new audits. Existing history keeps reading its
-- original single-value fields and is neither recalculated nor deleted.
ALTER TABLE "audit_tasks" ADD COLUMN "expectedStoreTopics" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "audit_tasks" ADD COLUMN "requiredStoreTopics" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "audit_results" ADD COLUMN "expectedStoreTopics" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "audit_results" ADD COLUMN "requiredStoreTopics" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "audit_results" ADD COLUMN "matchedStoreTopics" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "audit_results" ADD COLUMN "matchedRequiredStoreTopics" TEXT NOT NULL DEFAULT '[]';
