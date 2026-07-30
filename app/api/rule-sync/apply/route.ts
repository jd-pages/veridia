import { fail, ok, requireApiUser } from "@/lib/api";
import { synchronizeLatestRules } from "@/lib/rules/sync";

export async function POST() {
  const user = await requireApiUser(["ADMIN"]);
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
