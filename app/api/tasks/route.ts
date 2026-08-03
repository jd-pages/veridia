import { prisma } from "@/lib/db";
import { extractSupportedNoteUrls, isSupportedNoteUrl, normalizeUrl } from "@/lib/topic";
import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import {
  compatibleStageRuleValues,
  normalizeProductStageTopicValue,
} from "@/lib/product-stage";
import packageJson from "@/package.json";
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
  await backfillMissingProcessingFailureResults();
  const tasks = await prisma.auditTask.findMany({
    where: { status, batchId },
    include: {
      product: true,
      campaign: true,
      auditResults: { orderBy: { auditedAt: "desc" }, take: 1 },
    },
    orderBy: batchId ? { queueOrder: "asc" } : { createdAt: "desc" },
    take: 100,
  });
  return ok(tasks);
}, "读取审核任务");

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const user = await requireApiUser(["ADMIN", "OPERATOR"]);
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
  const stageRule = await prisma.topicRule.findFirst({
    where: {
      campaignId: body.campaignId,
      topicCategory: "PRODUCT_STAGE",
      applicableStage: productStage
        ? { in: compatibleStageRuleValues(productStage) }
        : undefined,
      status: "ACTIVE",
    },
  });
  if (
    (await prisma.topicRule.count({
      where: {
        campaignId: body.campaignId,
        topicCategory: "PRODUCT_STAGE",
        status: "ACTIVE",
      },
    })) > 0 &&
    (!productStage || !stageRule)
  ) {
    return fail("请选择活动支持的产品阶段话题");
  }

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
          productStage,
          milkType: stageRule?.milkType || null,
          notes: body.notes?.trim() || null,
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
