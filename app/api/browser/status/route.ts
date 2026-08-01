import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { getAutomationSession } from "@/lib/automation/browser";

export const GET = withApiErrorBoundary(async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return ok(await getAutomationSession());
}, "读取小红书浏览器状态");
