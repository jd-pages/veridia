import { prisma } from "@/lib/db";
import { runAuditTask } from "@/lib/audit-service";
import { createMockNote, type MockCase } from "@/lib/mock-data";
import { assertExtractorPayload } from "@/lib/extractor";
import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  const task = await prisma.auditTask.findUnique({ where: { id } });
  if (!task) return fail("任务不存在", 404);
  const body = (await request.json().catch(() => ({}))) as {
    mockCase?: MockCase;
    extraction?: unknown;
  };
  try {
    let payload;
    if (body.extraction) {
      assertExtractorPayload(body.extraction);
      payload = body.extraction;
    } else {
      const url = new URL(task.url);
      const inferred = (body.mockCase ||
        url.searchParams.get("case") ||
        "passed") as MockCase;
      payload = createMockNote(inferred);
      payload.url = task.url;
    }
    const result = await runAuditTask(id, payload);
    await prisma.operationLog.create({
      data: {
        userId: user.id,
        action: "RUN_AUDIT",
        entityType: "AUDIT_RESULT",
        entityId: result.id,
        summary: `执行审核，结果 ${result.autoStatus}`,
      },
    });
    return ok(result);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "审核执行失败");
  }
}
