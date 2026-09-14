import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { kickAutomaticAuditQueue } from "@/lib/automation/queue";
import { runRetentionRecheckSweep } from "@/lib/automation/retention-recheck";
import { withAuditExtractionSnapshot } from "@/lib/audit-extraction-snapshot";
import { resolveRetentionDueAt } from "@/lib/retention-status";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  const result = await prisma.auditResult.findFirst({
    where: { id, supersededAt: null },
    include: { note: { select: { id: true } }, task: true, extractionRecord: true },
  });
  if (!result) return fail("审核结果不存在", 404);
  const snapshot = withAuditExtractionSnapshot(result);
  const retentionDueAt = resolveRetentionDueAt({
    retentionDueAt: result.retentionDueAt,
    retentionStatus: result.retentionStatus,
    ruleSnapshot: result.ruleSnapshot,
    note: snapshot.note,
  });
  if (!retentionDueAt) return fail("该结果没有可确认的留存复查日期");
  if (new Date(retentionDueAt).getTime() > Date.now()) {
    return fail(
      `尚未到留存复查日期：${new Date(retentionDueAt).toLocaleString("zh-CN")}`,
      409,
    );
  }

  const existing = await prisma.auditTask.findFirst({
    where: { replacesResultId: result.id },
    select: { batchId: true },
  });
  await runRetentionRecheckSweep();
  const replacement = existing || await prisma.auditTask.findFirst({
    where: { replacesResultId: result.id },
    select: { batchId: true },
  });
  if (!replacement?.batchId) return fail("该结果当前不满足自动留存复查条件", 409);
  if (!existing) {
    await prisma.operationLog.create({
      data: {
        userId: user.id,
        action: "CREATE_RETENTION_RECHECK",
        entityType: "AUDIT_RESULT",
        entityId: result.id,
        summary: "创建公开留存复查任务，原历史结果保持不变",
        metadata: JSON.stringify({ batchId: replacement.batchId }),
      },
    });
  }
  kickAutomaticAuditQueue();
  return ok({ batchId: replacement.batchId });
}
