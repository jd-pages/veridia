import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { prisma } from "@/lib/db";
import {
  resolveTopicRuleOwnership,
  topicRuleSemanticKey,
} from "@/lib/topic-rule-model";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const requestedChannel = new URL(request.url).searchParams.get("contentChannel");
  const contentChannel = requestedChannel === "DOUYIN"
    ? "DOUYIN"
    : "XIAOHONGSHU";

  const [products, topicRules] = await Promise.all([
    prisma.product.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, brandName: true, status: true },
      orderBy: [{ brandName: "asc" }, { name: "asc" }],
    }),
    prisma.topicRule.findMany({
      where: {
        status: "ACTIVE",
        contentChannel: { in: [contentChannel, "ALL"] },
      },
      include: {
        product: { select: { id: true, brandName: true } },
        campaign: {
          include: {
            product: { select: { id: true, brandName: true } },
            products: {
              select: {
                productId: true,
                product: { select: { id: true, brandName: true } },
              },
            },
          },
        },
      },
    }),
  ]);
  const brandNames = [
    ...new Set(products.map((product) => product.brandName.trim()).filter(Boolean)),
  ];
  const brands = await Promise.all(
    brandNames.map(async (brandName) => {
      const brandProducts = products.filter(
        (product) => product.brandName === brandName,
      );
      const campaigns = await prisma.campaign.findMany({
          where: {
            deletedAt: null,
            contentChannel,
            OR: [
              { product: { is: { brandName } } },
              { products: { some: { product: { brandName } } } },
            ],
          },
          select: { id: true },
        });
      const seen = new Set<string>();
      const classifiedRules = topicRules.flatMap((rule) => {
        if (rule.brandName !== brandName) return [];
        const ownership = resolveTopicRuleOwnership(rule);
        const projected = {
          ...rule,
          scope: ownership.scope,
          productId: ownership.productId,
          campaignId: ownership.campaignId,
        };
        const semanticKey = topicRuleSemanticKey(projected);
        if (seen.has(semanticKey)) return [];
        seen.add(semanticKey);
        return [{ ...projected, bindingStatus: ownership.status }];
      });
      const generalRuleCount = classifiedRules.filter(
        (rule) => rule.scope === "GLOBAL",
      ).length;
      const productRuleCount = classifiedRules.filter(
        (rule) => rule.scope === "PRODUCT",
      ).length;
      const campaignRuleCount = classifiedRules.filter(
        (rule) => rule.scope === "CAMPAIGN",
      ).length;
      return {
        brandName,
        productCount: brandProducts.length,
        campaignCount: campaigns.length,
        ruleCount: generalRuleCount + productRuleCount + campaignRuleCount,
        generalRuleCount,
        productRuleCount,
        campaignRuleCount,
        unresolvedRuleCount: classifiedRules.filter(
          (rule) => rule.bindingStatus !== "VALID",
        ).length,
        productNames: brandProducts.map((product) => product.name),
        status: brandProducts.some((product) => product.status === "ACTIVE")
          ? "ACTIVE"
          : "INACTIVE",
      };
    }),
  );
  return ok(brands);
}, "读取话题规则品牌列表");
