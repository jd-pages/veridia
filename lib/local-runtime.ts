import { prisma } from "@/lib/db";
import {
  isIsolatedLocalPreview,
  isLocalPreviewMode,
  LOCAL_PREVIEW_DISPLAY_NAME,
  LOCAL_PREVIEW_USER_ID,
  LOCAL_PREVIEW_USERNAME,
} from "@/lib/local-preview-mode";
import type { SessionUser } from "@/lib/auth";

export const LOCAL_SYSTEM_USER_ID = "veridia-local-system-user";
export const LOCAL_SYSTEM_USERNAME = "__veridia_local_system__";

const LOCAL_SYSTEM_USER = {
  id: LOCAL_SYSTEM_USER_ID,
  username: LOCAL_SYSTEM_USERNAME,
  displayName: "本地工作台",
  role: "ADMIN",
};

export async function ensureLocalRuntime() {
  const existingUser = await prisma.user.findUnique({
    where: { id: LOCAL_SYSTEM_USER_ID },
  });
  const user =
    existingUser?.authProvider === "LOCAL_ACTIVATION" &&
    existingUser.accountId
      ? existingUser
      : await prisma.user.upsert({
          where: { id: LOCAL_SYSTEM_USER_ID },
          create: {
            ...LOCAL_SYSTEM_USER,
            passwordHash: "!LOCAL_SYSTEM_USER_HAS_NO_PASSWORD!",
            status: "ACTIVE",
            authProvider: "LOCAL_SYSTEM",
          },
          update: {
            displayName: LOCAL_SYSTEM_USER.displayName,
            role: "ADMIN",
            status: "ACTIVE",
            authProvider: "LOCAL_SYSTEM",
          },
        });

  await prisma.$transaction([
    prisma.systemSetting.upsert({
      where: { key: "AUTH_MODE" },
      create: {
        key: "AUTH_MODE",
        value: "LOCAL",
        description: "纯本地桌面认证模式，运行时固定为 LOCAL",
      },
      update: {
        value: "LOCAL",
        description: "纯本地桌面认证模式，运行时固定为 LOCAL",
      },
    }),
    prisma.systemSetting.upsert({
      where: { key: "DEFAULT_MIN_IMAGES" },
      create: {
        key: "DEFAULT_MIN_IMAGES",
        value: "2",
        description: "默认最低图片数量",
      },
      update: {},
    }),
    prisma.automationSession.upsert({
      where: { id: "xiaohongshu" },
      create: {
        id: "xiaohongshu",
        platform: "XIAOHONGSHU",
        status: "UNKNOWN",
        profilePath:
          process.env.XHS_PROFILE_PATH || ".playwright/xhs-profile",
      },
      update: {},
    }),
  ]);

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: "ADMIN" as const,
  };
}

export async function ensureLocalPreviewRuntime(): Promise<SessionUser | null> {
  if (!isLocalPreviewMode()) return null;

  const systemUser = await ensureLocalRuntime();
  if (!isIsolatedLocalPreview()) {
    return {
      ...systemUser,
      accountId: "local-preview",
      username: LOCAL_PREVIEW_USERNAME,
      displayName: LOCAL_PREVIEW_DISPLAY_NAME,
      expiresAt: null,
    };
  }

  const user = await prisma.user.upsert({
    where: { id: LOCAL_PREVIEW_USER_ID },
    create: {
      id: LOCAL_PREVIEW_USER_ID,
      username: LOCAL_PREVIEW_USERNAME,
      normalizedUsername: LOCAL_PREVIEW_USERNAME,
      accountId: "local-preview-isolated",
      displayName: LOCAL_PREVIEW_DISPLAY_NAME,
      passwordHash: "!LOCAL_PREVIEW_USER_HAS_NO_PASSWORD!",
      role: "ADMIN",
      status: "ACTIVE",
      authProvider: "LOCAL_PREVIEW",
      issuedAt: new Date(),
      activatedAt: new Date(),
    },
    update: {
      username: LOCAL_PREVIEW_USERNAME,
      normalizedUsername: LOCAL_PREVIEW_USERNAME,
      displayName: LOCAL_PREVIEW_DISPLAY_NAME,
      role: "ADMIN",
      status: "ACTIVE",
      authProvider: "LOCAL_PREVIEW",
    },
  });

  await prisma.systemSetting.upsert({
    where: { key: "SETUP_COMPLETED" },
    create: {
      key: "SETUP_COMPLETED",
      value: "true",
      description: "本地预览数据目录已初始化",
    },
    update: { value: "true" },
  });

  return {
    id: user.id,
    accountId: user.accountId || "local-preview-isolated",
    username: user.username,
    displayName: user.displayName,
    role: "ADMIN",
    expiresAt: null,
  };
}

export async function isSetupComplete() {
  if (isLocalPreviewMode()) return true;
  const explicit = await prisma.systemSetting.findUnique({
    where: { key: "SETUP_COMPLETED" },
    select: { value: true },
  });
  if (explicit?.value !== "true") return false;
  return (
    (await prisma.user.count({
      where: {
        accountId: { not: null },
        authProvider: "LOCAL_ACTIVATION",
      },
    })) > 0
  );
}

export async function markSetupComplete() {
  await prisma.systemSetting.upsert({
    where: { key: "SETUP_COMPLETED" },
    create: {
      key: "SETUP_COMPLETED",
      value: "true",
      description: "首次启动向导已完成",
    },
    update: { value: "true" },
  });
}
