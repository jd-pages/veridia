ALTER TABLE "audit_tasks" ADD COLUMN "finalUrl" TEXT;
ALTER TABLE "audit_tasks" ADD COLUMN "pageTitle" TEXT;
ALTER TABLE "audit_tasks" ADD COLUMN "pageType" TEXT;
ALTER TABLE "audit_tasks" ADD COLUMN "redirectChain" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "audit_tasks" ADD COLUMN "failureEvidence" TEXT;

ALTER TABLE "note_records" ADD COLUMN "finalUrl" TEXT;
