import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { getRuleSyncStatus } from "@/lib/rules/sync";

export const GET = withApiErrorBoundary(async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return ok(await getRuleSyncStatus());
}, "读取规则同步状态");
