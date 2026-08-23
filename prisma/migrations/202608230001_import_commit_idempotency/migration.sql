-- A client-stable key makes import commit retries return the original import
-- instead of creating duplicate batches, tasks, results, or operation logs.
ALTER TABLE "import_records" ADD COLUMN "requestKey" TEXT;

CREATE UNIQUE INDEX "import_records_requestKey_key"
ON "import_records"("requestKey");
