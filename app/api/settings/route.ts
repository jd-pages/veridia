import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";

export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  if (user.role !== "ADMIN") return ok([]);
  const settings = await prisma.systemSetting.findMany({
    where: {
      key: {
        notIn: ["AI_ENABLED", "OPENAI_API_KEY", "OPENAI_MODEL", "AUTH_MODE"],
      },
    },
    orderBy: { key: "asc" },
  });
  return ok(
    settings.map((setting) => ({
      ...setting,
      value: setting.isSecret ? "••••••••" : setting.value,
    })),
  );
}

export async function PUT(request: Request) {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  const body = (await request.json()) as { key?: string; value?: string };
  if (!body.key || body.value === undefined) return fail("设置项无效");
  if (body.key === "AI_ENABLED" || body.key.startsWith("OPENAI_")) {
    return fail("桌面版不提供 AI 配置");
  }
  if (body.key === "AUTH_MODE") {
    return fail("当前桌面版认证模式固定为 LOCAL");
  }
  const setting = await prisma.systemSetting.findUnique({ where: { key: body.key } });
  if (!setting) return fail("设置项不存在", 404);
  if (setting.isSecret) return fail("敏感设置不允许在页面中覆盖");
  return ok(
    await prisma.systemSetting.update({
      where: { key: body.key },
      data: { value: body.value },
    }),
  );
}
