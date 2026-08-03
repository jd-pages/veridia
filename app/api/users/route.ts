import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";
import { effectiveAccountStatus } from "@/lib/accounts/validation";
import { SYSTEM_ADMIN_ROLES } from "@/lib/permissions";

export async function GET() {
  const currentUser = await requireApiUser(SYSTEM_ADMIN_ROLES);
  if (currentUser instanceof Response) return currentUser;
  const users = await prisma.user.findMany({
    where: {
      accountId: { not: null },
      authProvider: "LOCAL_ACTIVATION",
    },
    select: {
      id: true,
      accountId: true,
      username: true,
      displayName: true,
      role: true,
      status: true,
      issuedAt: true,
      expiresAt: true,
      activatedAt: true,
      lastLocalLoginAt: true,
    },
    orderBy: [{ role: "asc" }, { activatedAt: "asc" }],
  });
  return ok(
    users.map((user) => ({
      ...user,
      status: effectiveAccountStatus(user),
    })),
  );
}

export async function POST() {
  const currentUser = await requireApiUser(SYSTEM_ADMIN_ROLES);
  if (currentUser instanceof Response) return currentUser;
  return fail(
    "客户端不允许直接创建账号，请使用账号管理员提供的激活码。",
    403,
  );
}
