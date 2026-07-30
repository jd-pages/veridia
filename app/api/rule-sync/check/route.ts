import { ok, requireApiUser } from "@/lib/api";
import { checkLatestRules } from "@/lib/rules/sync";

export async function POST(request: Request) {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  const force = new URL(request.url).searchParams.get("force") === "true";
  return ok(await checkLatestRules(force));
}
