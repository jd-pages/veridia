import { fail, ok, requireApiUser } from "@/lib/api";
import { restorePreviousRules } from "@/lib/rules/sync";

export async function POST() {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  try {
    return ok(await restorePreviousRules());
  } catch (error) {
    return fail(error instanceof Error ? error.message : "恢复上一版规则失败");
  }
}
