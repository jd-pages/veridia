import { getSession } from "@/lib/auth";
import { ok, withApiErrorBoundary } from "@/lib/api";

export const GET = withApiErrorBoundary(async function GET() {
  return ok(await getSession());
}, "读取登录状态");
