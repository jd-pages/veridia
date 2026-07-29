import { prisma } from "@/lib/db";
import { assertExtractorPayload } from "@/lib/extractor";
import { normalizeUrl } from "@/lib/topic";
import { runAuditTask } from "@/lib/audit-service";
import {
  extensionFail,
  extensionOk,
  extensionOptions,
  hasValidExtensionToken,
} from "@/lib/extension-api";

export async function OPTIONS() {
  return extensionOptions();
}

export async function POST(request: Request) {
  if (!(await hasValidExtensionToken(request))) {
    return extensionFail("插件提交令牌无效", "INVALID_TOKEN", 401);
  }

  try {
    const body = (await request.json()) as {
      taskId?: string;
      extraction?: unknown;
    };
    assertExtractorPayload(body.extraction);
    const task = body.taskId
      ? await prisma.auditTask.findUnique({ where: { id: body.taskId } })
      : await prisma.auditTask.findFirst({
          where: {
            normalizedUrl: normalizeUrl(body.extraction.url),
            status: {
              in: [
                "PENDING",
                "READ_FAILED",
                "FAILED",
                "LOGIN_EXPIRED",
                "NEEDS_REVIEW",
              ],
            },
          },
          orderBy: { createdAt: "desc" },
        });
    if (!task) {
      return extensionFail(
        "未找到该链接的待审核任务，请先在后台创建任务",
        "TASK_NOT_FOUND",
        404,
      );
    }
    const result = await runAuditTask(task.id, body.extraction);
    return extensionOk({
      auditResultId: result.id,
      autoStatus: result.autoStatus,
      failureReasons: JSON.parse(result.failureReasons),
    });
  } catch (error) {
    return extensionFail(
      error instanceof Error ? error.message : "插件数据提交失败",
      "INVALID_PAYLOAD",
    );
  }
}
