import { fail, ok } from "@/lib/api";
import { ensureLocalRuntime } from "@/lib/local-runtime";
import { ensureBuiltinRules, getRuleSyncStatus } from "@/lib/rules/sync";

export async function POST() {
  try {
    await ensureLocalRuntime();
    await ensureBuiltinRules();
    return ok({ rules: await getRuleSyncStatus() });
  } catch {
    return fail("初始化本地运行环境失败（SETUP_INITIALIZE_FAILED）", 500);
  }
}
