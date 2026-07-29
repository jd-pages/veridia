import { fail, ok, requireApiUser } from "@/lib/api";
import {
  completeXiaohongshuLogin,
  getAutomationSession,
  startXiaohongshuLogin,
} from "@/lib/automation/browser";

export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return ok(await getAutomationSession());
}

export async function POST(request: Request) {
  const user = await requireApiUser(["ADMIN", "OPERATOR"]);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    action?: "START_LOGIN" | "COMPLETE_LOGIN";
  };
  try {
    if (body.action === "START_LOGIN") {
      return ok(await startXiaohongshuLogin());
    }
    if (body.action === "COMPLETE_LOGIN") {
      return ok(await completeXiaohongshuLogin());
    }
    return fail("不支持的登录操作");
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "专用浏览器登录操作失败",
    );
  }
}
