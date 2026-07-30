import { ok } from "@/lib/api";
import { establishLocalSession } from "@/lib/local-runtime";
import { ensureBuiltinRules, getRuleSyncStatus } from "@/lib/rules/sync";

export async function POST() {
  const user = await establishLocalSession();
  await ensureBuiltinRules();
  return ok({
    user: {
      id: user.id,
      displayName: user.displayName,
      role: user.role,
    },
    rules: await getRuleSyncStatus(),
  });
}
