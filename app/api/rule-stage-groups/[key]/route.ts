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
    bodyTerms?: string[];
    requireBodyStage?: boolean;
    requiredTopic?: string;
  };
  const brandName = body.brandName?.trim();
  if (!brandName) return fail("产品阶段话题必须归属品牌");
  if (!body.campaignId) return fail("请选择规则月份对应的活动");
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
    prisma.campaign.findFirst({
      where: {
        id: body.campaignId,
        deletedAt: null,
        OR: [
          { product: { is: { brandName } } },
          { products: { some: { product: { brandName } } } },
        ],
      },
    }),
  ]);
  if (!currentGroup) return fail("产品阶段话题不存在", 404);
  if (!campaign) return fail("规则月份对应的活动不存在", 404);
  const canonicalStages = JSON.parse(currentGroup.canonicalStages) as string[];
  const updated = await prisma.$transaction(async (tx) => {
    const versionedCampaign = await tx.campaign.update({
      where: { id: campaign.id },
      data: { ruleSource: "LOCAL_DRAFT", ruleVersion: { increment: 1 } },
    });
    const rules = await tx.topicRule.updateMany({
      where: {
        brandName,
        campaignId: campaign.id,
        topicCategory: "PRODUCT_STAGE",
        applicableStage: { in: [key, ...canonicalStages] },
      },
      data: {
        topic: requiredTopic,
        ruleSource: "LOCAL_DRAFT",
        version: versionedCampaign.ruleVersion,
      },
    });
    return { campaign: versionedCampaign, updatedRuleCount: rules.count };
  });
  return ok(updated);
}
