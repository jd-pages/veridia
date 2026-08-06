-- ROCKCHECK海外专营店 accepts either its original store topic or
-- the independent clickable #爱他美RC奶粉直播间 topic.
INSERT OR IGNORE INTO "store_topic_entries" (
  "id", "storeTopicRuleId", "topic", "normalizedTopic", "topicType",
  "sortOrder", "enabled", "createdBy", "updatedBy", "createdAt", "updatedAt"
)
SELECT
  'accepted-rockcheck-rc-' || "id",
  "id",
  '#爱他美RC奶粉直播间',
  '爱他美rc奶粉直播间',
  'ACCEPTED',
  1,
  1,
  "createdBy",
  "updatedBy",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "store_topic_rules"
WHERE "commercePlatform" = 'DOUYIN_ECOMMERCE'
  AND "normalizedStoreName" = 'rockcheck海外专营店';
