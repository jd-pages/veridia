import type { Prisma } from "@prisma/client";

/** Editable historical defaults, never a runtime brand authorization list. */
export async function initializeStoreBrandPolicies(tx: Prisma.TransactionClient, newStoreId?: string) {
  const brands = await tx.product.findMany({ where: { deletedAt: null }, select: { brandName: true }, distinct: ["brandName"] });
  const stores = await tx.storeTopicRule.findMany({ where: { deletedAt: null, ...(newStoreId ? { id: newStoreId } : {}) },
    include: { topicEntries: { where: { deletedAt: null, enabled: true } } } });
  for (const store of stores) for (const { brandName } of brands) for (const contentChannel of ["XIAOHONGSHU", "DOUYIN"]) {
    if (!brandName.trim()) continue;
    // Legacy defaults cannot opt an administrator-managed store into a brand
    // that was added later. Missing associations need explicit confirmation.
    const legacyDanone = !newStoreId && !store.updatedBy && brandName === "达能";
    const requireStoreTopic = legacyDanone && store.topicEntries.some(entry =>
      ["ACCEPTED", "ACCEPTED_ALIAS"].includes(entry.topicType) || (contentChannel === "XIAOHONGSHU" && entry.topicType === "REQUIRED"));
    await tx.storeBrandTopicPolicy.upsert({
      where: { storeTopicRuleId_brandName_contentChannel: { storeTopicRuleId: store.id, brandName, contentChannel } },
      create: { storeTopicRuleId: store.id, brandName, contentChannel, requireStoreTopic,
        reviewStatus: newStoreId || legacyDanone || brandName === "雀巢" ? "CONFIRMED" : "PENDING_REVIEW",
        managedBy: newStoreId ? "ADMIN" : "LEGACY" },
      update: {},
    });
  }
}
