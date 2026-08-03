import { prisma } from "@/lib/db";
import { runAuditTask } from "@/lib/audit-service";
import type { ExtractedNote } from "@/lib/types";
import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";

export async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    ids?: string[];
    action?: "RE_AUDIT" | "MANUAL_PASS" | "MANUAL_FAIL";
    comment?: string;
  };
  const ids = [...new Set(body.ids || [])].slice(0, 100);
  if (!ids.length || !body.action) return fail("请选择结果和批量操作");
  const results = await prisma.auditResult.findMany({
    where: { id: { in: ids } },
    include: {
      task: true,
      note: { include: { extractions: { orderBy: { extractedAt: "desc" }, take: 1 } } },
    },
  });
  let completed = 0;
  const errors: Array<{ id: string; reason: string }> = [];
  for (const result of results) {
    try {
      if (body.action === "RE_AUDIT") {
        const raw = result.note.extractions[0]?.rawData;
        if (!raw) throw new Error("没有可用的提取快照");
        await runAuditTask(result.task.id, JSON.parse(raw) as ExtractedNote);
      } else {
        await prisma.manualReview.create({
          data: {
            auditResultId: result.id,
            reviewerId: user.id,
            result: body.action === "MANUAL_PASS" ? "PASSED" : "FAILED",
            comment: body.comment?.trim() || "批量人工复核",
          },
        });
      }
      completed += 1;
    } catch (error) {
      errors.push({
        id: result.id,
        reason: error instanceof Error ? error.message : "操作失败",
      });
    }
  }
  await prisma.operationLog.create({
    data: {
      userId: user.id,
      action: `BULK_${body.action}`,
      entityType: "AUDIT_RESULT",
      summary: `批量操作完成 ${completed} 条，失败 ${errors.length} 条`,
      metadata: JSON.stringify({ ids }),
    },
  });
  return ok({ completed, errors });
}
