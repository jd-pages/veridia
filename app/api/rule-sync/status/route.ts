import { ok, requireApiUser } from "@/lib/api";
import { getRuleSyncStatus } from "@/lib/rules/sync";

export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return ok(await getRuleSyncStatus());
}
