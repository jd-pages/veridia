-- Reduce repeated wide AuditResult scans for live Dashboard and Results summaries.
CREATE INDEX "audit_results_supersededAt_autoStatus_pageStatus_auditedAt_idx"
ON "audit_results"("supersededAt", "autoStatus", "pageStatus", "auditedAt");

CREATE INDEX "audit_results_supersededAt_autoStatus_topicsCompliant_clickableCompliant_auditedAt_idx"
ON "audit_results"("supersededAt", "autoStatus", "topicsCompliant", "clickableCompliant", "auditedAt");
