ALTER TABLE "campaigns" ADD COLUMN "rewardMode" TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "campaigns" ADD COLUMN "basicRewardRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "campaigns" ADD COLUMN "baseRewardAmount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "campaign_interaction_reward_tiers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "campaign_interaction_reward_tiers_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "campaign_interaction_reward_tiers_campaignId_threshold_key" ON "campaign_interaction_reward_tiers"("campaignId", "threshold");
CREATE INDEX "campaign_interaction_reward_tiers_campaignId_sortOrder_idx" ON "campaign_interaction_reward_tiers"("campaignId", "sortOrder");

-- Materialize only the predicate used by the existing legacy audit context.
UPDATE "campaigns"
SET "basicRewardRequired" = true
WHERE "contentChannel" = 'XIAOHONGSHU'
  AND "name" = '佳贝艾特2026年8月小红书种草审核'
  AND (
    EXISTS (SELECT 1 FROM "products" p WHERE p."id" = "campaigns"."productId" AND TRIM(p."brandName") = '佳贝艾特')
    OR EXISTS (
      SELECT 1 FROM "campaign_products" cp JOIN "products" p ON p."id" = cp."productId"
      WHERE cp."campaignId" = "campaigns"."id" AND TRIM(p."brandName") = '佳贝艾特'
    )
  );
