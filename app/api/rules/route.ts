import { prisma } from "@/lib/db";
import { normalizeTopic } from "@/lib/topic";
import { fail, ok, requireApiUser } from "@/lib/api";

export async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const campaignId = searchParams.get("campaignId") || undefined;
  const productId = searchParams.get("productId") || undefined;
  const rules = await prisma.topicRule.findMany({
    where: { campaignId, productId },
    include: { campaign: true, product: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return ok(rules);
}

export async function POST(request: Request) {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    campaignId?: string;
    productId?: string;
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
  };
  const topic = normalizeTopic(body.topic || "");
  if (!body.ruleType || !topic) return fail("规则类型和标准话题为必填项");
  const ruleType = body.ruleType;
  if ((body.scope ?? "CAMPAIGN") === "CAMPAIGN" && !body.campaignId) {
    return fail("活动规则必须选择所属活动");
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
          campaignId: body.campaignId || null,
          productId: body.productId || null,
          scope: body.scope || "CAMPAIGN",
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
}
