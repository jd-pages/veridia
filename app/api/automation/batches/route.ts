import { prisma } from "@/lib/db";
import { fail, ok, requireApiUser } from "@/lib/api";
import { isSupportedNoteUrl, normalizeUrl } from "@/lib/topic";
import {
  createAutomaticBatch,
  getAutomaticBatches,
} from "@/lib/automation/batch-service";
import { kickAutomaticAuditQueue } from "@/lib/automation/queue";
import {
  compatibleStageRuleValues,
  normalizeProductStageTopicValue,
} from "@/lib/product-stage";
import { refreshUsageWithoutBlocking } from "@/lib/central/foundation";

export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  kickAutomaticAuditQueue();
  return ok(await getAutomaticBatches());
}

export async function POST(request: Request) {
  const user = await requireApiUser(["ADMIN", "OPERATOR"]);
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

  const rawUrls = Array.isArray(body.urls)
    ? body.urls
    : String(body.urls || "").split(/\r?\n/);
  const urls = [...new Set(rawUrls.map((item) => item.trim()).filter(Boolean))];
  if (!urls.length) return fail("请至少输入一条笔记链接");
  const invalid = urls.filter((url) => !isSupportedNoteUrl(url));
  if (invalid.length) return fail(`有 ${invalid.length} 条链接格式不正确`);

  const accepted: string[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  for (const url of urls) {
    const existing = await prisma.auditTask.findFirst({
      where: {
        normalizedUrl: normalizeUrl(url),
        campaignId: body.campaignId,
        status: { not: "CANCELLED" },
      },
    });
    if (existing) skipped.push({ url, reason: "同一活动中已有审核任务" });
    else accepted.push(url);
  }
  if (!accepted.length) return fail("没有可创建的链接，可能均已存在");

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
  await refreshUsageWithoutBlocking(user.id);
  kickAutomaticAuditQueue();
  return ok({ batchId: batch.id, created: accepted.length, skipped });
}
