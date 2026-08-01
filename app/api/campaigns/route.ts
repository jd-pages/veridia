import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const productId = searchParams.get("productId") || undefined;
  const month = searchParams.get("month") || undefined;
  const campaigns = await prisma.campaign.findMany({
    where: {
      deletedAt: null,
      month,
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
      _count: { select: { topicRules: true } },
    },
    orderBy: [{ month: "desc" }, { updatedAt: "desc" }],
  });
  return ok(campaigns);
}, "读取活动列表");

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const user = await requireApiUser(["ADMIN"]);
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
  };
  const productIds = [
    ...new Set([
      ...(body.productIds || []),
      ...(body.productId ? [body.productId] : []),
    ]),
  ];
  if (!productIds.length || !body.name?.trim() || !body.month) {
    return fail("至少一个产品、活动名称和月份为必填项");
  }
  try {
    const campaign = await prisma.campaign.create({
      data: {
        ruleSource: "LOCAL_DRAFT",
        productId: productIds.length === 1 ? productIds[0] : null,
        name: body.name.trim(),
        month: body.month,
        year: Number(body.month.slice(0, 4)),
        startDate: new Date(body.startDate || `${body.month}-01`),
        endDate: new Date(body.endDate || `${body.month}-28`),
        minImageCount: Math.max(0, Math.floor(body.minImageCount ?? 2)),
        minBodyLength: body.minBodyLength ?? 1,
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
