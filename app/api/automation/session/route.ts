import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  completeXiaohongshuLogin,
  getAutomationSession,
  startXiaohongshuLogin,
} from "@/lib/automation/browser";

export const GET = withApiErrorBoundary(async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return ok(await getAutomationSession());
}, "读取小红书浏览器状态");

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
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
    console.error("[VERIDIA API] 小红书专用浏览器操作失败", error);
    return fail(
      "小红书专用浏览器操作失败，请完全退出并重启 VERIDIA 后再试。",
      500,
      "BROWSER_OPERATION_FAILED",
    );
  }
}, "操作小红书专用浏览器");
