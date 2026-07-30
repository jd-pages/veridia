import { ok } from "@/lib/api";
import {
  getConfiguredAuthMode,
  getEffectiveAuthMode,
  getOrCreateLocalDevice,
} from "@/lib/central/foundation";
import {
  establishLocalSession,
  isSetupComplete,
} from "@/lib/local-runtime";
import { ensureBuiltinRules, getRuleSyncStatus } from "@/lib/rules/sync";

export const dynamic = "force-dynamic";

export async function GET() {
  await establishLocalSession();
  await ensureBuiltinRules();
  const [initialized, configuredAuthMode, , rules] = await Promise.all([
    isSetupComplete(),
    getConfiguredAuthMode(),
    getOrCreateLocalDevice(),
    getRuleSyncStatus(),
  ]);
  return ok({
    initialized,
    dataDirectory: process.env.VERIDIA_DATA_DIR || "本地数据目录",
    desktop: process.env.VERIDIA_DESKTOP === "true",
    dataLocationConfirmed:
      process.env.VERIDIA_DATA_LOCATION_CONFIRMED === "true",
    configuredAuthMode,
    effectiveAuthMode: getEffectiveAuthMode(),
    rules,
    aiEnabled: false,
  });
}
