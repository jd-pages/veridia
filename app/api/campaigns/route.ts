import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { MIN_BODY_LENGTH } from "@/lib/audit-constants";
import { campaignRequiresProductStage } from "@/lib/campaign-stage-requirement";
import { legacyBasicRewardRequired, resolveCampaignRewardConfig } from "@/lib/campaign-reward-config";
import {
  campaignUsesDetailedProductStages,
  DETAILED_PRODUCT_STAGE_OPTIONS,
  PRODUCT_STAGE_TOPIC_OPTIONS,
} from "@/lib/product-stage";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const productId = searchParams.get("productId") || undefined;
  const month = searchParams.get("month") || undefined;
  const contentChannel = searchParams.get("contentChannel") || undefined;
  const [campaigns, brandStageRules] = await Promise.all([
    prisma.campaign.findMany({
    where: {
      deletedAt: null,
      month,
      contentChannel,
      ...(productId
        ? {
            OR: [
              { productId },
              { products: { some: { productId } } },
            ],
          }
        : {}),
    },
    include: {
      product: true,
      products: { include: { product: true }, orderBy: { sortOrder: "asc" } },
      interactionRewardTiers: { orderBy: { threshold: "asc" } },
      topicRules: {
        where: {
          status: "ACTIVE",
          ...(contentChannel
            ? { contentChannel: { in: [contentChannel, "ALL"] } }
            : {}),
        },
        select: {
          campaignId: true,
          contentChannel: true,
          topicCategory: true,
          applicableStage: true,
          milkType: true,
          topic: true,
        },
      },
      _count: { select: { topicRules: true } },
    },
    orderBy: [{ month: "desc" }, { updatedAt: "desc" }],
    }),
    prisma.topicRule.findMany({
      where: {
        status: "ACTIVE",
        topicCategory: "PRODUCT_STAGE",
        ...(contentChannel
          ? { contentChannel: { in: [contentChannel, "ALL"] } }
          : {}),
      },
      select: {
        brandName: true,
        campaignId: true,
        contentChannel: true,
        topicCategory: true,
        applicableStage: true,
        milkType: true,
        topic: true,
      },
    }),
  ]);
  return ok(
    campaigns.map(({ topicRules, ...campaign }) => {
      const campaignTopicRules = topicRules.filter((rule) =>
        [campaign.contentChannel, "ALL"].includes(
          rule.contentChannel || "XIAOHONGSHU",
        ),
      );
      const brandName = campaign.product?.brandName ||
        campaign.products[0]?.product.brandName || null;
      const scopedTopicRules = [
        ...campaignTopicRules.filter((rule) => rule.topicCategory !== "PRODUCT_STAGE"),
        ...brandStageRules.filter(
          (rule) =>
            rule.brandName === brandName &&
            [campaign.contentChannel, "ALL"].includes(rule.contentChannel),
        ),
      ];
      const requiresProductStage = campaignRequiresProductStage(scopedTopicRules);
      const detailed = campaignUsesDetailedProductStages(brandName, campaign.month);
      return {
        ...campaign,
        requiresProductStage,
        stageOptions: requiresProductStage
          ? (detailed ? DETAILED_PRODUCT_STAGE_OPTIONS : PRODUCT_STAGE_TOPIC_OPTIONS)
              .filter((option) => scopedTopicRules.some((rule) =>
                rule.topicCategory === "PRODUCT_STAGE" &&
                (detailed
                  ? rule.applicableStage === option.value
                  : rule.milkType === option.value),
              ))
              .map((option) => ({ value: option.value, label: option.label }))
          : [],
      };
    }),
  );
}, "读取活动列表");

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    productId?: string;
    productIds?: string[];
    name?: string;
    month?: string;
    startDate?: string;
    endDate?: string;
    minImageCount?: number;
    minBodyLength?: number;
    publicRequired?: boolean;
    retentionDays?: number;
    rewardDescription?: string;
    interactionRewardEnabled?: boolean;
    interactionRewardThreshold?: number;
    rewardMode?: string;
    basicRewardRequired?: boolean;
    baseRewardAmount?: number;
    interactionRewardTiers?: Array<{ threshold: number; amount: number }>;
    customerRegistrationNotes?: string;
    bodyRequired?: boolean;
    clickableTopicRequired?: boolean;
    contentChannel?: "XIAOHONGSHU" | "DOUYIN";
  };
  const productIds = [
    ...new Set([
      ...(body.productIds || []),
      ...(body.productId ? [body.productId] : []),
    ]),
  ];
  const contentChannel = body.contentChannel === "DOUYIN" ? "DOUYIN" : "XIAOHONGSHU";
  if (!productIds.length || !body.name?.trim() || !body.month) {
    return fail("至少一个产品、活动名称和月份为必填项");
  }
  const campaignName = body.name.trim();
  const campaignMonth = body.month;
  const linkedProducts = await prisma.product.findMany({
    where: { id: { in: productIds }, deletedAt: null },
    select: { id: true, brandName: true },
  });
  const brands = [...new Set(linkedProducts.map((product) => product.brandName))];
  if (linkedProducts.length !== productIds.length || brands.length !== 1) {
    return fail("月度规则关联产品必须存在且属于同一品牌");
  }
  let reward;
  try {
    reward = resolveCampaignRewardConfig(body, {
      basicRewardRequired: legacyBasicRewardRequired({ name: campaignName, contentChannel, brandNames: brands }),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "奖励配置无效");
  }
  const { interactionRewardTiers, ...rewardFields } = reward;
  const existingMonthlyRuleSet = await prisma.campaign.findFirst({
    where: {
      month: body.month,
      contentChannel,
      deletedAt: null,
      OR: [
        { product: { is: { brandName: brands[0] } } },
        { products: { some: { product: { brandName: brands[0] } } } },
      ],
    },
    select: { id: true },
  });
  if (existingMonthlyRuleSet) {
    return fail(`${brands[0]}${body.month} 规则已存在。`, 409);
  }
  try {
    const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.campaign.create({
      data: {
        ruleSource: "LOCAL_DRAFT",
        productId: productIds.length === 1 ? productIds[0] : null,
        name: campaignName,
        contentChannel,
        month: campaignMonth,
        year: Number(campaignMonth.slice(0, 4)),
        startDate: new Date(body.startDate || `${campaignMonth}-01`),
        endDate: new Date(body.endDate || `${campaignMonth}-28`),
        minImageCount: Math.max(0, Math.floor(body.minImageCount ?? 2)),
        minBodyLength: Math.max(
          0,
          Math.floor(body.minBodyLength ?? MIN_BODY_LENGTH),
        ),
        productImageRequired: false,
        firstImageRequirement: null,
        prohibitedImageGuidance: null,
        publicRequired: body.publicRequired ?? false,
        retentionDays: body.retentionDays ?? 0,
        rewardDescription: body.rewardDescription?.trim() || null,
        ...rewardFields,
        interactionRewardTiers: {
          create: interactionRewardTiers.map((tier, sortOrder) => ({ ...tier, sortOrder })),
        },
        visualReviewGuidance: null,
        customerRegistrationNotes:
          body.customerRegistrationNotes?.trim() || null,
        bodyRequired: body.bodyRequired ?? true,
        clickableTopicRequired: body.clickableTopicRequired ?? true,
        products: {
          create: productIds.map((productId, sortOrder) => ({
            productId,
            sortOrder,
          })),
        },
      },
      include: { product: true, products: { include: { product: true } }, interactionRewardTiers: { orderBy: { threshold: "asc" } } },
    });
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "CREATE_CAMPAIGN",
        entityType: "CAMPAIGN",
        entityId: created.id,
        summary: `新增活动 ${created.name}`,
      },
    });
    return created;
    });
    return ok(campaign, { status: 201 });
  } catch {
    return fail("活动重复、产品不存在或日期无效");
  }
}, "新增活动");
