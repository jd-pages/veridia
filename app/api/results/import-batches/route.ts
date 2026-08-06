import { prisma } from "@/lib/db";
import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  buildImportBatchLabel,
  buildImportBatchSearchText,
} from "@/lib/import-batch";
import { countAuditResultsByImportRecord } from "@/lib/import-record-counts";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() || "";
  const limit = Math.min(
    Math.max(Number(searchParams.get("limit") || 100), 1),
    200,
  );
  const records = await prisma.importRecord.findMany({
    where: {
      importType: "AUDIT_TASK",
      status: "COMPLETED",
      auditTasks: { some: {} },
    },
    select: {
      id: true,
      fileName: true,
      createdAt: true,
      totalCount: true,
      validCount: true,
      invalidCount: true,
      skippedCount: true,
      createdBy: true,
      creator: { select: { displayName: true } },
      _count: { select: { auditBatches: true, auditTasks: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const resultCounts = await countAuditResultsByImportRecord(
    records.map((record) => record.id),
  );
  const data = records.map(({ _count, creator, ...record }) => {
    const creatorDisplayName = creator?.displayName || null;
    const labelInput = { ...record, creatorDisplayName };
    return {
      ...record,
      creatorDisplayName,
      resultCount: resultCounts.get(record.id) || 0,
      batchCount: _count.auditBatches,
      taskCount: _count.auditTasks,
      label: buildImportBatchLabel(labelInput),
      searchText: buildImportBatchSearchText(labelInput),
    };
  }).filter((record) =>
    query ? record.searchText.includes(query.toLocaleLowerCase("zh-CN")) : true,
  ).slice(0, limit);
  return ok(data, { headers: { "Cache-Control": "no-store" } });
}, "读取审核结果导入批次");
