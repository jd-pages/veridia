import dayjs from "dayjs";
import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { resolveTopicRuleOwnership } from "@/lib/topic-rule-model";

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
      products: { include: { product: { select: { brandName: true } } } },
      topicRules: { where: { status: "ACTIVE" }, include: { product: true } },
    },
  });
  if (!source) return fail("源活动不存在", 404);
  const targetMonth = body.month || dayjs(source.month).add(1, "month").format("YYYY-MM");
  if (!/^\d{4}-\d{2}$/u.test(targetMonth)) return fail("规则月份格式应为 YYYY-MM");
  const brandName = source.products[0]?.product.brandName;
  if (!brandName) return fail("源活动未关联有效品牌");
  const existing = await prisma.campaign.findFirst({
    where: {
      month: targetMonth,
      deletedAt: null,
      OR: [
        { product: { is: { brandName } } },
        { products: { some: { product: { brandName } } } },
      ],
    },
    select: { id: true },
  });
  if (existing) return fail(`${brandName}${targetMonth} 规则已存在。`, 409);
  const [targetYear, targetMonthNumber] = targetMonth.split("-");
  const defaultName = source.name.replace(
    /\d{4}年\d{1,2}月/u,
    `${targetYear}年${Number(targetMonthNumber)}月`,
  );
  const copiedRules = source.topicRules.flatMap((rule) => {
    const ownership = resolveTopicRuleOwnership({
      ...rule,
      campaign: source,
    });
    if (ownership.status !== "VALID" || ownership.scope === "GLOBAL") return [];
    return [{ rule, ownership }];
  });
  try {
    const copied = await prisma.campaign.create({
      data: {
        ruleSource: "LOCAL_DRAFT",
        productId: source.productId,
        name: body.name?.trim() || defaultName,
        month: targetMonth,
        year: Number(targetMonth.slice(0, 4)),
        startDate: dayjs(`${targetMonth}-01`).startOf("month").toDate(),
        endDate: dayjs(`${targetMonth}-01`).endOf("month").toDate(),
        minImageCount: source.minImageCount,
        productImageRequired: false,
        firstImageRequirement: null,
        prohibitedImageGuidance: null,
        bodyRequired: source.bodyRequired,
        minBodyLength: source.minBodyLength,
        publicRequired: source.publicRequired,
        retentionDays: source.retentionDays,
        rewardDescription: source.rewardDescription,
        interactionRewardEnabled: source.interactionRewardEnabled,
        interactionRewardThreshold: source.interactionRewardThreshold,
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
          create: copiedRules.map(({ rule, ownership }) => ({
            ruleSource: "LOCAL_DRAFT",
            brandName: rule.brandName,
            productId: ownership.productId,
            scope: ownership.scope,
            contentChannel: source.contentChannel,
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
