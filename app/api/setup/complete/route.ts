import { ok, requireApiUser } from "@/lib/api";
import { markSetupComplete } from "@/lib/local-runtime";

export async function POST() {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  await markSetupComplete();
  return ok({ completed: true });
}
