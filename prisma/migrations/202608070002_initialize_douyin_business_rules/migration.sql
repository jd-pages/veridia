-- Initialize independent Douyin campaign/rule copies without modifying XHS data.
-- INSERT OR IGNORE keeps the migration idempotent and preserves later admin edits.

INSERT OR IGNORE INTO "campaigns" (
  "id", "publishedKey", "ruleSource", "productId", "name", "contentChannel",
  "month", "year", "startDate", "endDate", "minImageCount",
  "productImageRequired", "firstImageRequirement", "prohibitedImageGuidance",
  "bodyRequired", "minBodyLength", "publicRequired", "retentionDays",
  "rewardDescription", "visualReviewGuidance", "customerRegistrationNotes",
  "clickableTopicRequired", "ruleVersion", "status", "deletedAt",
  "createdAt", "updatedAt"
)
SELECT
  'douyin_' || source."id",
  'douyin_' || COALESCE(source."publishedKey", source."id"),
  'LOCAL_DRAFT',
  NULL,
  REPLACE(source."name", '小红书', '抖音'),
  'DOUYIN',
  source."month", source."year", source."startDate", source."endDate",
  source."minImageCount", source."productImageRequired",
  source."firstImageRequirement", source."prohibitedImageGuidance",
  source."bodyRequired", source."minBodyLength", source."publicRequired",
  source."retentionDays", source."rewardDescription",
  source."visualReviewGuidance", source."customerRegistrationNotes",
  source."clickableTopicRequired", source."ruleVersion", source."status", NULL,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campaigns" source
WHERE source."contentChannel" = 'XIAOHONGSHU'
  AND source."status" = 'ACTIVE'
  AND source."deletedAt" IS NULL
  AND instr(source."name", '小红书') > 0
  AND lower(source."name") NOT LIKE '%mock%'
  AND lower(source."name") NOT LIKE '%fixture%'
  AND lower(source."name") NOT LIKE '%e2e%'
  AND source."name" NOT LIKE '%测试%';

INSERT OR IGNORE INTO "campaign_products" (
  "id", "campaignId", "productId", "sortOrder", "createdAt"
)
SELECT
  'douyin_' || link."id",
  target."id",
  link."productId",
  link."sortOrder",
  CURRENT_TIMESTAMP
FROM "campaigns" source
JOIN "campaign_products" link ON link."campaignId" = source."id"
JOIN "campaigns" target
  ON target."publishedKey" = 'douyin_' || COALESCE(source."publishedKey", source."id")
WHERE source."contentChannel" = 'XIAOHONGSHU'
  AND source."status" = 'ACTIVE'
  AND source."deletedAt" IS NULL;

INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "contentChannel",
  "scope", "campaignId", "productId", "ruleType", "topicCategory",
  "applicableStage", "milkType", "topic", "exactMatch",
  "clickableRequired", "caseSensitive", "minCount", "sortOrder",
  "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  'douyin_' || rule."id",
  'douyin_' || COALESCE(rule."publishedKey", rule."id"),
  'LOCAL_DRAFT', rule."brandName", 'DOUYIN', rule."scope", target."id",
  rule."productId", rule."ruleType", rule."topicCategory",
  rule."applicableStage", rule."milkType", rule."topic", rule."exactMatch",
  rule."clickableRequired", rule."caseSensitive", rule."minCount",
  rule."sortOrder", rule."version", rule."status", rule."notes",
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "topic_rules" rule
JOIN "campaigns" source ON source."id" = rule."campaignId"
JOIN "campaigns" target
  ON target."publishedKey" = 'douyin_' || COALESCE(source."publishedKey", source."id")
WHERE rule."contentChannel" = 'XIAOHONGSHU'
  AND rule."status" = 'ACTIVE'
  AND CASE
    WHEN substr(trim(rule."topic"), 1, 1) = '#'
      THEN substr(trim(rule."topic"), 2)
    ELSE trim(rule."topic")
  END <> '爱他美新手爸妈日记';

-- Copy active global/product XHS rules once when such rules exist.
INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "contentChannel",
  "scope", "campaignId", "productId", "ruleType", "topicCategory",
  "applicableStage", "milkType", "topic", "exactMatch",
  "clickableRequired", "caseSensitive", "minCount", "sortOrder",
  "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  'douyin_' || rule."id",
  'douyin_' || COALESCE(rule."publishedKey", rule."id"),
  'LOCAL_DRAFT', rule."brandName", 'DOUYIN', rule."scope", NULL,
  rule."productId", rule."ruleType", rule."topicCategory",
  rule."applicableStage", rule."milkType", rule."topic", rule."exactMatch",
  rule."clickableRequired", rule."caseSensitive", rule."minCount",
  rule."sortOrder", rule."version", rule."status", rule."notes",
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "topic_rules" rule
WHERE rule."campaignId" IS NULL
  AND rule."contentChannel" = 'XIAOHONGSHU'
  AND rule."status" = 'ACTIVE'
  AND CASE
    WHEN substr(trim(rule."topic"), 1, 1) = '#'
      THEN substr(trim(rule."topic"), 2)
    ELSE trim(rule."topic")
  END <> '爱他美新手爸妈日记';
