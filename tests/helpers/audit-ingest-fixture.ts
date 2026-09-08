import { randomUUID } from "node:crypto";
import type { AuditTask, Prisma, PrismaClient } from "@prisma/client";
import type { ExtractedNote } from "@/lib/types";

/** Synthetic rule/task fixture. Callers must supply their own isolated database. */
export async function createAuditIngestFixture(db: PrismaClient) {
  const suffix = randomUUID();
  const { product, campaign } = await db.$transaction(async (tx) => {
    const product = await tx.product.create({ data: { name: `入口产品 ${suffix}`, brandName: `入口品牌 ${suffix}` } });
    const campaign = await tx.campaign.create({ data: {
      name: `入口活动 ${suffix}`, productId: product.id, month: "2026-09",
      startDate: new Date("2026-09-01T00:00:00Z"), endDate: new Date("2026-09-30T23:59:59Z"),
      contentChannel: "XIAOHONGSHU", minBodyLength: 21, minImageCount: 2,
      bodyRequired: true, publicRequired: true, clickableTopicRequired: true,
    } });
    await tx.topicRule.create({ data: {
      campaignId: campaign.id, productId: product.id, brandName: product.brandName,
      scope: "CAMPAIGN", ruleType: "REQUIRED", topic: "#inne多维锌", clickableRequired: true,
    } });
    return { product, campaign };
  });
  return {
    product, campaign,
    async cleanup() {
      await db.$transaction(async (tx) => {
        // Every deletion is anchored to this invocation's unique fixture IDs.
        const tasks = await tx.auditTask.findMany({
          where: { productId: product.id, campaignId: campaign.id }, select: { id: true },
        });
        const taskIds = tasks.map((task) => task.id);
        const results = await tx.auditResult.findMany({
          where: { auditTaskId: { in: taskIds } }, select: { id: true, noteId: true },
        });
        const extractions = await tx.extractionRecord.findMany({
          where: { auditTaskId: { in: taskIds } }, select: { noteId: true },
        });
        const productNotes = await tx.noteProduct.findMany({
          where: { productId: product.id }, select: { noteId: true },
        });
        const resultIds = results.map((result) => result.id);
        const noteIds = [...new Set([...results, ...extractions, ...productNotes].map((item) => item.noteId))];
        await tx.manualReview.deleteMany({ where: { auditResultId: { in: resultIds } } });
        await tx.ruleResult.deleteMany({ where: { auditResultId: { in: resultIds } } });
        await tx.auditResult.deleteMany({ where: { id: { in: resultIds } } });
        await tx.extractionRecord.deleteMany({ where: { auditTaskId: { in: taskIds } } });
        await tx.auditTask.deleteMany({ where: { id: { in: taskIds }, productId: product.id, campaignId: campaign.id } });
        await tx.noteProduct.deleteMany({ where: { productId: product.id } });
        // A shared note survives while any other fixture/business relation uses it.
        await tx.noteRecord.deleteMany({ where: { id: { in: noteIds },
          auditResults: { none: {} }, extractions: { none: {} }, noteProducts: { none: {} },
        } });
        await tx.operationLog.deleteMany({ where: { entityId: { in: [...taskIds, ...resultIds, product.id, campaign.id] } } });
        await tx.topicRule.deleteMany({ where: { productId: product.id, campaignId: campaign.id } });
        await tx.campaignProduct.deleteMany({ where: { productId: product.id, campaignId: campaign.id } });
        await tx.productAlias.deleteMany({ where: { productId: product.id } });
        await tx.campaign.deleteMany({ where: { id: campaign.id, productId: product.id } });
        await tx.product.deleteMany({ where: { id: product.id } });
      });
    },
    async task(patch: Partial<Prisma.AuditTaskUncheckedCreateInput> = {}) {
      const noteId = randomUUID().replaceAll("-", "").slice(0, 24);
      const url = `https://www.xiaohongshu.com/explore/${noteId}`;
      return db.auditTask.create({ data: {
        productId: product.id, campaignId: campaign.id,
        url, normalizedUrl: url, channel: "XIAOHONGSHU", ...patch,
      } });
    },
  };
}

export function auditIngestExtraction(task: Pick<AuditTask, "url" | "finalUrl">, patch: Partial<ExtractedNote> = {}): ExtractedNote {
  const url = task.finalUrl || task.url;
  const noteId = new URL(url).pathname.match(/\/explore\/([^/]+)/u)?.[1] ?? null;
  const topic = {
    displayText: "#inne多维锌", isClickable: true, isLinkElement: true, hasHref: true,
    href: "https://www.xiaohongshu.com/search_result?keyword=inne%E5%A4%9A%E7%BB%B4%E9%94%8C",
    styleFeature: true, source: "DOM_LINK", domPath: "#detail a.topic",
  };
  return {
    url: task.url, finalUrl: url, contentChannel: "XIAOHONGSHU", noteId,
    title: "入口边界测试", body: "这是一段用来验证审核入口状态与身份绑定的合成正文，长度满足审核要求。",
    pageStatus: "NORMAL", pageType: "NOTE_DETAIL", noteType: "IMAGE_TEXT",
    imageExtractionStatus: "SUCCESS", imageCount: 2,
    topics: [topic], verifiedPlatformTopics: [topic], topicEvidenceCollected: true,
    publishedAt: "2026-08-01T00:00:00.000Z", isPublic: true,
    extractedAt: new Date().toISOString(), adapterName: "xhs-ingest-fixture", adapterVersion: "1.0.0",
    ...patch,
  };
}
