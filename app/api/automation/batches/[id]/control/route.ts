import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { controlAutomaticBatch } from "@/lib/automation/queue";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  const body = (await request.json()) as {
    action?: "PAUSE" | "CONTINUE" | "CANCEL" | "RETRY_FAILED";
  };
  if (!body.action) return fail("缺少队列操作");
  try {
    return ok(await controlAutomaticBatch(id, body.action));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "队列操作失败");
  }
}
