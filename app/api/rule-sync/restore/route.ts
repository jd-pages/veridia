import { fail, ok, requireApiUser } from "@/lib/api";
import { restorePreviousRules } from "@/lib/rules/sync";
import { SYSTEM_ADMIN_ROLES } from "@/lib/permissions";

export async function POST() {
  const user = await requireApiUser(SYSTEM_ADMIN_ROLES);
  if (user instanceof Response) return user;
  try {
    return ok(await restorePreviousRules());
  } catch (error) {
    return fail(error instanceof Error ? error.message : "恢复上一版规则失败");
  }
}
