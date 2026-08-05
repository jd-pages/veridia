ALTER TABLE "audit_tasks" ADD COLUMN "replacesResultId" TEXT;

CREATE INDEX "audit_tasks_replacesResultId_idx"
ON "audit_tasks"("replacesResultId");
