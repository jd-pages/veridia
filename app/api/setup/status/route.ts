import { fail, ok } from "@/lib/api";
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
import { ensureLocalPreviewRuntime } from "@/lib/local-runtime";
import { isLocalPreviewMode } from "@/lib/local-preview-mode";
import { isDatabaseSchemaMismatch } from "@/lib/database-errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureLocalRuntime();
    await ensureLocalPreviewRuntime();
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
      localPreview: isLocalPreviewMode(),
    });
  } catch (error) {
    if (isDatabaseSchemaMismatch(error)) {
      return fail(
        "本地数据库结构与当前代码不匹配，请完全退出并重新启动 VERIDIA。",
        503,
        "SETUP_SCHEMA_MISMATCH",
      );
    }
    return fail(
      "首次启动状态读取失败，请完全退出并重新启动 VERIDIA。",
      500,
      "SETUP_STATUS_FAILED",
    );
  }
}
