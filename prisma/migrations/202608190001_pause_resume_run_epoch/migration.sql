-- Persist the batch runner generation and the generation that claimed a task.
-- Existing task and batch statuses are intentionally left untouched. Runtime
-- recovery decides whether a legacy PROCESSING row is safe to reconcile.
ALTER TABLE "audit_batches" ADD COLUMN "runEpoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "audit_tasks" ADD COLUMN "claimEpoch" INTEGER;
