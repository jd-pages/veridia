-- STORE_ALIAS is an import identity alias, while ACCEPTED / ACCEPTED_ALIAS /
-- REQUIRED are page-topic requirements. The same normalized business text may
-- legitimately exist once in each semantic scope.
DROP INDEX "store_topic_entries_storeTopicRuleId_normalizedTopic_key";

CREATE UNIQUE INDEX "store_topic_entries_storeTopicRuleId_normalizedTopic_topicType_key"
  ON "store_topic_entries"("storeTopicRuleId", "normalizedTopic", "topicType");

-- Confirmed upstream names. Keep their independent clickable page topics.
INSERT OR IGNORE INTO "store_topic_entries" (
  "id", "storeTopicRuleId", "topic", "normalizedTopic", "topicType",
  "sortOrder", "enabled", "createdAt", "updatedAt"
)
SELECT
  'store-alias-rockcheck-rc-live-room',
  "id",
  '爱他美RC奶粉直播间',
  '爱他美rc奶粉直播间',
  'STORE_ALIAS',
  0,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "store_topic_rules"
WHERE "commercePlatform" = 'DOUYIN_ECOMMERCE'
  AND "normalizedStoreName" = 'rockcheck海外专营店'
  AND "deletedAt" IS NULL;

INSERT OR IGNORE INTO "store_topic_entries" (
  "id", "storeTopicRuleId", "topic", "normalizedTopic", "topicType",
  "sortOrder", "enabled", "createdAt", "updatedAt"
)
SELECT
  'store-alias-aptamil-overseas-preferred-legacy',
  "id",
  '爱他美优选海外专卖店',
  '爱他美优选海外专卖店',
  'STORE_ALIAS',
  0,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "store_topic_rules"
WHERE "commercePlatform" = 'JD'
  AND "normalizedStoreName" = 'aptamil爱他美海外优选进口超市'
  AND "deletedAt" IS NULL;
