import { ok } from "@/lib/api";
import {
  getConfiguredAuthMode,
  getEffectiveAuthMode,
  getOrCreateLocalDevice,
} from "@/lib/central/foundation";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const [userCount, configuredAuthMode] = await Promise.all([
    prisma.user.count(),
    getConfiguredAuthMode(),
    getOrCreateLocalDevice(),
  ]);
  return ok({
    initialized: userCount > 0,
    dataDirectory: process.env.VERIDIA_DATA_DIR || "本地数据目录",
    desktop: process.env.VERIDIA_DESKTOP === "true",
    dataLocationConfirmed:
      process.env.VERIDIA_DATA_LOCATION_CONFIRMED === "true",
    configuredAuthMode,
    effectiveAuthMode: getEffectiveAuthMode(),
    aiEnabled: false,
  });
}
