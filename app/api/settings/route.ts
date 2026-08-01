import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";

export const GET = withApiErrorBoundary(async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const settings = await prisma.systemSetting.findMany({
    where: {
      isSecret: false,
      key: {
        notIn: [
          "AI_ENABLED",
          "OPENAI_API_KEY",
          "OPENAI_MODEL",
          "AUTH_MODE",
          "DEFAULT_MIN_IMAGES",
          "SETUP_COMPLETED",
        ],
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
}, "读取系统基础设置");

export const PUT = withApiErrorBoundary(async function PUT(request: Request) {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  const body = (await request.json()) as { key?: string; value?: string };
  if (!body.key || body.value === undefined) return fail("设置项无效");
  if (
    [
      "AI_ENABLED",
      "AUTH_MODE",
      "DEFAULT_MIN_IMAGES",
      "SETUP_COMPLETED",
    ].includes(body.key) ||
    body.key.startsWith("OPENAI_")
  ) {
    return fail("该内部设置不允许在正式版界面修改");
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
}, "修改系统设置");
