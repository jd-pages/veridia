import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const keyword = searchParams.get("keyword")?.trim();
  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
      ...(keyword
        ? {
            OR: [
              { code: { contains: keyword } },
              { name: { contains: keyword } },
              { brandName: { contains: keyword } },
              { aliases: { some: { alias: { contains: keyword } } } },
            ],
          }
        : {}),
    },
    include: { aliases: true, _count: { select: { campaigns: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return ok(products);
}, "读取产品列表");

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    code?: string;
    name?: string;
    brandName?: string;
    seriesName?: string;
    category?: string;
    contentDirection?: string;
    aliases?: string[];
  };
  if (!body.name?.trim() || !body.brandName?.trim()) {
    return fail("产品名称和品牌为必填项，正式产品编码可以留空");
  }
  try {
    const product = await prisma.product.create({
      data: {
        ruleSource: "LOCAL_DRAFT",
        code: body.code?.trim() || null,
        name: body.name.trim(),
        brandName: body.brandName.trim(),
        seriesName: body.seriesName?.trim() || body.name.trim(),
        category: body.category?.trim() || null,
        contentDirection: body.contentDirection?.trim() || null,
        aliases: {
          create: [...new Set(body.aliases?.map((item) => item.trim()).filter(Boolean))]
            .map((alias) => ({ alias })),
        },
      },
      include: { aliases: true },
    });
    await prisma.operationLog.create({
      data: {
        userId: user.id,
        action: "CREATE_PRODUCT",
        entityType: "PRODUCT",
        entityId: product.id,
        summary: `新增产品 ${product.name}`,
      },
    });
    return ok(product, { status: 201 });
  } catch {
    return fail("产品编码已存在或数据无效");
  }
}, "新增产品");
