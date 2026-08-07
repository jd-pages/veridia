import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { MIN_BODY_LENGTH } from "@/lib/audit-constants";
import { campaignRequiresProductStage } from "@/lib/campaign-stage-requirement";
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
  const campaigns = await prisma.campaign.findMany({
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
  });
  return ok(
    campaigns.map(({ topicRules, ...campaign }) => {
      const scopedTopicRules = topicRules.filter((rule) =>
        [campaign.contentChannel, "ALL"].includes(
          rule.contentChannel || "XIAOHONGSHU",
        ),
      );
      const brandName = campaign.product?.brandName ||
        campaign.products[0]?.product.brandName || null;
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
  const linkedProducts = await prisma.product.findMany({
    where: { id: { in: productIds }, deletedAt: null },
    select: { id: true, brandName: true },
  });
  const brands = [...new Set(linkedProducts.map((product) => product.brandName))];
  if (linkedProducts.length !== productIds.length || brands.length !== 1) {
    return fail("月度规则关联产品必须存在且属于同一品牌");
  }
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
    const campaign = await prisma.campaign.create({
      data: {
        ruleSource: "LOCAL_DRAFT",
        productId: productIds.length === 1 ? productIds[0] : null,
        name: body.name.trim(),
        contentChannel,
        month: body.month,
        year: Number(body.month.slice(0, 4)),
        startDate: new Date(body.startDate || `${body.month}-01`),
        endDate: new Date(body.endDate || `${body.month}-28`),
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
      include: { product: true, products: { include: { product: true } } },
    });
    await prisma.operationLog.create({
      data: {
        userId: user.id,
        action: "CREATE_CAMPAIGN",
        entityType: "CAMPAIGN",
        entityId: campaign.id,
        summary: `新增活动 ${campaign.name}`,
      },
    });
    return ok(campaign, { status: 201 });
  } catch {
    return fail("活动重复、产品不存在或日期无效");
  }
}, "新增活动");
