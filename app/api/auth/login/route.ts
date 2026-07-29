import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { fail, ok } from "@/lib/api";

export async function POST(request: Request) {
  const body = (await request.json()) as { username?: string; password?: string };
  if (!body.username || !body.password) return fail("请输入用户名和密码");
  const user = await prisma.user.findUnique({ where: { username: body.username } });
  if (
    !user ||
    user.status !== "ACTIVE" ||
    !(await bcrypt.compare(body.password, user.passwordHash))
  ) {
    return fail("用户名或密码错误", 401);
  }
  await createSession({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role as "ADMIN" | "OPERATOR" | "VIEWER",
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });
  return ok({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  });
}
