import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";

export async function GET() {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  return ok(
    await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        status: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  );
}

export async function POST(request: Request) {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    username?: string;
    displayName?: string;
    password?: string;
    role?: string;
  };
  if (!body.username || !body.displayName || !body.password || !body.role) {
    return fail("账号、姓名、密码和角色为必填项");
  }
  try {
    const created = await prisma.user.create({
      data: {
        username: body.username.trim(),
        displayName: body.displayName.trim(),
        passwordHash: await bcrypt.hash(body.password, 10),
        role: body.role,
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        status: true,
      },
    });
    return ok(created, { status: 201 });
  } catch {
    return fail("用户名已存在或数据无效");
  }
}
