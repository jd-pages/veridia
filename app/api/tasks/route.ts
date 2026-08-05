import { prisma } from "@/lib/db";
import { extractSupportedNoteUrls, isSupportedNoteUrl, normalizeUrl } from "@/lib/topic";
import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  compatibleStageRuleValues,
  normalizeProductStageTopicValue,
} from "@/lib/product-stage";
import packageJson from "@/package.json";
import { campaignRequiresProductStage } from "@/lib/campaign-stage-requirement";
import { backfillMissingProcessingFailureResults } from "@/lib/processing-failure-result";
import {
  auditNoteIdentity,
  auditTaskDuplicateMessages,
  findBlockingAuditTask,
} from "@/lib/audit-task-deduplication";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") || undefined;
  const batchId = searchParams.get("batchId")?.trim() || undefined;
  const batchIds = (searchParams.get("batchIds") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 50);
  const requestedPage = Number(searchParams.get("page") || 1);
  const requestedPageSize = Number(searchParams.get("pageSize") || 50);
  const page = Number.isFinite(requestedPage)
    ? Math.max(1, Math.floor(requestedPage))
    : 1;
  const pageSize = Number.isFinite(requestedPageSize)
    ? Math.min(100, Math.max(1, Math.floor(requestedPageSize)))
    : 50;
  const paginated =
    searchParams.has("page") ||
    searchParams.has("pageSize") ||
    batchIds.length > 0;
  const where = {
    status,
    ...(batchIds.length
      ? { batchId: { in: batchIds } }
      : { batchId }),
  };
  await backfillMissingProcessingFailureResults();
  const [tasks, total] = await Promise.all([
    prisma.auditTask.findMany({
      where,
      include: {
        batch: { select: { id: true, name: true } },
        product: true,
        campaign: true,
        auditResults: { orderBy: { auditedAt: "desc" }, take: 1 },
      },
      orderBy:
        batchId || batchIds.length
          ? [{ createdAt: "asc" }, { queueOrder: "asc" }]
          : [{ createdAt: "desc" }],
      skip: paginated ? (page - 1) * pageSize : 0,
      take: paginated ? pageSize : 100,
    }),
    paginated ? prisma.auditTask.count({ where }) : Promise.resolve(0),
  ]);
  return ok(paginated ? { items: tasks, total, page, pageSize } : tasks);
}, "读取审核任务");

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    urls?: string | string[];
    productId?: string;
    campaignId?: string;
    productStage?: string;
    notes?: string;
    skipDuplicates?: boolean;
  };
  if (!body.productId || !body.campaignId) return fail("请选择产品和活动");
  const productStage = normalizeProductStageTopicValue(body.productStage);
  const campaign = await prisma.campaign.findFirst({
    where: {
      id: body.campaignId,
      status: "ACTIVE",
      deletedAt: null,
      OR: [
        { productId: body.productId },
        { products: { some: { productId: body.productId } } },
      ],
    },
  });
  if (!campaign) return fail("活动不存在或与产品不匹配");
  const campaignRules = await prisma.topicRule.findMany({
    where: {
      campaignId: body.campaignId,
      status: "ACTIVE",
    },
    select: {
      topicCategory: true,
      applicableStage: true,
      topic: true,
      milkType: true,
    },
  });
  const requiresProductStage = campaignRequiresProductStage(campaignRules);
  const stageRule = requiresProductStage && productStage
    ? campaignRules.find(
        (rule) =>
          rule.topicCategory === "PRODUCT_STAGE" &&
          compatibleStageRuleValues(productStage).includes(
            rule.applicableStage || "",
          ),
      )
    : null;
  if (requiresProductStage && (!productStage || !stageRule)) {
    return fail("请选择活动支持的产品阶段话题");
  }
  const effectiveProductStage = requiresProductStage ? productStage : null;

  const uniqueUrls = extractSupportedNoteUrls(body.urls || []);
  const created = [];
  const syncState = await prisma.ruleSyncState.findUnique({
    where: { id: "active" },
    select: { currentVersion: true },
  });
  const errors: Array<{ url: string; reason: string }> = [];
  const requestIdentities = new Set<string>();
  for (const url of uniqueUrls) {
    if (!isSupportedNoteUrl(url)) {
      errors.push({ url, reason: "链接格式不正确或不是支持的小红书/模拟链接" });
      continue;
    }
    const normalizedUrl = normalizeUrl(url);
    const identity = auditNoteIdentity(url);
    if (requestIdentities.has(identity)) {
      errors.push({
        url,
        reason: auditTaskDuplicateMessages.TODAY_DUPLICATE,
      });
      continue;
    }
    requestIdentities.add(identity);
    const duplicate = await findBlockingAuditTask({ url });
    if (duplicate) {
      errors.push({ url, reason: duplicate.message });
      continue;
    }
    created.push(
      await prisma.auditTask.create({
        data: {
          url,
          normalizedUrl,
          productId: body.productId,
          campaignId: body.campaignId,
          productStage: effectiveProductStage,
          milkType: stageRule?.milkType || null,
          notes: body.notes?.trim() || null,
          platform: "XIAOHONGSHU",
          createdBy: user.id,
          source: "MANUAL",
          softwareVersion: packageJson.version,
          rulePackageVersion: syncState?.currentVersion || null,
        },
      }),
    );
  }
  await prisma.operationLog.create({
    data: {
      userId: user.id,
      action: "CREATE_AUDIT_TASKS",
      entityType: "AUDIT_TASK",
      summary: `手工创建 ${created.length} 条任务，异常 ${errors.length} 条`,
    },
  });
  return ok({ created, errors });
}, "创建审核任务");
