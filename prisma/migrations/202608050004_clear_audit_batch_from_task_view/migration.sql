ALTER TABLE "audit_batches" ADD COLUMN "clearedAt" DATETIME;
ALTER TABLE "audit_batches" ADD COLUMN "clearedBy" TEXT;

CREATE INDEX "audit_batches_clearedAt_createdAt_idx"
ON "audit_batches"("clearedAt", "createdAt");
