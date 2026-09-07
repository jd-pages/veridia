ALTER TABLE "campaigns" ADD COLUMN "interactionRewardEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "campaigns" ADD COLUMN "interactionRewardThreshold" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "audit_results" ADD COLUMN "likeCount" INTEGER;
ALTER TABLE "audit_results" ADD COLUMN "commentCount" INTEGER;
ALTER TABLE "audit_results" ADD COLUMN "favoriteCount" INTEGER;
ALTER TABLE "audit_results" ADD COLUMN "interactionTotal" INTEGER;
ALTER TABLE "audit_results" ADD COLUMN "interactionRewardThreshold" INTEGER;
ALTER TABLE "audit_results" ADD COLUMN "interactionRewardStatus" TEXT NOT NULL DEFAULT 'NOT_ENABLED';
