import { ok } from "@/lib/api";
import {
  getConfiguredAuthMode,
  getEffectiveAuthMode,
} from "@/lib/central/foundation";
import { activatedAccountCount } from "@/lib/accounts/service";
import { accountSigningPublicKeyPath } from "@/lib/accounts/codes";
import { getSession } from "@/lib/auth";
import {
  ensureLocalRuntime,
  isSetupComplete,
} from "@/lib/local-runtime";
import { ensureBuiltinRules, getRuleSyncStatus } from "@/lib/rules/sync";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureLocalRuntime();
  await ensureBuiltinRules();
  const [initialized, configuredAuthMode, rules, accountCount, session] =
    await Promise.all([
      isSetupComplete(),
      getConfiguredAuthMode(),
      getRuleSyncStatus(),
      activatedAccountCount(),
      getSession(),
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
    activatedAccountCount: accountCount,
    canVerifyActivation: Boolean(accountSigningPublicKeyPath()),
    authenticated: Boolean(session),
    user: session,
    aiEnabled: false,
  });
}
