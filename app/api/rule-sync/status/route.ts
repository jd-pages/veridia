import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { getRuleSyncStatus } from "@/lib/rules/sync";
import { SYSTEM_ADMIN_ROLES } from "@/lib/permissions";

export const GET = withApiErrorBoundary(async function GET() {
  const user = await requireApiUser(SYSTEM_ADMIN_ROLES);
  if (user instanceof Response) return user;
  return ok(await getRuleSyncStatus());
}, "读取规则同步状态");
