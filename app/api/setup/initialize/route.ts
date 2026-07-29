import bcrypt from "bcryptjs";
import { createSession } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { refreshUsageWithoutBlocking } from "@/lib/central/foundation";
import { prisma } from "@/lib/db";

export async function POST(request: Request) {
  if ((await prisma.user.count()) > 0) {
    return fail("系统已经完成初始化", 409);
  }

  const body = (await request.json()) as {
    username?: string;
    displayName?: string;
    password?: string;
  };
  const username = body.username?.trim();
  const displayName = body.displayName?.trim();
  const password = body.password || "";
  if (!username || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return fail("管理员用户名需为 3 至 32 位字母、数字、点、下划线或短横线");
  }
  if (!displayName || displayName.length > 40) {
    return fail("请输入不超过 40 个字符的管理员姓名");
  }
  if (password.length < 8) {
    return fail("管理员密码至少需要 8 位");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const extensionToken = process.env.EXTENSION_TOKEN?.trim();
  const admin = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        username,
        displayName,
        passwordHash,
        role: "ADMIN",
        status: "ACTIVE",
      },
    });
    await tx.systemSetting.createMany({
      data: [
        {
          key: "DEFAULT_MIN_IMAGES",
          value: "2",
          description: "默认最低图片数量",
        },
        ...(extensionToken
          ? [
              {
                key: "EXTENSION_TOKEN",
                value: extensionToken,
                description: "本机浏览器插件提交令牌",
                isSecret: true,
              },
            ]
          : []),
      ],
    });
    await tx.automationSession.create({
      data: {
        id: "xiaohongshu",
        platform: "XIAOHONGSHU",
        status: "UNKNOWN",
        profilePath:
          process.env.XHS_PROFILE_PATH || ".playwright/xhs-profile",
      },
    });
    await tx.operationLog.create({
      data: {
        userId: created.id,
        action: "INITIALIZE_DESKTOP",
        entityType: "SYSTEM",
        summary: "完成 VERIDIA 本地桌面版初始化",
        metadata: JSON.stringify({ aiEnabled: false }),
      },
    });
    return created;
  });

  await createSession({
    id: admin.id,
    username: admin.username,
    displayName: admin.displayName,
    role: "ADMIN",
  });
  await refreshUsageWithoutBlocking(admin.id);
  return ok({
    id: admin.id,
    username: admin.username,
    displayName: admin.displayName,
    role: admin.role,
  });
}
