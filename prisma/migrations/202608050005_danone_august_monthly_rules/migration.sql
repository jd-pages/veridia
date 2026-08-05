-- Campaign.month is the existing non-destructive monthly rule-set key.
-- Copy July into an independent August campaign without touching July rules,
-- audit tasks, audit results, or their stored rule snapshots.

INSERT OR IGNORE INTO "campaigns" (
  "id", "publishedKey", "ruleSource", "productId", "name", "month", "year",
  "startDate", "endDate", "minImageCount", "productImageRequired",
  "firstImageRequirement", "prohibitedImageGuidance", "bodyRequired",
  "minBodyLength", "publicRequired", "retentionDays", "rewardDescription",
  "visualReviewGuidance", "customerRegistrationNotes", "clickableTopicRequired",
  "ruleVersion", "status", "createdAt", "updatedAt"
)
SELECT
  'danone-campaign-202608', 'activity_danone_2026_08', 'LOCAL_DRAFT', NULL,
  '爱他美2026年8月小红书种草审核', '2026-08', 2026,
  '2026-08-01 00:00:00', '2026-08-31 00:00:00',
  "minImageCount", false, NULL, NULL, "bodyRequired", "minBodyLength",
  "publicRequired", "retentionDays", "rewardDescription", NULL,
  "customerRegistrationNotes", "clickableTopicRequired", 1, 'ACTIVE',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campaigns"
WHERE "name" = '爱他美2026年7月小红书种草审核'
  AND "month" = '2026-07'
LIMIT 1;

INSERT OR IGNORE INTO "campaign_products" (
  "id", "campaignId", "productId", "sortOrder", "createdAt"
)
SELECT
  'danone-202608-product-' || link."productId",
  target."id", link."productId", link."sortOrder", CURRENT_TIMESTAMP
FROM "campaigns" source
JOIN "campaign_products" link ON link."campaignId" = source."id"
JOIN "campaigns" target
  ON target."name" = '爱他美2026年8月小红书种草审核'
 AND target."month" = '2026-08'
WHERE source."name" = '爱他美2026年7月小红书种草审核'
  AND source."month" = '2026-07';

WITH mapped_rules AS (
  SELECT
    rule.*,
    CASE
      WHEN rule."topicCategory" = 'BRAND_COMMON'
        THEN 'topic_danone_202608_brand'
      WHEN rule."topicCategory" = 'PRODUCT_STAGE' AND rule."applicableStage" = 'IFFO_P1'
        THEN 'topic_danone_202608_iffo_p1'
      WHEN rule."topicCategory" = 'PRODUCT_STAGE' AND rule."applicableStage" = 'IFFO_2'
        THEN 'topic_danone_202608_iffo_2'
      WHEN rule."topicCategory" = 'PRODUCT_STAGE' AND rule."applicableStage" = 'GUM_3_4_1PLUS_2PLUS'
        THEN 'topic_danone_202608_gum'
      WHEN product."name" = '爱他美澳洲白金版'
        THEN 'topic_danone_202608_au'
      WHEN product."name" = '爱他美德国白金版'
        THEN 'topic_danone_202608_de'
      WHEN product."name" = '爱他美至熠'
        THEN 'topic_danone_202608_zhiyi'
      WHEN product."name" = '爱他美亲熠5HMO'
        THEN 'topic_danone_202608_qinyi'
      WHEN product."name" = '爱他美奇迹绿罐'
        THEN 'topic_danone_202608_green'
      ELSE NULL
    END AS "newKey"
  FROM "topic_rules" rule
  JOIN "campaigns" source ON source."id" = rule."campaignId"
  LEFT JOIN "products" product ON product."id" = rule."productId"
  WHERE source."name" = '爱他美2026年7月小红书种草审核'
    AND source."month" = '2026-07'
    AND rule."status" = 'ACTIVE'
)
INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "scope", "campaignId",
  "productId", "ruleType", "topicCategory", "applicableStage", "milkType",
  "topic", "exactMatch", "clickableRequired", "caseSensitive", "minCount",
  "sortOrder", "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  rule."newKey", rule."newKey", 'LOCAL_DRAFT', rule."brandName", rule."scope", target."id",
  rule."productId", rule."ruleType", rule."topicCategory", rule."applicableStage", rule."milkType",
  rule."topic", rule."exactMatch", rule."clickableRequired", rule."caseSensitive", rule."minCount",
  rule."sortOrder", 1, rule."status", rule."notes", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM mapped_rules rule
JOIN "campaigns" target
  ON target."name" = '爱他美2026年8月小红书种草审核'
 AND target."month" = '2026-08'
WHERE rule."newKey" IS NOT NULL;
