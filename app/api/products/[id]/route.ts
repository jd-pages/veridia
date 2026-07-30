import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  const { id } = await params;
  const body = (await request.json()) as {
    code?: string;
    name?: string;
    brandName?: string;
    seriesName?: string;
    category?: string;
    contentDirection?: string;
    aliases?: string[];
    status?: string;
  };
  try {
    const product = await prisma.$transaction(async (tx) => {
      await tx.productAlias.deleteMany({ where: { productId: id } });
      return tx.product.update({
        where: { id },
        data: {
          ruleSource: "LOCAL_DRAFT",
          ...(body.code !== undefined
            ? { code: body.code.trim() || null }
            : {}),
          ...(body.name ? { name: body.name.trim() } : {}),
          ...(body.brandName ? { brandName: body.brandName.trim() } : {}),
          ...(body.seriesName !== undefined
            ? { seriesName: body.seriesName.trim() || null }
            : {}),
          ...(body.category !== undefined
            ? { category: body.category.trim() || null }
            : {}),
          ...(body.contentDirection !== undefined
            ? { contentDirection: body.contentDirection.trim() || null }
            : {}),
          ...(body.status ? { status: body.status } : {}),
          ...(body.aliases
            ? {
                aliases: {
                  create: [...new Set(body.aliases.map((item) => item.trim()).filter(Boolean))]
                    .map((alias) => ({ alias })),
                },
              }
            : {}),
        },
        include: { aliases: true },
      });
    });
    await prisma.operationLog.create({
      data: {
        userId: user.id,
        action: "UPDATE_PRODUCT",
        entityType: "PRODUCT",
        entityId: id,
        summary: `更新产品 ${product.name}`,
      },
    });
    return ok(product);
  } catch {
    return fail("产品不存在、编码重复或数据无效");
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const product = await prisma.product.update({
      where: { id },
      data: { status: "INACTIVE", ruleSource: "LOCAL_DRAFT" },
    });
    await prisma.operationLog.create({
      data: {
        userId: user.id,
        action: "DISABLE_PRODUCT",
        entityType: "PRODUCT",
        entityId: id,
        summary: `停用产品 ${product.name}`,
      },
    });
    return ok(product);
  } catch {
    return fail("产品不存在", 404);
  }
}
