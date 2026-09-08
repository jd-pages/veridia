-- Previous results did not record an extraction identity. Timestamp proximity or
-- the latest note extraction cannot prove which evidence was audited: leave NULL.
ALTER TABLE "audit_results" ADD COLUMN "extractionRecordId" TEXT
  REFERENCES "extraction_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "audit_results_extractionRecordId_idx" ON "audit_results"("extractionRecordId");
