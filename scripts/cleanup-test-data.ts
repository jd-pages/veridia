import { prisma } from "../lib/db";

const campaignName = process.argv
  .find((argument) => argument.startsWith("--campaign-name="))
  ?.slice("--campaign-name=".length);
const confirmed = process.argv.includes("--confirm-clean-test-data");

if (!confirmed || !campaignName) {
  throw new Error(
    "必须同时提供 --confirm-clean-test-data 和 --campaign-name=<要保留的正式活动全名>",
  );
}

const campaign = await prisma.campaign.findFirst({
  where: { name: campaignName },
  include: { products: true },
});
if (!campaign) throw new Error(`未找到要保留的活动：${campaignName}`);
const productIds = campaign.products.map((item) => item.productId);
if (campaign.productId && !productIds.includes(campaign.productId)) {
  productIds.push(campaign.productId);
}
if (productIds.length !== 5) {
  throw new Error(
    `安全检查未通过：要保留的活动应关联 5 个产品，实际为 ${productIds.length} 个`,
  );
}

const preservedBefore = {
  users: await prisma.user.count(),
  settings: await prisma.systemSetting.count(),
  browserSessions: await prisma.automationSession.count(),
};

await prisma.$transaction(async (tx) => {
  await tx.manualReview.deleteMany();
  await tx.ruleResult.deleteMany();
  await tx.auditResult.deleteMany();
  await tx.extractionRecord.deleteMany();
  await tx.noteTopic.deleteMany();
  await tx.noteProduct.deleteMany();
  await tx.auditTask.deleteMany();
  await tx.auditBatch.deleteMany();
  await tx.noteRecord.deleteMany();

  await tx.topicRule.deleteMany({
    where: { campaignId: { not: campaign.id } },
  });
  await tx.campaign.deleteMany({ where: { id: { not: campaign.id } } });

  await tx.productAlias.deleteMany({
    where: { productId: { notIn: productIds } },
  });
  await tx.product.deleteMany({ where: { id: { notIn: productIds } } });

  await tx.importRecord.deleteMany({
    where: { importType: { not: "CAMPAIGN_RULE" } },
  });
  await tx.operationLog.deleteMany({
    where: {
      OR: [{ entityId: null }, { entityId: { not: campaign.id } }],
    },
  });
});

const result = {
  keptCampaign: campaign.name,
  keptProductIds: productIds,
  counts: {
    campaigns: await prisma.campaign.count(),
    products: await prisma.product.count(),
    topicRules: await prisma.topicRule.count(),
    auditBatches: await prisma.auditBatch.count(),
    auditTasks: await prisma.auditTask.count(),
    auditResults: await prisma.auditResult.count(),
    notes: await prisma.noteRecord.count(),
    imports: await prisma.importRecord.count(),
  },
  preservedBefore,
  preservedAfter: {
    users: await prisma.user.count(),
    settings: await prisma.systemSetting.count(),
    browserSessions: await prisma.automationSession.count(),
  },
};
console.log(JSON.stringify(result, null, 2));
await prisma.$disconnect();
