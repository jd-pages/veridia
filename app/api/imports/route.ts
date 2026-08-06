import { prisma } from "@/lib/db";
import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { countAuditResultsByImportRecord } from "@/lib/import-record-counts";

export const GET = withApiErrorBoundary(async function GET() {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const records = await prisma.importRecord.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        creator: { select: { displayName: true } },
        _count: { select: { auditBatches: true, auditTasks: true } },
      },
    });
  const resultCounts = await countAuditResultsByImportRecord(
    records.map((record) => record.id),
  );
  return ok(
    records.map(({ creator, _count, ...record }) => {
      let activityNames: string[] = [];
      try {
        const summary = JSON.parse(record.summary) as {
          activities?: Array<{ importedName?: string; officialName?: string }>;
        };
        activityNames = [...new Set((summary.activities || [])
          .map((item) => item.importedName || item.officialName || "")
          .filter(Boolean))];
      } catch {
        activityNames = [];
      }
      return {
        ...record,
        activityNames,
        creatorDisplayName: creator?.displayName || null,
        batchCount: _count.auditBatches,
        taskCount: _count.auditTasks,
        resultCount: resultCounts.get(record.id) || 0,
      };
    }),
    { headers: { "Cache-Control": "no-store" } },
  );
}, "读取导入记录");
