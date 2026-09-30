import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { resolveCampaignRewardConfig } from "@/lib/campaign-reward-config";
import type { RewardMode } from "@/lib/interaction-reward";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const campaign = await prisma.campaign.findFirst({
    where: { id, deletedAt: null },
    include: {
      product: true,
      interactionRewardTiers: { orderBy: { threshold: "asc" } },
      products: {
        include: { product: { include: { aliases: true } } },
        orderBy: { sortOrder: "asc" },
      },
      topicRules: {
        where: { status: "ACTIVE" },
        include: { product: true },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  if (!campaign) return fail("活动不存在", 404);
  const brandNames = [
    ...new Set(
      [
        campaign.product?.brandName,
        ...campaign.products.map(({ product }) => product.brandName),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  return ok({
    ...campaign,
    brandNames,
    topicRules: campaign.topicRules.filter(
      (rule) =>
        rule.brandName &&
        brandNames.includes(rule.brandName) &&
        [campaign.contentChannel, "ALL"].includes(rule.contentChannel),
    ),
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  const body = (await request.json()) as Record<string, unknown>;
  const current = await prisma.campaign.findUnique({ where: { id }, include: { interactionRewardTiers: { orderBy: { threshold: "asc" } } } });
  if (!current) return fail("活动不存在", 404);
  let reward;
  try {
    reward = resolveCampaignRewardConfig(body, {
      ...current,
      rewardMode: current.rewardMode as RewardMode,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "奖励配置无效");
  }
  const { interactionRewardTiers, ...rewardFields } = reward;
  try {
    const campaign = await prisma.$transaction(async (tx) => {
    const updated = await tx.campaign.update({
      where: { id },
      data: {
        ruleSource: "LOCAL_DRAFT",
        ...rewardFields,
        ruleVersion: { increment: 1 },
        ...(body.interactionRewardTiers !== undefined ? {
          interactionRewardTiers: {
            deleteMany: {},
            create: interactionRewardTiers.map((tier, sortOrder) => ({ ...tier, sortOrder })),
          },
        } : {}),
        ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
        ...(typeof body.month === "string" ? { month: body.month } : {}),
        ...(body.contentChannel === "XIAOHONGSHU" ||
        body.contentChannel === "DOUYIN"
          ? { contentChannel: body.contentChannel }
          : {}),
        ...(typeof body.startDate === "string"
          ? { startDate: new Date(body.startDate) }
          : {}),
        ...(typeof body.endDate === "string"
          ? { endDate: new Date(body.endDate) }
          : {}),
        ...(typeof body.minImageCount === "number"
          ? { minImageCount: Math.max(0, Math.floor(body.minImageCount)) }
          : {}),
        ...(typeof body.minBodyLength === "number"
          ? { minBodyLength: Math.max(0, Math.floor(body.minBodyLength)) }
          : {}),
        ...(typeof body.publicRequired === "boolean"
          ? { publicRequired: body.publicRequired }
          : {}),
        ...(typeof body.retentionDays === "number"
          ? { retentionDays: body.retentionDays }
          : {}),
        ...(typeof body.rewardDescription === "string"
          ? { rewardDescription: body.rewardDescription.trim() || null }
          : {}),
        ...(typeof body.customerRegistrationNotes === "string"
          ? {
              customerRegistrationNotes:
                body.customerRegistrationNotes.trim() || null,
            }
          : {}),
        ...(typeof body.bodyRequired === "boolean"
          ? { bodyRequired: body.bodyRequired }
          : {}),
        ...(typeof body.clickableTopicRequired === "boolean"
          ? { clickableTopicRequired: body.clickableTopicRequired }
          : {}),
        ...(typeof body.status === "string" ? { status: body.status } : {}),
      },
      include: { product: true, products: { include: { product: true } }, interactionRewardTiers: { orderBy: { threshold: "asc" } } },
    });
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "UPDATE_CAMPAIGN",
        entityType: "CAMPAIGN",
        entityId: id,
        summary: `更新活动 ${updated.name}`,
      },
    });
    return updated;
    });
    return ok(campaign);
  } catch {
    return fail("活动不存在或数据无效");
  }
}

export const PATCH = PUT;

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const campaign = await prisma.campaign.update({
      where: { id },
      data: { status: "INACTIVE", ruleSource: "LOCAL_DRAFT" },
    });
    return ok(campaign);
  } catch {
    return fail("活动不存在", 404);
  }
}
