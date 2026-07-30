ALTER TABLE "rule_sync_states" ADD COLUMN "templateVersion" TEXT;
ALTER TABLE "rule_sync_states" ADD COLUMN "templateSchemaVersion" INTEGER;
ALTER TABLE "rule_sync_states" ADD COLUMN "templateConfigJson" TEXT;
