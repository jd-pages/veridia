-- “爱他美优选海外专卖店”正式更名。
-- 原位复用 store-topic-jd-01；历史任务和审核结果仍通过同一 rule id 关联。
UPDATE "store_topic_entries"
SET
  "topicType" = 'ACCEPTED_ALIAS',
  "sortOrder" = 1,
  "enabled" = true,
  "deletedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "storeTopicRuleId" = 'store-topic-jd-01'
  AND "normalizedTopic" = '爱他美优选海外专卖店';

INSERT OR IGNORE INTO "store_topic_entries" (
  "id",
  "storeTopicRuleId",
  "topic",
  "normalizedTopic",
  "topicType",
  "sortOrder",
  "enabled",
  "createdAt",
  "updatedAt"
)
SELECT
  'accepted-store-topic-jd-01-aptamil-rename',
  "id",
  '#Aptamil爱他美海外优选进口超市',
  'aptamil爱他美海外优选进口超市',
  'ACCEPTED',
  0,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "store_topic_rules"
WHERE "id" = 'store-topic-jd-01'
  AND "commercePlatform" = 'JD';

UPDATE "store_topic_rules"
SET
  "storeName" = 'Aptamil爱他美海外优选进口超市',
  "normalizedStoreName" = 'aptamil爱他美海外优选进口超市',
  "expectedTopic" = '#Aptamil爱他美海外优选进口超市',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'store-topic-jd-01'
  AND "commercePlatform" = 'JD'
  AND "normalizedStoreName" = '爱他美优选海外专卖店';
