import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { extractNoteLinksFromText } from "@/lib/note-links";
import {
  createAutomaticBatch,
  getAutomaticBatches,
} from "@/lib/automation/batch-service";
import { kickAutomaticAuditQueue } from "@/lib/automation/queue";
import {
  campaignUsesDetailedProductStages,
  compatibleStageRuleValues,
  normalizeConfiguredProductStageValue,
} from "@/lib/product-stage";
import {
  auditNoteIdentity,
  auditTaskDuplicateMessages,
  findBlockingAuditTasks,
} from "@/lib/audit-task-deduplication";
import { campaignRequiresProductStage } from "@/lib/campaign-stage-requirement";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const batchId = searchParams.get("batchId")?.trim() || undefined;
  const batchIds = (searchParams.get("batchIds") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 50);
  const requestedLimit = Number(searchParams.get("limit") || 20);
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 20;
  const includeTasks = searchParams.get("includeTasks") !== "false";
  kickAutomaticAuditQueue();
  return ok(
    await getAutomaticBatches({
      batchId,
      batchIds,
      limit: batchId ? 1 : limit,
      includeTasks,
    }),
  );
}, "读取自动审核批次");

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    urls?: string | string[];
    productId?: string;
    campaignId?: string;
    productStage?: string;
    name?: string;
    notes?: string;
    intervalMs?: number;
  };
  if (!body.productId || !body.campaignId) return fail("请选择产品和活动");
  const [campaign, product] = await Promise.all([
    prisma.campaign.findFirst({
      where: {
        id: body.campaignId,
        status: "ACTIVE",
        deletedAt: null,
        OR: [
          { productId: body.productId },
          { products: { some: { productId: body.productId } } },
        ],
      },
    }),
    prisma.product.findUnique({
      where: { id: body.productId },
      select: { brandName: true },
    }),
  ]);
  if (!campaign) return fail("活动不存在或与产品不匹配");
  if (!product) return fail("产品不存在");
  const productStage = normalizeConfiguredProductStageValue(
    body.productStage,
    campaignUsesDetailedProductStages(product.brandName, campaign.month),
  );
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

  const extraction = extractNoteLinksFromText(body.urls || []);
  const urls = extraction.links.map((item) => item.url);
  if (!urls.length) return fail("请至少输入一条笔记链接");

  const accepted: string[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  const requestIdentities = new Set<string>();
  const blockingTasks = await findBlockingAuditTasks({ urls });
  for (const url of urls) {
    const identity = auditNoteIdentity(url);
    if (requestIdentities.has(identity)) {
      skipped.push({
        url,
        reason: auditTaskDuplicateMessages.TODAY_DUPLICATE,
      });
      continue;
    }
    requestIdentities.add(identity);
    const duplicate = blockingTasks.get(url);
    if (duplicate) skipped.push({ url, reason: duplicate.message });
    else accepted.push(url);
  }
  if (!accepted.length) {
    const reasons = new Set(skipped.map((item) => item.reason));
    if (reasons.size === 1) return fail([...reasons][0]);
    return fail(auditTaskDuplicateMessages.TODAY_DUPLICATE);
  }

  let batch;
  try {
    batch = await createAutomaticBatch({
      name: body.name || `自动审核 ${new Date().toLocaleString("zh-CN")}`,
      source: "MANUAL",
      createdBy: user.id,
      productId: body.productId,
      campaignId: body.campaignId,
      productStage: effectiveProductStage || undefined,
      intervalMs: body.intervalMs,
      tasks: accepted.map((url) => ({
        url,
        originalInput: extraction.rawInput,
        productId: body.productId!,
        campaignId: body.campaignId!,
        productStage: effectiveProductStage,
        milkType: stageRule?.milkType || null,
        notes: body.notes,
        platform: "XIAOHONGSHU",
        channel: "XIAOHONGSHU",
        source: "MANUAL",
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "创建自动审核批次失败";
    if (message.includes("当前已有小红书自动审核任务正在运行")) {
      return fail(message, 409, "XHS_AUDIT_ALREADY_RUNNING");
    }
    throw error;
  }
  await prisma.operationLog.create({
    data: {
      userId: user.id,
      action: "CREATE_AUTOMATIC_BATCH",
      entityType: "AUDIT_BATCH",
      entityId: batch.id,
      summary: `创建自动审核批次，共 ${accepted.length} 条，跳过 ${skipped.length} 条`,
    },
  });
  kickAutomaticAuditQueue();
  return ok({
    batchId: batch.id,
    created: accepted.length,
    skipped,
    recognizedCount: extraction.recognizedCount,
    deduplicatedCount: urls.length,
    duplicateCount: extraction.duplicateCount,
    unrecognized: extraction.unrecognized,
  });
}, "创建自动审核批次");
