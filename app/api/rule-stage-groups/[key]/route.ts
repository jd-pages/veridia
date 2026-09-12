import { fail, ok, requireApiUser } from "@/lib/api";
import { prisma } from "@/lib/db";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { normalizeTopic } from "@/lib/topic";

const ALLOWED_KEYS = new Set([
  "IFFO_P1",
  "IFFO_2",
  "GUM_3_4_1PLUS_2PLUS",
]);

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { key } = await params;
  if (!ALLOWED_KEYS.has(key)) return fail("产品阶段话题无效");
  const body = (await request.json()) as {
    brandName?: string;
    campaignId?: string;
    contentChannel?: "XIAOHONGSHU" | "DOUYIN";
    bodyTerms?: string[];
    requireBodyStage?: boolean;
    requiredTopic?: string;
  };
  const brandName = body.brandName?.trim();
  if (!brandName) return fail("产品阶段话题必须归属品牌");
  const bodyTerms = [
    ...new Set(
      (body.bodyTerms || []).map((item) => item.trim()).filter(Boolean),
    ),
  ];
  if (!bodyTerms.length) return fail("正文允许段位不能为空");
  const requiredTopic = normalizeTopic(body.requiredTopic || "");
  if (!requiredTopic || requiredTopic === "#") {
    return fail("要求阶段话题不能为空");
  }
  const [currentGroup, campaign] = await Promise.all([
    prisma.ruleStageGroup.findUnique({ where: { key } }),
    body.campaignId ? prisma.campaign.findFirst({
      where: {
        id: body.campaignId,
        deletedAt: null,
        OR: [
          { product: { is: { brandName } } },
          { products: { some: { product: { brandName } } } },
        ],
      },
    }) : null,
  ]);
  if (!currentGroup) return fail("产品阶段话题不存在", 404);
  if (body.campaignId && !campaign) return fail("规则月份对应的活动不存在", 404);
  const contentChannel = body.contentChannel ||
    (campaign?.contentChannel === "DOUYIN" ? "DOUYIN" : "XIAOHONGSHU");
  const canonicalStages = JSON.parse(currentGroup.canonicalStages) as string[];
  const updated = await prisma.$transaction(async (tx) => {
    const candidates = await tx.topicRule.findMany({
      where: {
        brandName,
        contentChannel,
        topicCategory: "PRODUCT_STAGE",
        applicableStage: { in: [key, ...canonicalStages] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const canonical = candidates[0];
    if (!canonical) {
      throw new Error("当前品牌未配置对应阶段通用规则");
    }
    const version = Math.max(...candidates.map((rule) => rule.version)) + 1;
    await tx.topicRule.update({
      where: { id: canonical.id },
      data: {
        scope: "GLOBAL",
        campaignId: null,
        productId: null,
        topic: requiredTopic,
        ruleSource: "LOCAL_DRAFT",
        version,
      },
    });
    if (candidates.length > 1) {
      await tx.topicRule.deleteMany({
        where: { id: { in: candidates.slice(1).map((rule) => rule.id) } },
      });
    }
    await tx.ruleStageGroup.update({
      where: { key },
      data: {
        bodyTerms: JSON.stringify(bodyTerms),
        requireBodyStage: Boolean(body.requireBodyStage),
        requiredTopic,
        ruleSource: "LOCAL_DRAFT",
      },
    });
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "UPDATE_RULE",
        entityType: "TOPIC_RULE",
        entityId: canonical.id,
        summary: `更新阶段通用规则 ${requiredTopic}`,
        metadata: JSON.stringify({
          brandName,
          contentChannel,
          stageGroupKey: key,
          deduplicatedRuleIds: candidates.slice(1).map((rule) => rule.id),
        }),
      },
    });
    return { ruleId: canonical.id, updatedRuleCount: candidates.length };
  });
  return ok(updated);
}
