-- 佳贝艾特多平台导入店铺名只作为同平台 Canonical store identity 的显式输入别名。
-- 不复制 StoreTopicRule，不改写历史 AuditTask.storeName，也不做平台前缀推断。
CREATE TEMP TABLE "_kabrita_store_alias_guard" (
  "canonicalCount" INTEGER NOT NULL CHECK ("canonicalCount" = 7),
  "collisionCount" INTEGER NOT NULL CHECK ("collisionCount" = 0)
);

WITH "aliases" (
  "id",
  "storeTopicRuleId",
  "commercePlatform",
  "alias",
  "normalizedAlias",
  "normalizedCanonical"
) AS (
  VALUES
    ('store-alias-kabrita-tmall-01', 'store-topic-tmall-05', 'TMALL', '天猫佳贝艾特海外旗舰店', '天猫佳贝艾特海外旗舰店', 'kabrita海外旗舰店'),
    ('store-alias-kabrita-tmall-02', 'store-topic-tmall-06', 'TMALL', '天猫佳贝艾特母婴海外旗舰店', '天猫佳贝艾特母婴海外旗舰店', 'kabrita母婴海外旗舰店'),
    ('store-alias-kabrita-douyin-01', 'store-topic-douyin_ecommerce-03', 'DOUYIN_ECOMMERCE', '抖音佳贝艾特海外旗舰店', '抖音佳贝艾特海外旗舰店', '佳贝艾特kabrita海外旗舰店'),
    ('store-alias-kabrita-jd-01', 'store-topic-jd-11', 'JD', '京东佳贝艾特(Kabrita)海外专卖店', '京东佳贝艾特(kabrita)海外专卖店', '佳贝艾特(kabrita)海外专卖店'),
    ('store-alias-kabrita-jd-02', 'store-topic-jd-13', 'JD', '京东佳贝艾特官方海外旗舰店', '京东佳贝艾特官方海外旗舰店', '佳贝艾特官方海外旗舰店'),
    ('store-alias-kabrita-jd-03', 'store-topic-jd-12', 'JD', '京东佳贝艾特海外京东自营旗舰店', '京东佳贝艾特海外京东自营旗舰店', '佳贝艾特海外京东自营旗舰店'),
    ('store-alias-kabrita-jd-04', 'store-topic-jd-14', 'JD', '京东佳贝艾特(Kabrita)海外旗舰店', '京东佳贝艾特(kabrita)海外旗舰店', '佳贝艾特(kabrita)海外旗舰店')
)
INSERT INTO "_kabrita_store_alias_guard" ("canonicalCount", "collisionCount")
SELECT
  (
    SELECT COUNT(*)
    FROM "aliases" AS "alias"
    INNER JOIN "store_topic_rules" AS "canonical"
      ON "canonical"."id" = "alias"."storeTopicRuleId"
      AND "canonical"."commercePlatform" = "alias"."commercePlatform"
      AND "canonical"."normalizedStoreName" = "alias"."normalizedCanonical"
      AND "canonical"."deletedAt" IS NULL
  ),
  (
    SELECT COUNT(*)
    FROM "aliases" AS "alias"
    WHERE EXISTS (
      SELECT 1
      FROM "store_topic_rules" AS "otherCanonical"
      WHERE "otherCanonical"."commercePlatform" = "alias"."commercePlatform"
        AND "otherCanonical"."normalizedStoreName" = "alias"."normalizedAlias"
        AND "otherCanonical"."id" <> "alias"."storeTopicRuleId"
        AND "otherCanonical"."deletedAt" IS NULL
    ) OR EXISTS (
      SELECT 1
      FROM "store_topic_entries" AS "entry"
      INNER JOIN "store_topic_rules" AS "entryRule"
        ON "entryRule"."id" = "entry"."storeTopicRuleId"
      WHERE "entryRule"."commercePlatform" = "alias"."commercePlatform"
        AND "entryRule"."deletedAt" IS NULL
        AND "entry"."normalizedTopic" = "alias"."normalizedAlias"
        AND "entry"."enabled" = true
        AND "entry"."deletedAt" IS NULL
        AND (
          "entry"."storeTopicRuleId" <> "alias"."storeTopicRuleId"
          OR "entry"."topicType" <> 'STORE_ALIAS'
        )
    ) OR EXISTS (
      SELECT 1
      FROM "store_topic_entries" AS "entry"
      WHERE "entry"."id" = "alias"."id"
        AND (
          "entry"."storeTopicRuleId" <> "alias"."storeTopicRuleId"
          OR "entry"."normalizedTopic" <> "alias"."normalizedAlias"
          OR "entry"."topicType" <> 'STORE_ALIAS'
        )
    )
  );

DROP TABLE "_kabrita_store_alias_guard";

WITH "aliases" (
  "id",
  "storeTopicRuleId",
  "topic",
  "normalizedTopic"
) AS (
  VALUES
    ('store-alias-kabrita-tmall-01', 'store-topic-tmall-05', '天猫佳贝艾特海外旗舰店', '天猫佳贝艾特海外旗舰店'),
    ('store-alias-kabrita-tmall-02', 'store-topic-tmall-06', '天猫佳贝艾特母婴海外旗舰店', '天猫佳贝艾特母婴海外旗舰店'),
    ('store-alias-kabrita-douyin-01', 'store-topic-douyin_ecommerce-03', '抖音佳贝艾特海外旗舰店', '抖音佳贝艾特海外旗舰店'),
    ('store-alias-kabrita-jd-01', 'store-topic-jd-11', '京东佳贝艾特(Kabrita)海外专卖店', '京东佳贝艾特(kabrita)海外专卖店'),
    ('store-alias-kabrita-jd-02', 'store-topic-jd-13', '京东佳贝艾特官方海外旗舰店', '京东佳贝艾特官方海外旗舰店'),
    ('store-alias-kabrita-jd-03', 'store-topic-jd-12', '京东佳贝艾特海外京东自营旗舰店', '京东佳贝艾特海外京东自营旗舰店'),
    ('store-alias-kabrita-jd-04', 'store-topic-jd-14', '京东佳贝艾特(Kabrita)海外旗舰店', '京东佳贝艾特(kabrita)海外旗舰店')
)
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
  "id",
  "storeTopicRuleId",
  "topic",
  "normalizedTopic",
  'STORE_ALIAS',
  0,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "aliases";

UPDATE "store_topic_entries"
SET
  "topicType" = 'STORE_ALIAS',
  "enabled" = true,
  "deletedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (
  'store-alias-kabrita-tmall-01',
  'store-alias-kabrita-tmall-02',
  'store-alias-kabrita-douyin-01',
  'store-alias-kabrita-jd-01',
  'store-alias-kabrita-jd-02',
  'store-alias-kabrita-jd-03',
  'store-alias-kabrita-jd-04'
);
