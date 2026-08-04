import dayjs from "dayjs";
import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { MIN_BODY_LENGTH } from "@/lib/audit-constants";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    month?: string;
    name?: string;
  };
  const source = await prisma.campaign.findUnique({
    where: { id },
    include: {
      products: true,
      topicRules: { where: { status: "ACTIVE" } },
    },
  });
  if (!source) return fail("源活动不存在", 404);
  const targetMonth = body.month || dayjs(source.month).add(1, "month").format("YYYY-MM");
  try {
    const copied = await prisma.campaign.create({
      data: {
        ruleSource: "LOCAL_DRAFT",
        productId: source.productId,
        name: body.name?.trim() || `${source.name}（${targetMonth}复制）`,
        month: targetMonth,
        year: Number(targetMonth.slice(0, 4)),
        startDate: dayjs(`${targetMonth}-01`).startOf("month").toDate(),
        endDate: dayjs(`${targetMonth}-01`).endOf("month").toDate(),
        minImageCount: source.minImageCount,
        productImageRequired: false,
        firstImageRequirement: null,
        prohibitedImageGuidance: null,
        bodyRequired: source.bodyRequired,
        minBodyLength: MIN_BODY_LENGTH,
        publicRequired: source.publicRequired,
        retentionDays: source.retentionDays,
        rewardDescription: source.rewardDescription,
        visualReviewGuidance: null,
        customerRegistrationNotes: source.customerRegistrationNotes,
        clickableTopicRequired: source.clickableTopicRequired,
        products: {
          create: source.products.map((link) => ({
            productId: link.productId,
            sortOrder: link.sortOrder,
          })),
        },
        topicRules: {
          create: source.topicRules.map((rule) => ({
            ruleSource: "LOCAL_DRAFT",
            brandName: rule.brandName,
            productId: rule.productId,
            scope: "CAMPAIGN",
            ruleType: rule.ruleType,
            topicCategory: rule.topicCategory,
            applicableStage: rule.applicableStage,
            milkType: rule.milkType,
            topic: rule.topic,
            exactMatch: rule.exactMatch,
            clickableRequired: rule.clickableRequired,
            caseSensitive: rule.caseSensitive,
            minCount: rule.minCount,
            sortOrder: rule.sortOrder,
            notes: rule.notes,
          })),
        },
      },
      include: { topicRules: true, product: true },
    });
    await prisma.operationLog.create({
      data: {
        userId: user.id,
        action: "COPY_CAMPAIGN",
        entityType: "CAMPAIGN",
        entityId: copied.id,
        summary: `复制活动 ${source.name} 到 ${targetMonth}`,
        metadata: JSON.stringify({ sourceId: source.id }),
      },
    });
    return ok(copied, { status: 201 });
  } catch {
    return fail("目标月份已有同名活动，请修改名称");
  }
}
