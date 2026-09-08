import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { runAuditTask } from "@/lib/audit-service";
import { createMockNote, isMockCase } from "@/lib/mock-data";
import { AuditSubmissionError } from "@/lib/audit-submission";
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
  try {
    const body = await request.json() as { mockCase?: unknown; extraction?: unknown };
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail("审核请求格式无效");
    let payload;
    if (body.extraction !== undefined) {
      assertExtractorPayload(body.extraction);
      payload = body.extraction;
    } else if (process.env.VERIDIA_E2E === "true" && isMockCase(body.mockCase)) {
      payload = createMockNote(body.mockCase);
      payload.url = task.url;
      payload.noteId = ["localhost", "127.0.0.1"].includes(new URL(task.url).hostname)
        ? `mock-${createHash("sha256").update(task.normalizedUrl).digest("hex").slice(0, 24)}`
        : null;
    } else {
      return fail("必须提供真实 extraction；模拟审核仅允许在 E2E 环境显式指定 mockCase", 400, "EXTRACTION_REQUIRED");
    }
    const result = await runAuditTask(id, payload, { source: "MANUAL" });
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
    if (error instanceof AuditSubmissionError) return fail(error.message, error.status, error.code);
    return fail(error instanceof Error ? error.message : "审核执行失败");
  }
}
