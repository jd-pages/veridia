ALTER TABLE "topic_rules" ADD COLUMN "brandName" TEXT;

UPDATE "products"
SET "brandName" = '达能'
WHERE "brandName" = '爱他美'
   OR "name" IN (
     '爱他美澳洲白金版',
     '爱他美德国白金版',
     '爱他美至熠',
     '爱他美亲熠5HMO',
     '爱他美奇迹绿罐'
   );

UPDATE "topic_rules"
SET "brandName" = COALESCE(
  (
    SELECT "products"."brandName"
    FROM "products"
    WHERE "products"."id" = "topic_rules"."productId"
  ),
  (
    SELECT "products"."brandName"
    FROM "campaign_products"
    INNER JOIN "products"
      ON "products"."id" = "campaign_products"."productId"
    WHERE "campaign_products"."campaignId" = "topic_rules"."campaignId"
    ORDER BY "campaign_products"."sortOrder" ASC
    LIMIT 1
  ),
  (
    SELECT "products"."brandName"
    FROM "campaigns"
    INNER JOIN "products"
      ON "products"."id" = "campaigns"."productId"
    WHERE "campaigns"."id" = "topic_rules"."campaignId"
  )
);

UPDATE "topic_rules"
SET "brandName" = '达能'
WHERE "brandName" IS NULL
  AND "topic" IN (
    '#爱他美新手爸妈日记',
    '#爱他美澳洲白金版',
    '#爱他美德国白金版',
    '#爱他美至熠',
    '#爱他美亲熠5HMO',
    '#爱他美奇迹绿罐',
    '#新生儿奶粉',
    '#二段奶粉推荐',
    '#三段奶粉推荐'
  );

CREATE INDEX "topic_rules_brandName_status_sortOrder_idx"
ON "topic_rules"("brandName", "status", "sortOrder");
