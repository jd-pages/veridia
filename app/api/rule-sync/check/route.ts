import { ok, requireApiUser } from "@/lib/api";
import { checkLatestRules } from "@/lib/rules/sync";
import { SYSTEM_ADMIN_ROLES } from "@/lib/permissions";

export async function POST(request: Request) {
  const user = await requireApiUser(SYSTEM_ADMIN_ROLES);
  if (user instanceof Response) return user;
  const force = new URL(request.url).searchParams.get("force") === "true";
  return ok(await checkLatestRules(force));
}
