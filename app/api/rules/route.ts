import { prisma } from "@/lib/db";
import { normalizeTopic } from "@/lib/topic";
import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { topicRuleListWhere } from "@/lib/topic-rule-management";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const campaignId = searchParams.get("campaignId") || undefined;
  const productId = searchParams.get("productId") || undefined;
  const brandName = searchParams.get("brandName")?.trim() || undefined;
  const month = searchParams.get("month")?.trim() || undefined;
  const contentChannel = searchParams.get("contentChannel")?.trim() || undefined;
  const rules = await prisma.topicRule.findMany({
    where: topicRuleListWhere({
      campaignId,
      productId,
      brandName,
      month,
      contentChannel,
    }),
    include: {
      campaign: {
        include: {
          product: true,
          products: { include: { product: true } },
        },
      },
      product: true,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return ok(rules);
}, "读取话题规则");

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    campaignId?: string;
    productId?: string;
    brandName?: string;
    scope?: string;
    ruleType?: string;
    topicCategory?: string;
    applicableStage?: string;
    milkType?: string;
    topic?: string;
    exactMatch?: boolean;
    clickableRequired?: boolean;
    caseSensitive?: boolean;
    minCount?: number;
    sortOrder?: number;
    notes?: string;
    contentChannel?: "XIAOHONGSHU" | "DOUYIN" | "ALL";
  };
  const topic = normalizeTopic(body.topic || "");
  if (!body.ruleType || !topic) return fail("规则类型和标准话题为必填项");
  const brandName = body.brandName?.trim();
  if (!brandName) return fail("规则必须归属品牌");
  const scope = body.scope ?? "CAMPAIGN";
  if (!["GLOBAL", "PRODUCT", "CAMPAIGN"].includes(scope)) {
    return fail("规则层级无效");
  }
  const ruleType = body.ruleType;
  let resolvedContentChannel = body.contentChannel || "XIAOHONGSHU";
  if (scope === "CAMPAIGN" && !body.campaignId) {
    return fail("活动规则必须选择所属活动");
  }
  if (scope === "PRODUCT" && !body.productId) {
    return fail("产品规则必须选择所属产品");
  }
  if (scope === "GLOBAL" && (body.campaignId || body.productId)) {
    return fail("通用规则不能绑定活动或产品");
  }
  if (scope === "PRODUCT" && body.campaignId) {
    return fail("产品规则不能绑定活动");
  }
  if (body.productId) {
    const product = await prisma.product.findFirst({
      where: { id: body.productId, deletedAt: null },
      select: { brandName: true },
    });
    if (!product || product.brandName !== brandName) {
      return fail("所选产品不属于当前品牌");
    }
  }
  if (body.campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: body.campaignId },
      include: {
        product: { select: { brandName: true } },
        products: { include: { product: { select: { brandName: true } } } },
      },
    });
    const campaignBrands = [
      campaign?.product?.brandName,
      ...(campaign?.products || []).map(({ product }) => product.brandName),
    ];
    if (!campaign || !campaignBrands.includes(brandName)) {
      return fail("所选活动不属于当前品牌");
    }
    const campaignProductIds = [
      campaign.productId,
      ...campaign.products.map(({ productId }) => productId),
    ];
    if (body.productId && !campaignProductIds.includes(body.productId)) {
      return fail("所选产品不属于当前活动");
    }
    resolvedContentChannel =
      body.contentChannel ||
      (["XIAOHONGSHU", "DOUYIN", "ALL"].includes(campaign.contentChannel)
        ? (campaign.contentChannel as "XIAOHONGSHU" | "DOUYIN" | "ALL")
        : "XIAOHONGSHU");
    if (body.contentChannel && ![campaign.contentChannel, "ALL"].includes(body.contentChannel)) {
      return fail("规则内容平台与所属活动不一致");
    }
  }
  try {
    const rule = await prisma.$transaction(async (tx) => {
      let version = 1;
      if (body.campaignId) {
        const campaign = await tx.campaign.update({
          where: { id: body.campaignId },
          data: { ruleVersion: { increment: 1 } },
        });
        version = campaign.ruleVersion;
      }
      return tx.topicRule.create({
        data: {
          ruleSource: "LOCAL_DRAFT",
          brandName,
          contentChannel: resolvedContentChannel,
          campaignId: body.campaignId || null,
          productId: body.productId || null,
          scope,
          ruleType,
          topicCategory: body.topicCategory || "GENERAL",
          applicableStage: body.applicableStage?.trim() || null,
          milkType: body.milkType?.trim() || null,
          topic,
          exactMatch: body.exactMatch ?? true,
          clickableRequired: body.clickableRequired ?? false,
          caseSensitive: body.caseSensitive ?? false,
          minCount: body.minCount ?? 1,
          sortOrder: body.sortOrder ?? 0,
          version,
          notes: body.notes?.trim() || null,
        },
        include: { campaign: true, product: true },
      });
    });
    await prisma.operationLog.create({
      data: {
        userId: user.id,
        action: "CREATE_RULE",
        entityType: "TOPIC_RULE",
        entityId: rule.id,
        summary: `新增规则 ${rule.topic}`,
      },
    });
    return ok(rule, { status: 201 });
  } catch {
    return fail("规则数据无效或所属活动不存在");
  }
}, "新增话题规则");
