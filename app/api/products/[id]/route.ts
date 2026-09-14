import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { normalizeProductAliases } from "@/lib/product-aliases";
import { Prisma } from "@prisma/client";

type ProductUpdateFailure = {
  code:
    | "PRODUCT_NOT_FOUND"
    | "PRODUCT_CODE_DUPLICATE"
    | "PRODUCT_ALIAS_DUPLICATE"
    | "PRODUCT_INVALID_DATA"
    | "PRODUCT_UPDATE_FAILED";
  message: string;
  status: number;
  prismaCode: string | null;
};

function optionalText(value: unknown) {
  return String(value ?? "").trim();
}

function classifyProductUpdateFailure(error: unknown): ProductUpdateFailure {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") {
      return {
        code: "PRODUCT_NOT_FOUND",
        message: "产品不存在",
        status: 404,
        prismaCode: error.code,
      };
    }
    if (error.code === "P2002") {
      const target = JSON.stringify(error.meta?.target || "").toLowerCase();
      if (target.includes("alias") || target.includes("productid")) {
        return {
          code: "PRODUCT_ALIAS_DUPLICATE",
          message: "产品别名重复，请检查后再保存",
          status: 409,
          prismaCode: error.code,
        };
      }
      return {
        code: "PRODUCT_CODE_DUPLICATE",
        message: "产品编码已被其他产品使用",
        status: 409,
        prismaCode: error.code,
      };
    }
    if (["P2000", "P2005", "P2006", "P2007", "P2011", "P2012", "P2013", "P2019", "P2023", "P2033"].includes(error.code)) {
      return {
        code: "PRODUCT_INVALID_DATA",
        message: "产品数据无效，请检查必填项和输入格式",
        status: 400,
        prismaCode: error.code,
      };
    }
  }
  return {
    code: "PRODUCT_UPDATE_FAILED",
    message: "产品更新失败，请稍后重试；如持续失败请联系管理员",
    status: 500,
    prismaCode: null,
  };
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    code?: unknown;
    name?: unknown;
    brandName?: unknown;
    seriesName?: unknown;
    category?: unknown;
    contentDirection?: unknown;
    aliases?: unknown;
    status?: unknown;
  } | null;
  if (
    !body ||
    (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) ||
    (body.brandName !== undefined &&
      (typeof body.brandName !== "string" || !body.brandName.trim())) ||
    (body.aliases !== undefined && !Array.isArray(body.aliases) && typeof body.aliases !== "string")
  ) {
    return fail(
      "产品数据无效，请检查必填项和输入格式",
      400,
      "PRODUCT_INVALID_DATA",
    );
  }
  const aliases = body.aliases === undefined
    ? undefined
    : normalizeProductAliases(body.aliases);
  try {
    const product = await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: {
          ruleSource: "LOCAL_DRAFT",
          ...(body.code !== undefined
            ? { code: optionalText(body.code) || null }
            : {}),
          ...(body.name !== undefined ? { name: optionalText(body.name) } : {}),
          ...(body.brandName !== undefined
            ? { brandName: optionalText(body.brandName) }
            : {}),
          ...(body.seriesName !== undefined
            ? { seriesName: optionalText(body.seriesName) || null }
            : {}),
          ...(body.category !== undefined
            ? { category: optionalText(body.category) || null }
            : {}),
          ...(body.contentDirection !== undefined
            ? { contentDirection: optionalText(body.contentDirection) || null }
            : {}),
          ...(body.status !== undefined ? { status: String(body.status) } : {}),
        },
      });
      if (aliases !== undefined) {
        await tx.productAlias.deleteMany({ where: { productId: id } });
        if (aliases.length) {
          await tx.productAlias.createMany({
            data: aliases.map((alias) => ({ productId: id, alias })),
          });
        }
      }
      const updated = await tx.product.findUniqueOrThrow({
        where: { id },
        include: { aliases: true },
      });
      await tx.operationLog.create({
        data: {
          userId: user.id,
          action: "UPDATE_PRODUCT",
          entityType: "PRODUCT",
          entityId: id,
          summary: `更新产品 ${updated.name}`,
        },
      });
      return updated;
    });
    return ok(product);
  } catch (error) {
    const failure = classifyProductUpdateFailure(error);
    console.error("[VERIDIA API] 产品更新失败", {
      productId: id,
      classification: failure.code,
      prismaCode: failure.prismaCode,
    });
    return fail(failure.message, failure.status, failure.code);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
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
