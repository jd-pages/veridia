import type { Prisma } from "@prisma/client";
import { campaignContainsProduct } from "@/lib/topic-rule-model";

export class CampaignProductMembershipError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "CampaignProductMembershipError";
  }
}

// The caller owns the transaction so membership and its associated business
// change either commit together or roll back together.
export async function ensureCampaignProductMembership(
  tx: Prisma.TransactionClient,
  input: {
    campaignId: string;
    productId: string;
    brandName: string;
    selectedMonth: string;
    contentChannel: string;
  },
) {
  const [product, campaign] = await Promise.all([
    tx.product.findFirst({
      where: { id: input.productId, deletedAt: null },
      select: { id: true, brandName: true },
    }),
    tx.campaign.findFirst({
      where: { id: input.campaignId, deletedAt: null },
      include: {
        product: { select: { id: true, brandName: true } },
        products: {
          select: {
            id: true,
            productId: true,
            sortOrder: true,
            product: { select: { id: true, brandName: true } },
          },
        },
      },
    }),
  ]);
  if (!product || product.brandName !== input.brandName) {
    throw new CampaignProductMembershipError("所选产品不属于当前品牌");
  }
  if (!campaign) {
    throw new CampaignProductMembershipError("所选活动不存在或已删除");
  }
  const campaignBrands = new Set([
    campaign.product?.brandName,
    ...campaign.products.map(({ product: item }) => item.brandName),
  ].filter((brand): brand is string => Boolean(brand)));
  if (campaignBrands.size !== 1 || !campaignBrands.has(product.brandName)) {
    throw new CampaignProductMembershipError("所选产品与活动品牌不一致");
  }
  if (!input.selectedMonth || campaign.month !== input.selectedMonth) {
    throw new CampaignProductMembershipError("所属活动与当前规则月份不一致");
  }
  if (campaign.contentChannel !== input.contentChannel) {
    throw new CampaignProductMembershipError("规则内容平台与所属活动不一致");
  }

  const existing = campaign.products.find(({ productId }) => productId === product.id);
  if (campaignContainsProduct(campaign, product.id)) return existing || null;

  const sortOrder = Math.max(-1, ...campaign.products.map((link) => link.sortOrder)) + 1;
  return tx.campaignProduct.upsert({
    where: {
      campaignId_productId: { campaignId: campaign.id, productId: product.id },
    },
    update: {},
    create: { campaignId: campaign.id, productId: product.id, sortOrder },
  });
}
