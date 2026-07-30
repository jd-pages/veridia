import packageJson from "@/package.json";
import { prisma } from "@/lib/db";
import {
  CENTRAL_FOUNDATION_EFFECTIVE_AUTH_MODE,
  normalizeAuthMode,
  type AuthMode,
} from "./contracts";
import {
  createRandomDeviceId,
  PRIMARY_LOCAL_DEVICE_ID,
} from "./device-id";

function localDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDayBounds(value: Date) {
  const start = new Date(value);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

export async function getOrCreateLocalDevice() {
  return prisma.localDevice.upsert({
    where: { id: PRIMARY_LOCAL_DEVICE_ID },
    update: {},
    create: {
      id: PRIMARY_LOCAL_DEVICE_ID,
      deviceId: createRandomDeviceId(),
    },
  });
}

export async function getConfiguredAuthMode(): Promise<AuthMode> {
  // 中央账号体系已取消；保留兼容枚举，但配置和运行态都固定为 LOCAL。
  return normalizeAuthMode("LOCAL");
}

export function getEffectiveAuthMode(): AuthMode {
  // DUAL/CENTRAL 仅保留数据库兼容字段，不进入实际运行。
  return CENTRAL_FOUNDATION_EFFECTIVE_AUTH_MODE;
}

export async function refreshLocalUsageSummary(
  localUserId: string,
  now = new Date(),
) {
  const device = await getOrCreateLocalDevice();
  const { start, end } = localDayBounds(now);
  const date = localDate(now);
  const taskFilter = {
    createdBy: localUserId,
    createdAt: { gte: start, lt: end },
  };
  const resultFilter = {
    auditedAt: { gte: start, lt: end },
    task: { createdBy: localUserId },
  };
  const [
    taskCount,
    auditCount,
    passedCount,
    failedCount,
    reviewCount,
    nonSensitiveErrorCount,
    resultRuleVersion,
    campaignRuleVersion,
  ] = await prisma.$transaction([
    prisma.auditTask.count({ where: taskFilter }),
    prisma.auditResult.count({ where: resultFilter }),
    prisma.auditResult.count({
      where: { ...resultFilter, autoStatus: "PASSED" },
    }),
    prisma.auditResult.count({
      where: { ...resultFilter, autoStatus: "FAILED" },
    }),
    prisma.auditResult.count({
      where: { ...resultFilter, autoStatus: "NEEDS_REVIEW" },
    }),
    prisma.auditTask.count({
      where: {
        ...taskFilter,
        failureCode: { not: null },
      },
    }),
    prisma.auditResult.aggregate({
      where: resultFilter,
      _max: { ruleVersion: true },
    }),
    prisma.campaign.aggregate({
      where: { status: "ACTIVE", deletedAt: null },
      _max: { ruleVersion: true },
    }),
  ]);
  const ruleVersion = String(
    Math.max(
      resultRuleVersion._max.ruleVersion || 0,
      campaignRuleVersion._max.ruleVersion || 0,
    ),
  );

  return prisma.localUsageSummary.upsert({
    where: {
      date_localUserId_deviceId: {
        date,
        localUserId,
        deviceId: device.deviceId,
      },
    },
    update: {
      softwareVersion: packageJson.version,
      ruleVersion,
      taskCount,
      auditCount,
      passedCount,
      failedCount,
      reviewCount,
      nonSensitiveErrorCount,
    },
    create: {
      date,
      localUserId,
      deviceId: device.deviceId,
      softwareVersion: packageJson.version,
      ruleVersion,
      taskCount,
      auditCount,
      passedCount,
      failedCount,
      reviewCount,
      nonSensitiveErrorCount,
    },
  });
}

export async function refreshUsageWithoutBlocking(localUserId: string) {
  try {
    await refreshLocalUsageSummary(localUserId);
  } catch {
    // 使用汇总是兼容性附加能力，失败不得阻断本地登录或固定规则审核。
  }
}
