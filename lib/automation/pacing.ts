import "server-only";
import { prisma } from "@/lib/db";

export const XHS_PACING_DEFAULTS = {
  XHS_AUDIT_WAIT_MIN_MS: 4_000,
  XHS_AUDIT_WAIT_MAX_MS: 7_000,
  XHS_NETWORK_MAX_RETRIES: 2,
  XHS_NETWORK_RETRY_FIRST_MS: 5_000,
  XHS_NETWORK_RETRY_SECOND_MS: 15_000,
  XHS_COOLDOWN_TASK_COUNT: 25,
  XHS_COOLDOWN_MS: 45_000,
} as const;

const descriptions: Record<keyof typeof XHS_PACING_DEFAULTS, string> = {
  XHS_AUDIT_WAIT_MIN_MS: "单篇审核后最短等待时间（毫秒，最低 4000）",
  XHS_AUDIT_WAIT_MAX_MS: "单篇审核后最长等待时间（毫秒，最高不低于最短时间）",
  XHS_NETWORK_MAX_RETRIES: "临时网络异常最大自动重试次数（最多 2）",
  XHS_NETWORK_RETRY_FIRST_MS: "第一次网络重试前等待时间（毫秒）",
  XHS_NETWORK_RETRY_SECOND_MS: "第二次网络重试前等待时间（毫秒）",
  XHS_COOLDOWN_TASK_COUNT: "连续审核多少篇后进入访问冷却（20 至 30）",
  XHS_COOLDOWN_MS: "连续审核冷却时间（毫秒，30000 至 60000）",
};

export async function ensureXhsPacingSettings() {
  await prisma.$transaction(
    Object.entries(XHS_PACING_DEFAULTS).map(([key, value]) =>
      prisma.systemSetting.upsert({
        where: { key },
        create: {
          key,
          value: String(value),
          description: descriptions[key as keyof typeof XHS_PACING_DEFAULTS],
        },
        update: {},
      }),
    ),
  );
}

function numberInRange(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.floor(parsed)))
    : fallback;
}

export async function getXhsPacingSettings() {
  await ensureXhsPacingSettings();
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: Object.keys(XHS_PACING_DEFAULTS) } },
    select: { key: true, value: true },
  });
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const waitMinMs = numberInRange(values.XHS_AUDIT_WAIT_MIN_MS, 4_000, 4_000, 60_000);
  const waitMaxMs = numberInRange(values.XHS_AUDIT_WAIT_MAX_MS, 7_000, waitMinMs, 60_000);
  return {
    concurrency: 1 as const,
    waitMinMs,
    waitMaxMs,
    maxNetworkRetries: numberInRange(values.XHS_NETWORK_MAX_RETRIES, 2, 0, 2),
    firstRetryMs: numberInRange(values.XHS_NETWORK_RETRY_FIRST_MS, 5_000, 5_000, 60_000),
    secondRetryMs: numberInRange(values.XHS_NETWORK_RETRY_SECOND_MS, 15_000, 15_000, 120_000),
    cooldownTaskCount: numberInRange(values.XHS_COOLDOWN_TASK_COUNT, 25, 20, 30),
    cooldownMs: numberInRange(values.XHS_COOLDOWN_MS, 45_000, 30_000, 60_000),
  };
}

export function jitteredDelay(minimum: number, maximum = minimum) {
  const min = Math.max(0, Math.min(minimum, maximum));
  const max = Math.max(min, maximum);
  return Math.round(min + Math.random() * (max - min));
}

export function normalizeXhsPacingSetting(key: string, value: string) {
  const ranges: Record<string, [number, number]> = {
    XHS_AUDIT_WAIT_MIN_MS: [4_000, 60_000],
    XHS_AUDIT_WAIT_MAX_MS: [4_000, 60_000],
    XHS_NETWORK_MAX_RETRIES: [0, 2],
    XHS_NETWORK_RETRY_FIRST_MS: [5_000, 60_000],
    XHS_NETWORK_RETRY_SECOND_MS: [15_000, 120_000],
    XHS_COOLDOWN_TASK_COUNT: [20, 30],
    XHS_COOLDOWN_MS: [30_000, 60_000],
  };
  const range = ranges[key];
  if (!range) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < range[0] || parsed > range[1]) {
    throw new Error(`${key} 必须在 ${range[0]} 至 ${range[1]} 之间`);
  }
  return String(Math.floor(parsed));
}
