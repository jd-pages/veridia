import { fail, ok, requireApiUser } from "@/lib/api";
import { synchronizeLatestRules } from "@/lib/rules/sync";
import { SYSTEM_ADMIN_ROLES } from "@/lib/permissions";

export async function POST() {
  const user = await requireApiUser(SYSTEM_ADMIN_ROLES);
  if (user instanceof Response) return user;
  try {
    return ok(await synchronizeLatestRules());
  } catch (error) {
    return fail(
      error instanceof Error
        ? error.message
        : "暂时无法获取最新规则，已继续使用本地规则。",
      503,
    );
  }
}
