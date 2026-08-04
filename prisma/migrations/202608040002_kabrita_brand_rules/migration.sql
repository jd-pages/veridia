-- Existing client databases already have products before this migration runs.
-- Fresh databases are still empty here and receive the same data from the
-- built-in rule package during the normal seed step.

UPDATE "products"
SET
  "publishedKey" = 'product_kabrita_netherlands',
  "ruleSource" = 'LOCAL_DRAFT',
  "brandName" = '佳贝艾特',
  "seriesName" = '佳贝艾特荷兰版',
  "status" = 'ACTIVE',
  "deletedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "name" = '佳贝艾特荷兰版';

INSERT INTO "products" (
  "id", "publishedKey", "ruleSource", "code", "name", "brandName",
  "seriesName", "status", "createdAt", "updatedAt"
)
SELECT
  'kabrita-product-netherlands', 'product_kabrita_netherlands',
  'LOCAL_DRAFT', NULL, '佳贝艾特荷兰版', '佳贝艾特',
  '佳贝艾特荷兰版', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "products")
  AND NOT EXISTS (
    SELECT 1 FROM "products" WHERE "name" = '佳贝艾特荷兰版'
  );

UPDATE "products"
SET
  "publishedKey" = 'product_kabrita_hongkong',
  "ruleSource" = 'LOCAL_DRAFT',
  "brandName" = '佳贝艾特',
  "seriesName" = '佳贝艾特港版',
  "status" = 'ACTIVE',
  "deletedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "name" = '佳贝艾特港版';

INSERT INTO "products" (
  "id", "publishedKey", "ruleSource", "code", "name", "brandName",
  "seriesName", "status", "createdAt", "updatedAt"
)
SELECT
  'kabrita-product-hongkong', 'product_kabrita_hongkong',
  'LOCAL_DRAFT', NULL, '佳贝艾特港版', '佳贝艾特',
  '佳贝艾特港版', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "products")
  AND NOT EXISTS (
    SELECT 1 FROM "products" WHERE "name" = '佳贝艾特港版'
  );

INSERT OR IGNORE INTO "product_aliases" (
  "id", "productId", "alias", "createdAt"
)
SELECT
  'kabrita-alias-nl-short', "id", '荷兰版', CURRENT_TIMESTAMP
FROM "products" WHERE "name" = '佳贝艾特荷兰版';

INSERT OR IGNORE INTO "product_aliases" (
  "id", "productId", "alias", "createdAt"
)
SELECT
  'kabrita-alias-nl-cn', "id", '佳贝艾特荷兰', CURRENT_TIMESTAMP
FROM "products" WHERE "name" = '佳贝艾特荷兰版';

INSERT OR IGNORE INTO "product_aliases" (
  "id", "productId", "alias", "createdAt"
)
SELECT
  'kabrita-alias-nl-en', "id", 'Kabrita荷兰版', CURRENT_TIMESTAMP
FROM "products" WHERE "name" = '佳贝艾特荷兰版';

INSERT OR IGNORE INTO "product_aliases" (
  "id", "productId", "alias", "createdAt"
)
SELECT
  'kabrita-alias-hk-short', "id", '港版', CURRENT_TIMESTAMP
FROM "products" WHERE "name" = '佳贝艾特港版';

INSERT OR IGNORE INTO "product_aliases" (
  "id", "productId", "alias", "createdAt"
)
SELECT
  'kabrita-alias-hk-cn', "id", '佳贝艾特港版', CURRENT_TIMESTAMP
FROM "products" WHERE "name" = '佳贝艾特港版';

INSERT OR IGNORE INTO "product_aliases" (
  "id", "productId", "alias", "createdAt"
)
SELECT
  'kabrita-alias-hk-en', "id", 'Kabrita港版', CURRENT_TIMESTAMP
FROM "products" WHERE "name" = '佳贝艾特港版';

UPDATE "campaigns"
SET
  "publishedKey" = 'activity_kabrita_2026_08',
  "ruleSource" = 'LOCAL_DRAFT',
  "productId" = NULL,
  "year" = 2026,
  "startDate" = '2026-08-01 00:00:00',
  "endDate" = '2026-08-31 00:00:00',
  "minImageCount" = 3,
  "bodyRequired" = true,
  "minBodyLength" = 50,
  "publicRequired" = true,
  "retentionDays" = 0,
  "rewardDescription" = NULL,
  "customerRegistrationNotes" = '视频笔记沿用现有视频审核逻辑；视频时长、宝宝与产品同框等暂无法自动判断的内容进入人工复核。',
  "clickableTopicRequired" = true,
  "ruleVersion" = 1,
  "status" = 'ACTIVE',
  "deletedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "name" = '佳贝艾特2026年8月小红书种草审核'
  AND "month" = '2026-08';

INSERT INTO "campaigns" (
  "id", "publishedKey", "ruleSource", "productId", "name", "month",
  "year", "startDate", "endDate", "minImageCount", "bodyRequired",
  "minBodyLength", "publicRequired", "retentionDays",
  "customerRegistrationNotes", "clickableTopicRequired", "ruleVersion",
  "status", "createdAt", "updatedAt"
)
SELECT
  'kabrita-campaign-202608', 'activity_kabrita_2026_08', 'LOCAL_DRAFT',
  NULL, '佳贝艾特2026年8月小红书种草审核', '2026-08', 2026,
  '2026-08-01 00:00:00', '2026-08-31 00:00:00', 3, true, 50, true,
  0,
  '视频笔记沿用现有视频审核逻辑；视频时长、宝宝与产品同框等暂无法自动判断的内容进入人工复核。',
  true, 1, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM "products" WHERE "name" = '佳贝艾特荷兰版'
)
  AND EXISTS (
    SELECT 1 FROM "products" WHERE "name" = '佳贝艾特港版'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "campaigns"
    WHERE "name" = '佳贝艾特2026年8月小红书种草审核'
      AND "month" = '2026-08'
  );

INSERT OR IGNORE INTO "campaign_products" (
  "id", "campaignId", "productId", "sortOrder", "createdAt"
)
SELECT
  'kabrita-campaign-product-netherlands', campaign."id", product."id", 0,
  CURRENT_TIMESTAMP
FROM "campaigns" campaign, "products" product
WHERE campaign."name" = '佳贝艾特2026年8月小红书种草审核'
  AND campaign."month" = '2026-08'
  AND product."name" = '佳贝艾特荷兰版';

INSERT OR IGNORE INTO "campaign_products" (
  "id", "campaignId", "productId", "sortOrder", "createdAt"
)
SELECT
  'kabrita-campaign-product-hongkong', campaign."id", product."id", 1,
  CURRENT_TIMESTAMP
FROM "campaigns" campaign, "products" product
WHERE campaign."name" = '佳贝艾特2026年8月小红书种草审核'
  AND campaign."month" = '2026-08'
  AND product."name" = '佳贝艾特港版';

INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "scope",
  "campaignId", "productId", "ruleType", "topicCategory",
  "applicableStage", "milkType", "topic", "exactMatch",
  "clickableRequired", "caseSensitive", "minCount", "sortOrder",
  "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  'kabrita-topic-required', 'topic_kabrita_required_campaign',
  'LOCAL_DRAFT', '佳贝艾特', 'CAMPAIGN', campaign."id", NULL,
  'REQUIRED', 'BRAND_COMMON', NULL, NULL, '#初见小温柔成长更友好', true,
  true, false, 1, 10, 1, 'ACTIVE', '佳贝艾特活动必带话题',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campaigns" campaign
WHERE campaign."name" = '佳贝艾特2026年8月小红书种草审核'
  AND campaign."month" = '2026-08';

INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "scope",
  "campaignId", "productId", "ruleType", "topicCategory",
  "applicableStage", "milkType", "topic", "exactMatch",
  "clickableRequired", "caseSensitive", "minCount", "sortOrder",
  "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  'kabrita-topic-product-netherlands', 'topic_kabrita_product_netherlands',
  'LOCAL_DRAFT', '佳贝艾特', 'CAMPAIGN', campaign."id", product."id",
  'REQUIRED', 'PRODUCT_COMMON', NULL, NULL, '#佳贝艾特荷兰版', true,
  true, false, 1, 20, 1, 'ACTIVE', '荷兰版产品标签',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campaigns" campaign, "products" product
WHERE campaign."name" = '佳贝艾特2026年8月小红书种草审核'
  AND campaign."month" = '2026-08'
  AND product."name" = '佳贝艾特荷兰版';

INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "scope",
  "campaignId", "productId", "ruleType", "topicCategory",
  "applicableStage", "milkType", "topic", "exactMatch",
  "clickableRequired", "caseSensitive", "minCount", "sortOrder",
  "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  'kabrita-topic-product-hongkong', 'topic_kabrita_product_hongkong',
  'LOCAL_DRAFT', '佳贝艾特', 'CAMPAIGN', campaign."id", product."id",
  'REQUIRED', 'PRODUCT_COMMON', NULL, NULL, '#佳贝艾特港版', true,
  true, false, 1, 30, 1, 'ACTIVE', '港版产品标签',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campaigns" campaign, "products" product
WHERE campaign."name" = '佳贝艾特2026年8月小红书种草审核'
  AND campaign."month" = '2026-08'
  AND product."name" = '佳贝艾特港版';

INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "scope",
  "campaignId", "productId", "ruleType", "topicCategory",
  "applicableStage", "milkType", "topic", "exactMatch",
  "clickableRequired", "caseSensitive", "minCount", "sortOrder",
  "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  'kabrita-topic-popular-infant', 'topic_kabrita_popular_infant',
  'LOCAL_DRAFT', '佳贝艾特', 'CAMPAIGN', campaign."id", NULL,
  'ANY', 'POPULAR', NULL, NULL, '#羊奶粉推荐婴儿', true, true, false,
  2, 40, 1, 'ACTIVE', '热门话题4选2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campaigns" campaign
WHERE campaign."name" = '佳贝艾特2026年8月小红书种草审核'
  AND campaign."month" = '2026-08';

INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "scope",
  "campaignId", "productId", "ruleType", "topicCategory",
  "applicableStage", "milkType", "topic", "exactMatch",
  "clickableRequired", "caseSensitive", "minCount", "sortOrder",
  "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  'kabrita-topic-popular-digest', 'topic_kabrita_popular_digest',
  'LOCAL_DRAFT', '佳贝艾特', 'CAMPAIGN', campaign."id", NULL,
  'ANY', 'POPULAR', NULL, NULL, '#好消化吸收的奶粉', true, true, false,
  2, 50, 1, 'ACTIVE', '热门话题4选2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campaigns" campaign
WHERE campaign."name" = '佳贝艾特2026年8月小红书种草审核'
  AND campaign."month" = '2026-08';

INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "scope",
  "campaignId", "productId", "ruleType", "topicCategory",
  "applicableStage", "milkType", "topic", "exactMatch",
  "clickableRequired", "caseSensitive", "minCount", "sortOrder",
  "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  'kabrita-topic-popular-sensitivity', 'topic_kabrita_popular_sensitivity',
  'LOCAL_DRAFT', '佳贝艾特', 'CAMPAIGN', campaign."id", NULL,
  'ANY', 'POPULAR', NULL, NULL, '#不易敏敏', true, true, false,
  2, 60, 1, 'ACTIVE', '热门话题4选2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campaigns" campaign
WHERE campaign."name" = '佳贝艾特2026年8月小红书种草审核'
  AND campaign."month" = '2026-08';

INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "scope",
  "campaignId", "productId", "ruleType", "topicCategory",
  "applicableStage", "milkType", "topic", "exactMatch",
  "clickableRequired", "caseSensitive", "minCount", "sortOrder",
  "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  'kabrita-topic-popular-brand', 'topic_kabrita_popular_brand',
  'LOCAL_DRAFT', '佳贝艾特', 'CAMPAIGN', campaign."id", NULL,
  'ANY', 'POPULAR', NULL, NULL, '#佳贝艾特羊奶粉', true, true, false,
  2, 70, 1, 'ACTIVE', '热门话题4选2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campaigns" campaign
WHERE campaign."name" = '佳贝艾特2026年8月小红书种草审核'
  AND campaign."month" = '2026-08';

INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "scope",
  "campaignId", "productId", "ruleType", "topicCategory",
  "applicableStage", "milkType", "topic", "exactMatch",
  "clickableRequired", "caseSensitive", "minCount", "sortOrder",
  "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  'kabrita-topic-stage-iffo-p1', 'topic_kabrita_stage_iffo_p1',
  'LOCAL_DRAFT', '佳贝艾特', 'CAMPAIGN', campaign."id", NULL,
  'REQUIRED', 'PRODUCT_STAGE', 'IFFO_P1', 'IFFO',
  '#初见小温柔成长更友好', true, true, false, 1, 80, 1, 'ACTIVE',
  '佳贝艾特通用阶段话题', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campaigns" campaign
WHERE campaign."name" = '佳贝艾特2026年8月小红书种草审核'
  AND campaign."month" = '2026-08';

INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "scope",
  "campaignId", "productId", "ruleType", "topicCategory",
  "applicableStage", "milkType", "topic", "exactMatch",
  "clickableRequired", "caseSensitive", "minCount", "sortOrder",
  "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  'kabrita-topic-stage-iffo-2', 'topic_kabrita_stage_iffo_2',
  'LOCAL_DRAFT', '佳贝艾特', 'CAMPAIGN', campaign."id", NULL,
  'REQUIRED', 'PRODUCT_STAGE', 'IFFO_2', 'IFFO',
  '#初见小温柔成长更友好', true, true, false, 1, 90, 1, 'ACTIVE',
  '佳贝艾特通用阶段话题', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campaigns" campaign
WHERE campaign."name" = '佳贝艾特2026年8月小红书种草审核'
  AND campaign."month" = '2026-08';

INSERT OR IGNORE INTO "topic_rules" (
  "id", "publishedKey", "ruleSource", "brandName", "scope",
  "campaignId", "productId", "ruleType", "topicCategory",
  "applicableStage", "milkType", "topic", "exactMatch",
  "clickableRequired", "caseSensitive", "minCount", "sortOrder",
  "version", "status", "notes", "createdAt", "updatedAt"
)
SELECT
  'kabrita-topic-stage-gum', 'topic_kabrita_stage_gum',
  'LOCAL_DRAFT', '佳贝艾特', 'CAMPAIGN', campaign."id", NULL,
  'REQUIRED', 'PRODUCT_STAGE', 'GUM_3_4_1PLUS_2PLUS', 'GUM',
  '#初见小温柔成长更友好', true, true, false, 1, 100, 1, 'ACTIVE',
  '佳贝艾特通用阶段话题', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "campaigns" campaign
WHERE campaign."name" = '佳贝艾特2026年8月小红书种草审核'
  AND campaign."month" = '2026-08';

UPDATE "rule_sync_states"
SET
  "countsJson" = json_object(
    'products', (SELECT COUNT(*) FROM "products" WHERE "deletedAt" IS NULL),
    'activities', (SELECT COUNT(*) FROM "campaigns" WHERE "deletedAt" IS NULL),
    'stageGroups', (SELECT COUNT(*) FROM "rule_stage_groups"),
    'topicRules', (SELECT COUNT(*) FROM "topic_rules")
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'active';
