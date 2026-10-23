import "server-only";
import { prisma } from "@/lib/db";
import { createHash } from "node:crypto";
import { withAuditExtractionSnapshot } from "@/lib/audit-extraction-snapshot";
import { resultBoundNextReviewDate } from "@/lib/result-next-review-date";
import { readFollowUpContract, isResultFollowUpSource } from "@/lib/result-follow-up-contract";
import { createAutomaticBatchInTransaction } from "./batch-service";
import { parseStoredStringArray } from "@/lib/stored-json";

const scanCursorId = "result-follow-up:scan-cursor";

/** One persisted claim per original result/purpose, atomic with its task. No timer,
 * browser launch, login attempt or production-rule mutation in this service. */
export async function enqueueDueResultFollowUp(userId: string, now = new Date()) {
  const session = await prisma.automationSession.findUnique({ where: { platform: "XIAOHONGSHU" } });
  if (session?.status !== "READY") return { status: "LOGIN_RECOVERY_REQUIRED", batchId: null };
  return prisma.$transaction(async (tx) => {
    if (await tx.auditBatch.findFirst({ where: { clearedAt: null, status: { in: ["QUEUED", "RUNNING", "RESUMING", "PAUSED", "LOGIN_EXPIRED", "SECURITY_RESTRICTED"] } }, select: { id: true } })) {
      return { status: "EXISTING_BATCH_PRESERVED", batchId: null };
    }
    const cursorLog = await tx.operationLog.findUnique({ where: { id: scanCursorId }, select: { entityId: true } });
    const cursor = cursorLog?.entityId && await tx.auditResult.findUnique({ where: { id: cursorLog.entityId }, select: { id: true } });
    const rows = await tx.auditResult.findMany({
      where: { supersededAt: null, pageStatus: "NORMAL", autoStatus: { in: ["PASSED", "NEEDS_REVIEW"] },
        manualReviews: { none: {} }, task: { channel: "XIAOHONGSHU", source: { not: "RESULT_RETENTION_RECHECK" } },
        OR: [{ interactionTotal: null }, { retentionStatus: { in: ["PENDING", "UNKNOWN"] } }] },
      include: { task: true, note: { select: { id: true } }, extractionRecord: true },
      orderBy: [{ auditedAt: "asc" }, { id: "asc" }], take: 100,
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
    });
    // Keep every request bounded without starving rows behind the first page of
    // not-yet-due or already-claimed results. This cursor is not audit evidence.
    const saveCursor = async (id: string | null) => {
      const data = { userId, action: "RESULT_FOLLOW_UP_SCAN", entityType: "AUDIT_RESULT_SCAN",
        entityId: id, summary: "有界自动补采扫描位置（非审核结果）" };
      await tx.operationLog.upsert({ where: { id: scanCursorId }, create: { id: scanCursorId, ...data }, update: data });
    };
    for (const row of rows) {
      const contract = readFollowUpContract(row.ruleSnapshot, row.task);
      if (!contract) continue;
      const bound = withAuditExtractionSnapshot(row);
      const date = resultBoundNextReviewDate({ evidenceStatus: bound.evidenceStatus,
        publishedAt: bound.note.publishedAt, publishedAtRaw: bound.note.publishedAtRaw,
        publishedAtSource: bound.note.publishedAtSource });
      const missing = row.interactionTotal === null || date === null;
      const source = missing && !isResultFollowUpSource(row.task.source) ? "RESULT_DATA_SUPPLEMENT"
        : date && row.retentionDueAt && row.retentionDueAt.getTime() <= now.getTime() && row.retentionStatus === "PENDING" ? "RESULT_RETENTION_RECHECK" : null;
      if (!source) continue;
      const claimId = `result-follow-up:${row.id}:${source}`;
      if (await tx.operationLog.findUnique({ where: { id: claimId }, select: { id: true } }) ||
          await tx.auditTask.findFirst({ where: { replacesResultId: row.id, source }, select: { id: true } })) continue;
      // A stable unique log ID is the durable claim. Concurrent scanners cannot
      // commit a second batch, even on restart or after a failed extraction.
      await tx.operationLog.create({ data: { id: claimId, userId, action: source,
        entityType: "AUDIT_RESULT", entityId: row.id, summary: "自动补采/到期复核，历史采集及规则快照保持不变",
        metadata: JSON.stringify({ originalResultId: row.id, source,
          contractSha256: createHash("sha256").update(row.ruleSnapshot).digest("hex"), claimedAt: now.toISOString() }) } });
      const task = row.task;
      const batch = await createAutomaticBatchInTransaction(tx, {
        name: source === "RESULT_DATA_SUPPLEMENT" ? "业务数据自动补采" : "到期留存自动复核", source, createdBy: userId,
        productId: task.productId, campaignId: task.campaignId,
        tasks: [{ ...task, url: task.url, source, replacesResultId: row.id,
          expectedStoreTopics: parseStoredStringArray(task.expectedStoreTopics),
          requiredStoreTopics: parseStoredStringArray(task.requiredStoreTopics),
          // Keep import raw fields/customer service remarks; this is a new version.
          notes: task.notes, queueOrder: row.resultSlotOrder }],
      }, contract.rulePackageVersion || null);
      await saveCursor(rows.length === 100 ? row.id : null);
      return { status: "QUEUED", batchId: batch.id, originalResultId: row.id, source };
    }
    await saveCursor(rows.length === 100 ? rows.at(-1)!.id : null);
    return { status: rows.length === 100 ? "SCAN_CONTINUES" : "NO_ELIGIBLE_RECORD", batchId: null };
  });
}
