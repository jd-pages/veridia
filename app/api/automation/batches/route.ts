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
  compatibleStageRuleValues,
  normalizeProductStageTopicValue,
} from "@/lib/product-stage";
import {
  auditNoteIdentity,
  auditTaskDuplicateMessages,
  findBlockingAuditTask,
} from "@/lib/audit-task-deduplication";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const batchId = searchParams.get("batchId")?.trim() || undefined;
  const requestedLimit = Number(searchParams.get("limit") || 20);
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 20;
  kickAutomaticAuditQueue();
  return ok(await getAutomaticBatches({ batchId, limit: batchId ? 1 : limit }));
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
  const campaignHasStageRules = await prisma.topicRule.count({
    where: {
      campaignId: body.campaignId,
      topicCategory: "PRODUCT_STAGE",
      status: "ACTIVE",
    },
  });
  if (campaignHasStageRules && (!productStage || !stageRule)) {
    return fail("请选择活动支持的产品阶段话题");
  }

  const extraction = extractNoteLinksFromText(body.urls || []);
  const urls = extraction.links.map((item) => item.url);
  if (!urls.length) return fail("请至少输入一条笔记链接");

  const accepted: string[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  const requestIdentities = new Set<string>();
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
    const duplicate = await findBlockingAuditTask({ url });
    if (duplicate) skipped.push({ url, reason: duplicate.message });
    else accepted.push(url);
  }
  if (!accepted.length) {
    const reasons = new Set(skipped.map((item) => item.reason));
    if (reasons.size === 1) return fail([...reasons][0]);
    return fail(auditTaskDuplicateMessages.TODAY_DUPLICATE);
  }

  const batch = await createAutomaticBatch({
    name: body.name || `自动审核 ${new Date().toLocaleString("zh-CN")}`,
    source: "MANUAL",
    createdBy: user.id,
    productId: body.productId,
    campaignId: body.campaignId,
    productStage: productStage || undefined,
    intervalMs: body.intervalMs,
    tasks: accepted.map((url) => ({
      url,
      originalInput: extraction.rawInput,
      productId: body.productId!,
      campaignId: body.campaignId!,
      productStage,
      milkType: stageRule?.milkType || null,
      notes: body.notes,
      source: "MANUAL",
    })),
  });
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
