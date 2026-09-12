import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  createTopicRule,
  TopicRuleManagementError,
  topicRuleListWhere,
} from "@/lib/topic-rule-management";
import { resolveTopicRuleOwnership } from "@/lib/topic-rule-model";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const campaignId = searchParams.get("campaignId") || undefined;
  const productId = searchParams.get("productId") || undefined;
  const brandName = searchParams.get("brandName")?.trim() || undefined;
  const month = searchParams.get("month")?.trim() || undefined;
  const contentChannel = searchParams.get("contentChannel")?.trim() || undefined;
  const rules = await prisma.topicRule.findMany({
    where: topicRuleListWhere({
      campaignId,
      productId,
      brandName,
      month,
      contentChannel,
    }),
    include: {
      campaign: {
        include: {
          product: true,
          products: { include: { product: true } },
        },
      },
      product: true,
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const projectedRules = rules
    .map((rule) => {
      const ownership = resolveTopicRuleOwnership(rule);
      return {
        ...rule,
        scope: ownership.scope,
        campaignId: ownership.campaignId,
        productId: ownership.productId,
        campaign: ownership.campaignId ? rule.campaign : null,
        product: ownership.productId ? rule.product : null,
        bindingStatus: ownership.status,
        resolutionBasis: ownership.resolutionBasis,
      };
    })
    .filter((rule) =>
      !month ||
      rule.scope === "GLOBAL" ||
      rule.campaign?.month === month ||
      rule.bindingStatus === "UNRESOLVED_ACTIVITY_BINDING"
    );
  return ok(projectedRules);
}, "读取话题规则");

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const rule = await createTopicRule({ userId: user.id, body });
    return ok(rule, { status: 201 });
  } catch (error) {
    return error instanceof TopicRuleManagementError
      ? fail(error.message, error.statusCode)
      : fail("规则数据无效或所属活动不存在");
  }
}, "新增话题规则");
