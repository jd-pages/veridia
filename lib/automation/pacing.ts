import "server-only";
import { prisma } from "@/lib/db";
import type { AutomationPlatform } from "./platform";

export const XHS_PACING_DEFAULTS = {
  XHS_AUDIT_WAIT_MIN_MS: 4_000,
  XHS_AUDIT_WAIT_MAX_MS: 7_000,
  XHS_NETWORK_MAX_RETRIES: 2,
  XHS_NETWORK_RETRY_FIRST_MS: 5_000,
  XHS_NETWORK_RETRY_SECOND_MS: 15_000,
  XHS_COOLDOWN_TASK_COUNT: 25,
  XHS_COOLDOWN_MS: 45_000,
} as const;

export const DOUYIN_PACING_DEFAULTS = {
  DOUYIN_AUDIT_WAIT_MIN_MS: 7_000,
  DOUYIN_AUDIT_WAIT_MAX_MS: 12_000,
  DOUYIN_NETWORK_MAX_RETRIES: 2,
  DOUYIN_NETWORK_RETRY_FIRST_MS: 8_000,
  DOUYIN_NETWORK_RETRY_SECOND_MS: 20_000,
  DOUYIN_COOLDOWN_TASK_COUNT: 20,
  DOUYIN_COOLDOWN_MS: 60_000,
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

const douyinDescriptions: Record<keyof typeof DOUYIN_PACING_DEFAULTS, string> = {
  DOUYIN_AUDIT_WAIT_MIN_MS: "抖音单篇审核后最短等待时间（毫秒）",
  DOUYIN_AUDIT_WAIT_MAX_MS: "抖音单篇审核后最长等待时间（毫秒）",
  DOUYIN_NETWORK_MAX_RETRIES: "抖音临时网络异常最大自动重试次数（最多 2）",
  DOUYIN_NETWORK_RETRY_FIRST_MS: "抖音第一次网络重试前等待时间（毫秒）",
  DOUYIN_NETWORK_RETRY_SECOND_MS: "抖音第二次网络重试前等待时间（毫秒）",
  DOUYIN_COOLDOWN_TASK_COUNT: "抖音连续审核多少篇后进入访问冷却",
  DOUYIN_COOLDOWN_MS: "抖音连续审核冷却时间（毫秒）",
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

export async function ensureDouyinPacingSettings() {
  await prisma.$transaction(
    Object.entries(DOUYIN_PACING_DEFAULTS).map(([key, value]) =>
      prisma.systemSetting.upsert({
        where: { key },
        create: { key, value: String(value), description: douyinDescriptions[key as keyof typeof DOUYIN_PACING_DEFAULTS] },
        update: {},
      }),
    ),
  );
}

export async function ensureAutomationPacingSettings() {
  await ensureXhsPacingSettings();
  await ensureDouyinPacingSettings();
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

export async function getDouyinPacingSettings() {
  await ensureDouyinPacingSettings();
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: Object.keys(DOUYIN_PACING_DEFAULTS) } },
    select: { key: true, value: true },
  });
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const waitMinMs = numberInRange(values.DOUYIN_AUDIT_WAIT_MIN_MS, 7_000, 5_000, 120_000);
  const waitMaxMs = numberInRange(values.DOUYIN_AUDIT_WAIT_MAX_MS, 12_000, waitMinMs, 120_000);
  return {
    concurrency: 1 as const,
    waitMinMs,
    waitMaxMs,
    maxNetworkRetries: numberInRange(values.DOUYIN_NETWORK_MAX_RETRIES, 2, 0, 2),
    firstRetryMs: numberInRange(values.DOUYIN_NETWORK_RETRY_FIRST_MS, 8_000, 5_000, 120_000),
    secondRetryMs: numberInRange(values.DOUYIN_NETWORK_RETRY_SECOND_MS, 20_000, 15_000, 180_000),
    cooldownTaskCount: numberInRange(values.DOUYIN_COOLDOWN_TASK_COUNT, 20, 10, 50),
    cooldownMs: numberInRange(values.DOUYIN_COOLDOWN_MS, 60_000, 30_000, 180_000),
  };
}

export function getAutomationPacingSettings(platform: AutomationPlatform) {
  return platform === "DOUYIN" ? getDouyinPacingSettings() : getXhsPacingSettings();
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
    DOUYIN_AUDIT_WAIT_MIN_MS: [5_000, 120_000],
    DOUYIN_AUDIT_WAIT_MAX_MS: [5_000, 120_000],
    DOUYIN_NETWORK_MAX_RETRIES: [0, 2],
    DOUYIN_NETWORK_RETRY_FIRST_MS: [5_000, 120_000],
    DOUYIN_NETWORK_RETRY_SECOND_MS: [15_000, 180_000],
    DOUYIN_COOLDOWN_TASK_COUNT: [10, 50],
    DOUYIN_COOLDOWN_MS: [30_000, 180_000],
  };
  const range = ranges[key];
  if (!range) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < range[0] || parsed > range[1]) {
    throw new Error(`${key} 必须在 ${range[0]} 至 ${range[1]} 之间`);
  }
  return String(Math.floor(parsed));
}
