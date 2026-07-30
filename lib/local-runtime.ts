import { createSession, type SessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const LOCAL_SYSTEM_USER_ID = "veridia-local-system-user";
export const LOCAL_SYSTEM_USERNAME = "__veridia_local_system__";

const LOCAL_SYSTEM_USER: SessionUser = {
  id: LOCAL_SYSTEM_USER_ID,
  username: LOCAL_SYSTEM_USERNAME,
  displayName: "本地工作台",
  role: "ADMIN",
};

export async function ensureLocalRuntime() {
  const user = await prisma.user.upsert({
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

export async function establishLocalSession() {
  const user = await ensureLocalRuntime();
  await createSession(user);
  return user;
}

export async function isSetupComplete() {
  const explicit = await prisma.systemSetting.findUnique({
    where: { key: "SETUP_COMPLETED" },
    select: { value: true },
  });
  if (explicit?.value === "true") return true;

  // 旧版本已有人工创建账号时视为已完成初始化，升级后不重复展示向导。
  return (
    (await prisma.user.count({
      where: { id: { not: LOCAL_SYSTEM_USER_ID } },
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
