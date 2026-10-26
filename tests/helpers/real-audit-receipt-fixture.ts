import fs from "node:fs";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import { buildImportedTaskNotes } from "../../lib/import-task-metadata";
import { normalizeStoreNameForMatch, normalizeStoreTopicForMatch } from "../../lib/store-topic-config";

type Row = Record<string, unknown> & { id: string };
export interface ApprovedReceiptDataset {
  inputSha256: string;
  authorization: string;
  productionDatabaseWrites: number;
  data: Record<string, Row[]>;
}

/** Explicit opt-in customer evidence replay. This never opens a source DB or
 * imports account/session records. Ordinary CI has no private fixture input. */
export async function importApprovedAuditReceipts(db: PrismaClient) {
  const input = process.env.VERIDIA_APPROVED_RECEIPTS;
  const metadataInput = process.env.VERIDIA_APPROVED_TASK_METADATA;
  const identitiesInput = process.env.VERIDIA_APPROVED_INPUT_IDENTITIES;
  const url = process.env.E2E_DATABASE_URL;
  if (!input || !metadataInput || !identitiesInput || !url?.startsWith("file:")) throw Error("APPROVED_ISOLATED_INPUT_REQUIRED");
  const owned = path.resolve(".playwright/e2e-runs") + path.sep;
  const target = path.resolve(url.slice(5));
  if (!target.startsWith(owned)) throw Error("REAL_RECEIPT_REPLAY_REQUIRES_OWNED_E2E_DATABASE");
  for (const file of [input, metadataInput, identitiesInput]) {
    if (!path.resolve(file).startsWith(path.resolve(".playwright") + path.sep)) throw Error("PRIVATE_INPUT_OUTSIDE_EVIDENCE_ROOT");
  }
  const source = JSON.parse(fs.readFileSync(input, "utf8")) as ApprovedReceiptDataset;
  if (source.authorization !== "USER_EXPLICIT_LIMITED_READ_ONLY_21_INPUT_LINKS" || source.productionDatabaseWrites !== 0) throw Error("READ_ONLY_AUTHORIZATION_RECEIPT_REQUIRED");
  const metadata = JSON.parse(fs.readFileSync(metadataInput, "utf8")) as { sourceNotesAllUnchanged: boolean; tasks: Array<{ taskId: string; duplicateReaudit?: Record<string, unknown> }> };
  if (!metadata.sourceNotesAllUnchanged) throw Error("TASK_PROVENANCE_CHANGED");
  const identities = JSON.parse(fs.readFileSync(identitiesInput, "utf8")) as { rows: Array<{ row: number; publicUrl: string; product: string; shop: string }> };
  const d = source.data;
  const scalar = (modelName: string, input: Row) => {
    const model = Prisma.dmmf.datamodel.models.find(model => model.name === modelName);
    if (!model) throw Error("UNKNOWN_REPLAY_MODEL");
    return Object.fromEntries(model.fields.filter(field => field.kind !== "object" && input[field.name] !== undefined)
      .map(field => [field.name, input[field.name] === null ? null : field.type === "DateTime" ? new Date(input[field.name] as string | number)
        : field.type === "Boolean" ? Boolean(input[field.name]) : input[field.name]]));
  };
  const create = async (model: string, delegate: string, rows: Row[]) => {
    const writer = (db as unknown as Record<string, { create(input: { data: never }): Promise<unknown> }>)[delegate];
    for (const row of rows) await writer.create({ data: scalar(model, row) as never });
  };
  // Only the fresh run-e2e clone is emptied. Auth stays the test-only seed.
  await db.$transaction([
    db.ruleResult.deleteMany(), db.manualReview.deleteMany(), db.auditResult.deleteMany(),
    db.extractionRecord.deleteMany(), db.noteProduct.deleteMany(), db.noteTopic.deleteMany(),
    db.auditTask.deleteMany(), db.auditBatch.deleteMany(), db.campaignProduct.deleteMany(),
    db.topicRule.deleteMany(), db.productAlias.deleteMany(), db.campaign.deleteMany(), db.product.deleteMany(),
  ]);
  await create("Product", "product", d.products);
  await create("Campaign", "campaign", d.campaigns);
  const productIds = new Set(d.products.map(row => row.id));
  await create("CampaignProduct", "campaignProduct", d.campaignProducts.filter(row => productIds.has(String(row.productId))));
  await create("CampaignInteractionRewardTier", "campaignInteractionRewardTier", d.tiers);
  await create("NoteRecord", "noteRecord", d.notes);
  const tasks = d.tasks.map(task => {
    const evidence = identities.rows.find(row => String(task.url).includes(new URL(row.publicUrl).pathname));
    const provenance = metadata.tasks.find(row => row.taskId === task.id)?.duplicateReaudit;
    let notes = buildImportedTaskNotes({ templateMetadata: { templateType: "KABRITA", templateBrand: "佳贝艾特", rawValues: {
      shopName: String(task.storeName || ""), purchaseProductLine: evidence?.product || "",
      xiaohongshuPublishLink: String(task.url), activityMonth: "10月", customerServiceComment: "",
    } } });
    if (provenance) notes += "\nVERIDIA_DUPLICATE_REAUDIT_JSON：" + JSON.stringify({ ...provenance,
      confirmedByUserId: "deidentified-source-operator", confirmedByDisplayName: "脱敏操作员" });
    return { ...task, batchId: null, importRecordId: null, createdBy: null, notes };
  });
  await create("AuditTask", "auditTask", tasks);
  await create("ExtractionRecord", "extractionRecord", d.extractions);
  await create("AuditResult", "auditResult", d.results);
  await create("RuleResult", "ruleResult", d.ruleResults);
  if (d.manualReviews.length) throw Error("MANUAL_REVIEW_SOURCE_REQUIRES_EXPLICIT_REPLAY_SUPPORT");

  // Reconstruct only the effective topic rules/policies frozen in these records.
  // They are never claimed to be a fresh read of today's mutable store settings.
  const rules = new Map<string, Row>();
  for (const result of d.results) {
    const snapshot = JSON.parse(String(result.ruleSnapshot));
    for (const rule of snapshot.rules || []) {
      const row = { ...rule, brandName: snapshot.brandName, contentChannel: snapshot.contentChannel,
        productId: rule.scope === "PRODUCT" ? snapshot.productId : null,
        campaignId: rule.scope === "CAMPAIGN" ? snapshot.campaignId : null };
      const previous = rules.get(rule.id);
      if (previous && (previous.productId !== row.productId || previous.campaignId !== row.campaignId)) throw Error("AMBIGUOUS_FROZEN_TOPIC_SCOPE");
      rules.set(rule.id, row);
    }
    const policy = snapshot.storeTopicRequirement;
    if (!policy?.storeTopicRuleId || !policy.matchedStoreName || !policy.commercePlatform) continue;
    const canonical = await db.storeTopicRule.upsert({
      where: { commercePlatform_normalizedStoreName: { commercePlatform: policy.commercePlatform, normalizedStoreName: normalizeStoreNameForMatch(policy.matchedStoreName) } },
      create: { id: policy.storeTopicRuleId, commercePlatform: policy.commercePlatform, storeName: policy.matchedStoreName,
        normalizedStoreName: normalizeStoreNameForMatch(policy.matchedStoreName), expectedTopic: policy.expectedTopic || "", enabled: true },
      update: { expectedTopic: policy.expectedTopic || "", enabled: true },
    });
    await db.storeTopicEntry.deleteMany({ where: { storeTopicRuleId: canonical.id, topicType: { in: ["ACCEPTED", "REQUIRED"] } } });
    for (const [topicType, values] of [["ACCEPTED", policy.expectedTopics], ["REQUIRED", policy.requiredTopics]] as const) {
      for (const [sortOrder, topic] of (values || []).entries()) await db.storeTopicEntry.create({ data: {
        storeTopicRuleId: canonical.id, topic, normalizedTopic: normalizeStoreTopicForMatch(topic), topicType, sortOrder,
      } });
    }
    await db.storeBrandTopicPolicy.upsert({
      where: { storeTopicRuleId_brandName_contentChannel: { storeTopicRuleId: canonical.id, brandName: snapshot.brandName, contentChannel: snapshot.contentChannel } },
      create: { storeTopicRuleId: canonical.id, brandName: snapshot.brandName, contentChannel: snapshot.contentChannel,
        requireStoreTopic: policy.storeBrandTopicPolicy?.requireStoreTopic ?? Boolean(policy.expectedTopics?.length || policy.requiredTopics?.length), useSharedTemplate: true },
      update: { requireStoreTopic: policy.storeBrandTopicPolicy?.requireStoreTopic ?? Boolean(policy.expectedTopics?.length || policy.requiredTopics?.length), useSharedTemplate: true },
    });
  }
  await create("TopicRule", "topicRule", [...rules.values()]);
  return { source, identities, database: target, excludedUnusedCampaignProductCount: d.campaignProducts.length - d.campaignProducts.filter(row => productIds.has(String(row.productId))).length };
}
