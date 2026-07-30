import { ok } from "@/lib/api";
import { ensureLocalRuntime } from "@/lib/local-runtime";
import { ensureBuiltinRules, getRuleSyncStatus } from "@/lib/rules/sync";

export async function POST() {
  await ensureLocalRuntime();
  await ensureBuiltinRules();
  return ok({ rules: await getRuleSyncStatus() });
}
