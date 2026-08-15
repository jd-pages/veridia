import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { listAuditTaskDuplicateHistory } from "@/lib/audit-task-deduplication";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const url = new URL(request.url).searchParams.get("url")?.trim() || "";
  if (!url) return fail("缺少作品链接", 400);
  return ok(await listAuditTaskDuplicateHistory({ url }), {
    headers: { "Cache-Control": "no-store" },
  });
}, "读取重复笔记历史审核");
