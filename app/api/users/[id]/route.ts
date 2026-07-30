import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";
import { hashLocalPassword } from "@/lib/accounts/service";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const currentUser = await requireApiUser(["ADMIN"]);
  if (currentUser instanceof Response) return currentUser;
  const { id } = await context.params;
  const target = await prisma.user.findUnique({ where: { id } });
  if (
    !target ||
    !target.accountId ||
    target.authProvider !== "LOCAL_ACTIVATION"
  ) {
    return fail("本地账号不存在", 404);
  }
  if (target.id === currentUser.id || target.role === "ADMIN") {
    return fail("不能通过本机账号管理修改当前管理员或其他管理员", 403);
  }
  const body = (await request.json().catch(() => null)) as {
    action?: "ENABLE" | "DISABLE" | "RESET_PASSWORD";
    newPassword?: string;
  } | null;
  if (!body?.action) return fail("账号管理操作无效");

  if (body.action === "RESET_PASSWORD") {
    if (!body.newPassword) return fail("请输入新初始密码");
    const passwordHash = await hashLocalPassword(body.newPassword);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: target.id },
        data: {
          passwordHash,
          sessionVersion: { increment: 1 },
        },
      }),
      prisma.localAuthSession.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      prisma.operationLog.create({
        data: {
          userId: currentUser.id,
          action: "LOCAL_ACCOUNT_PASSWORD_RESET",
          entityType: "ACCOUNT",
          entityId: target.id,
          summary: `管理员已重置本地账号密码：${target.accountId.slice(0, 8)}…`,
          metadata: JSON.stringify({ success: true }),
        },
      }),
    ]);
    return ok({ reset: true });
  }

  const status = body.action === "DISABLE" ? "DISABLED" : "ACTIVE";
  await prisma.$transaction([
    prisma.user.update({
      where: { id: target.id },
      data: { status, sessionVersion: { increment: 1 } },
    }),
    prisma.localAuthSession.updateMany({
      where: { userId: target.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.operationLog.create({
      data: {
        userId: currentUser.id,
        action:
          body.action === "DISABLE"
            ? "LOCAL_ACCOUNT_DISABLED"
            : "LOCAL_ACCOUNT_ENABLED",
        entityType: "ACCOUNT",
        entityId: target.id,
        summary: `管理员${body.action === "DISABLE" ? "停用" : "恢复"}本地账号：${target.accountId.slice(0, 8)}…`,
        metadata: JSON.stringify({ success: true }),
      },
    }),
  ]);
  return ok({ status });
}
