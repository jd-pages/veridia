import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { prisma } from "@/lib/db";

export const GET = withApiErrorBoundary(async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;

  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, brandName: true, status: true },
    orderBy: [{ brandName: "asc" }, { name: "asc" }],
  });
  const brandNames = [
    ...new Set(products.map((product) => product.brandName.trim()).filter(Boolean)),
  ];
  const brands = await Promise.all(
    brandNames.map(async (brandName) => {
      const brandProducts = products.filter(
        (product) => product.brandName === brandName,
      );
      const [campaigns, ruleCount] = await Promise.all([
        prisma.campaign.findMany({
          where: {
            deletedAt: null,
            OR: [
              { product: { is: { brandName } } },
              { products: { some: { product: { brandName } } } },
            ],
          },
          select: { id: true },
        }),
        prisma.topicRule.count({ where: { brandName } }),
      ]);
      return {
        brandName,
        productCount: brandProducts.length,
        campaignCount: campaigns.length,
        ruleCount,
        productNames: brandProducts.map((product) => product.name),
        status: brandProducts.some((product) => product.status === "ACTIVE")
          ? "ACTIVE"
          : "INACTIVE",
      };
    }),
  );
  return ok(brands);
}, "读取话题规则品牌列表");
