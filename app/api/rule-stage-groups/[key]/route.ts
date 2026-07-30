import { fail, ok, requireApiUser } from "@/lib/api";
import { prisma } from "@/lib/db";
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
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  const { key } = await params;
  if (!ALLOWED_KEYS.has(key)) return fail("产品阶段话题无效");
  const body = (await request.json()) as {
    bodyTerms?: string[];
    requiredTopic?: string;
  };
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
  const [currentVersion, currentGroup] = await Promise.all([
    prisma.ruleSyncState.findUnique({
      where: { id: "active" },
      select: { currentVersion: true },
    }),
    prisma.ruleStageGroup.findUnique({ where: { key } }),
  ]);
  if (!currentGroup) return fail("产品阶段话题不存在", 404);
  const canonicalStages = JSON.parse(currentGroup.canonicalStages) as string[];
  const updated = await prisma.$transaction(async (tx) => {
    const group = await tx.ruleStageGroup.update({
      where: { key },
      data: {
        bodyTerms: JSON.stringify(bodyTerms),
        requiredTopic,
        ruleSource: "LOCAL_DRAFT",
        ruleVersion: `${currentVersion?.currentVersion || "local"}-draft`,
      },
    });
    await tx.topicRule.updateMany({
      where: {
        topicCategory: "PRODUCT_STAGE",
        applicableStage: { in: [key, ...canonicalStages] },
      },
      data: {
        topic: requiredTopic,
        ruleSource: "LOCAL_DRAFT",
      },
    });
    return group;
  });
  return ok(updated);
}
