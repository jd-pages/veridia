import { prisma } from "@/lib/db";
import packageJson from "@/package.json";
import {
  evaluateAudit,
  topicsForPlatformAudit,
} from "@/lib/audit-engine";
import { evaluateSemanticRelevance } from "@/lib/ai";
import { normalizeTopic } from "@/lib/topic";
import { normalizeDouyinTopicName } from "@/lib/douyin-topic";
import { classifyTopicClickability } from "@/lib/topic-clickability";
import { resolveStoreTopicAuditRequirement } from "@/lib/store-topic-rule-service";
import type { AuditContext, ExtractedNote } from "@/lib/types";
import { campaignRequiresProductStage } from "@/lib/campaign-stage-requirement";
import { completedAuditTaskUpdate } from "@/lib/automation/task-lifecycle";
import {
  campaignUsesDetailedProductStages,
  compatibleStageRuleValues,
  normalizeConfiguredProductStageValue,
  productStageTopicLabel,
} from "@/lib/product-stage";
import {
  resolveTaskAutomationPlatform,
  type AutomationPlatform,
} from "@/lib/automation/platform";
import {
  markAuditResultSuperseded,
  resolveAuditResultSlot,
} from "@/lib/audit-result-lifecycle";
import {
  AuditConfigurationError,
  missingProductStageRuleMessage,
} from "@/lib/audit-configuration";
import {
  resolveDuplicateReauditAutomaticOutcome,
} from "@/lib/import-task-metadata";

export async function getAuditContext(
  productId: string,
  campaignId: string,
  productStage?: string | null,
  contentChannel?: AutomationPlatform,
): Promise<AuditContext> {
  const [product, campaign] = await Promise.all([
    prisma.product.findFirst({
      where: { id: productId, status: "ACTIVE", deletedAt: null },
      select: { brandName: true, name: true },
    }),
    prisma.campaign.findFirst({
      where: {
        id: campaignId,
        status: "ACTIVE",
        deletedAt: null,
        OR: [
          { productId },
          { products: { some: { productId } } },
        ],
      },
    }),
  ]);
  if (!campaign) throw new Error("活动不存在、已停用或与所选产品不匹配");
  if (!product) throw new Error("所选产品不存在或已停用");
  const brandName = product?.brandName.trim();
  if (!brandName) throw new Error("所选产品未配置品牌，无法加载话题规则");
  if (!/^\d{4}-\d{2}$/u.test(campaign.month)) {
    throw new Error("规则月份未匹配，无法开始自动审核");
  }
  const resolvedContentChannel: AutomationPlatform =
    contentChannel ||
    (campaign.contentChannel === "DOUYIN" ? "DOUYIN" : "XIAOHONGSHU");
  if (
    contentChannel &&
    ![resolvedContentChannel, "ALL"].includes(campaign.contentChannel)
  ) {
    throw new Error("内容渠道与活动渠道不一致，请选择对应内容平台的审核活动");
  }
  const usesDetailedProductStages = campaignUsesDetailedProductStages(
    brandName,
    campaign.month,
  );
  const normalizedProductStage = normalizeConfiguredProductStageValue(
    productStage,
    usesDetailedProductStages,
  );
  const compatibleStages = compatibleStageRuleValues(normalizedProductStage);

  const rules = await prisma.topicRule.findMany({
    where: {
      brandName,
      status: "ACTIVE",
      contentChannel: { in: [resolvedContentChannel, "ALL"] },
      AND: [
        {
          OR: [
            { scope: "GLOBAL" },
            { scope: "PRODUCT", productId },
            { scope: "CAMPAIGN", campaignId, productId: null },
            { scope: "CAMPAIGN", campaignId, productId },
          ],
        },
        {
          OR: [
            { applicableStage: null },
            ...(compatibleStages.length
              ? [{ applicableStage: { in: compatibleStages } }]
              : []),
          ],
        },
      ],
    },
    orderBy: [{ scope: "asc" }, { sortOrder: "asc" }],
  });
  const campaignStageRequirementRules = await prisma.topicRule.findMany({
    where: {
      brandName,
      campaignId,
      status: "ACTIVE",
      contentChannel: { in: [resolvedContentChannel, "ALL"] },
    },
    select: {
      campaignId: true,
      topicCategory: true,
      applicableStage: true,
      topic: true,
    },
  });
  const campaignChannelMatches = [resolvedContentChannel, "ALL"].includes(
    campaign.contentChannel,
  );
  const requiresProductStage = campaignChannelMatches && campaignRequiresProductStage(
    campaignStageRequirementRules,
  );
  if (requiresProductStage && !normalizedProductStage) {
    throw new AuditConfigurationError("该活动要求选择产品阶段话题");
  }
  const selectedStageRule = rules.find(
    (rule) =>
      rule.topicCategory === "PRODUCT_STAGE" &&
      compatibleStages.includes(rule.applicableStage || ""),
  );
  if (normalizedProductStage && !selectedStageRule) {
    throw new AuditConfigurationError(
      missingProductStageRuleMessage({
        productName: product.name,
        productStage: productStageTopicLabel(normalizedProductStage),
      }),
    );
  }
  const stageGroups = normalizedProductStage
    ? await prisma.ruleStageGroup.findMany({
        where: { key: { in: compatibleStages } },
        orderBy: { sortOrder: "asc" },
      })
    : [];
  const syncState = await prisma.ruleSyncState.findUnique({
    where: { id: "active" },
    select: { currentVersion: true },
  });
  const normalizeConfiguredTopic = (value: unknown) =>
    resolvedContentChannel === "DOUYIN"
      ? normalizeDouyinTopicName(value)
      : normalizeTopic(String(value ?? ""));
  const uniqueRules = rules.filter((rule, index, allRules) => {
    if (rule.topicCategory !== "PRODUCT_STAGE") return true;
    return (
      allRules.findIndex(
        (candidate) =>
          candidate.topicCategory === rule.topicCategory &&
          candidate.applicableStage === rule.applicableStage &&
          normalizeConfiguredTopic(candidate.topic) ===
            normalizeConfiguredTopic(rule.topic),
      ) === index
    );
  });

  return {
    productId,
    campaignId,
    campaignName: campaign.name,
    contentChannel: resolvedContentChannel,
    rulesConfigured: campaignChannelMatches && uniqueRules.length > 0,
    ruleMonth: campaign.month,
    brandName,
    basicRewardRequired:
      resolvedContentChannel === "XIAOHONGSHU" && brandName === "佳贝艾特" &&
      campaign.name === "佳贝艾特2026年8月小红书种草审核",
    requiresProductStage,
    productStage: normalizedProductStage || null,
    productStageLabel: normalizedProductStage
      ? productStageTopicLabel(normalizedProductStage)
      : null,
    bodyStageRequired: stageGroups.some((group) => group.requireBodyStage),
    allowedBodyStageTerms: stageGroups.length
      ? [
          ...new Set(
            stageGroups.flatMap(
              (group) => JSON.parse(group.bodyTerms) as string[],
            ),
          ),
        ]
      : undefined,
    canonicalBodyStages: stageGroups.length
      ? [
          ...new Set(
            stageGroups.flatMap(
              (group) => JSON.parse(group.canonicalStages) as string[],
            ),
          ),
        ]
      : undefined,
    milkType: selectedStageRule?.milkType || null,
    ruleVersion: campaign.ruleVersion,
    rulePackageVersion: syncState?.currentVersion || null,
    bodyRequired: campaign.bodyRequired,
    minBodyLength: campaign.minBodyLength,
    minImageCount: campaign.minImageCount,
    publicRequired: campaign.publicRequired,
    retentionDays: campaign.retentionDays,
    customerRegistrationNotes: campaign.customerRegistrationNotes,
    clickableTopicRequired: campaign.clickableTopicRequired,
    rules: uniqueRules.map((rule) => ({
      id: rule.id,
      scope: rule.scope,
      ruleType: rule.ruleType,
      topic: rule.topic,
      exactMatch: rule.exactMatch,
      clickableRequired: rule.clickableRequired,
      caseSensitive: rule.caseSensitive,
      minCount: rule.minCount,
      sortOrder: rule.sortOrder,
      version: rule.version,
      topicCategory: rule.topicCategory,
      applicableStage: rule.applicableStage,
      milkType: rule.milkType,
    })),
  };
}

export async function runAuditTask(taskId: string, payload: ExtractedNote) {
  const task = await prisma.auditTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("审核任务不存在");
  const contentChannel = resolveTaskAutomationPlatform(task);
  if (!contentChannel) throw new Error("审核任务未关联有效内容平台");

  const baseContext = await getAuditContext(
    task.productId,
    task.campaignId,
    task.productStage,
    contentChannel,
  );
  const storeTopicRequirement = baseContext.rulesConfigured
    ? await resolveStoreTopicAuditRequirement(task)
    : null;
  if (storeTopicRequirement) {
    await prisma.auditTask.update({
      where: { id: task.id },
      data: {
        storeTopicRuleId: storeTopicRequirement.storeTopicRuleId,
        matchedStoreName: storeTopicRequirement.matchedStoreName,
        expectedStoreTopic: storeTopicRequirement.expectedTopic,
        expectedStoreTopics: JSON.stringify(storeTopicRequirement.expectedTopics),
        requiredStoreTopics: JSON.stringify(storeTopicRequirement.requiredTopics),
        storeMappingStatus: storeTopicRequirement.mappingStatus,
      },
    });
  }
  const context = {
    ...baseContext,
    storeTopicRequirement,
  };
  const auditedTopics = topicsForPlatformAudit(payload, contentChannel);
  // Platform publication time is collection metadata only. It is persisted
  // below for display, but is intentionally excluded from every audit rule.
  const evaluation = evaluateAudit(
    { ...payload, topics: auditedTopics, publishedAt: null },
    context,
  );
  const duplicateReauditOutcome = resolveDuplicateReauditAutomaticOutcome(
    task.notes,
    evaluation.autoStatus,
  );
  const persistedAutoStatus = duplicateReauditOutcome.persistedAutoStatus;
  const sanitizedPayload = { ...payload, topics: auditedTopics };
  delete sanitizedPayload.imageUrls;
  const ai = await evaluateSemanticRelevance({
    body: payload.body ?? "",
    topics: auditedTopics.map((topic) =>
      contentChannel === "DOUYIN"
        ? normalizeDouyinTopicName(topic.displayText)
        : normalizeTopic(topic.displayText),
    ),
    enabled: false,
  });

  const result = await prisma.$transaction(async (tx) => {
    const existingByPlatformId = payload.noteId
      ? await tx.noteRecord.findUnique({
          where: {
            contentChannel_platformNoteId: {
              contentChannel,
              platformNoteId: payload.noteId,
            },
          },
        })
      : null;
    const existingByUrl = await tx.noteRecord.findFirst({
      where: { url: payload.url, contentChannel },
    });
    let existingNote = existingByPlatformId || existingByUrl;
    if (
      existingByPlatformId &&
      existingByUrl &&
      existingByPlatformId.id !== existingByUrl.id
    ) {
      await tx.auditResult.updateMany({
        where: { noteId: existingByUrl.id },
        data: { noteId: existingByPlatformId.id },
      });
      await tx.extractionRecord.updateMany({
        where: { noteId: existingByUrl.id },
        data: { noteId: existingByPlatformId.id },
      });
      await tx.noteTopic.deleteMany({
        where: { noteId: existingByUrl.id },
      });
      await tx.noteProduct.deleteMany({
        where: { noteId: existingByUrl.id },
      });
      await tx.noteRecord.delete({
        where: { id: existingByUrl.id },
      });
      existingNote = existingByPlatformId;
    }
    const parsedPublishedAt = payload.publishedAt
      ? new Date(payload.publishedAt)
      : null;
    const platformPublishedAt =
      payload.pageStatus === "NORMAL" &&
      parsedPublishedAt &&
      !Number.isNaN(parsedPublishedAt.getTime())
        ? parsedPublishedAt
        : null;
    const noteData = {
      contentChannel,
      platformNoteId: payload.noteId,
      url: payload.url,
      finalUrl: payload.finalUrl ?? payload.url,
      title: payload.title,
      body: payload.body,
      authorName: payload.authorName,
      publishedAt: platformPublishedAt,
      publishedAtRaw: payload.pageStatus === "NORMAL"
        ? payload.publishedAtRaw ?? null
        : null,
      publishedAtSource: payload.pageStatus === "NORMAL"
        ? payload.publishedAtSource ?? null
        : null,
      pageStatus: payload.pageStatus,
      isPublic: payload.isPublic ?? null,
      noteType: evaluation.noteType,
      imageExtractionStatus: evaluation.imageExtractionStatus,
      imageCount: evaluation.imageCount ?? 0,
      imageUrls: "[]",
      lastCapturedAt: new Date(payload.extractedAt),
    };
    const note = existingNote
      ? await tx.noteRecord.update({
          where: { id: existingNote.id },
          data: noteData,
        })
      : await tx.noteRecord.create({
          data: {
            ...noteData,
            firstCapturedAt: new Date(payload.extractedAt),
          },
        });

    await tx.noteProduct.upsert({
      where: { noteId_productId: { noteId: note.id, productId: task.productId } },
      create: { noteId: note.id, productId: task.productId, isPrimary: true },
      update: { isPrimary: true },
    });
    await tx.noteTopic.deleteMany({ where: { noteId: note.id } });
    if (auditedTopics.length) {
      await tx.noteTopic.createMany({
        data: auditedTopics.map((topic) => ({
          noteId: note.id,
          displayText: topic.displayText,
          normalizedText:
            contentChannel === "DOUYIN"
              ? normalizeDouyinTopicName(topic.displayText)
              : normalizeTopic(topic.displayText),
          isLinkElement: topic.isLinkElement,
          hasHref: topic.hasHref,
          href: topic.href,
          textColor: topic.textColor,
          styleFeature: topic.styleFeature,
          isClickable: Boolean(
            classifyTopicClickability(topic, {
              pageUrl: payload.finalUrl || payload.url,
            }) === "CLICKABLE",
          ),
          domPath: topic.domPath,
          source: topic.source || null,
        })),
      });
    }

    await tx.extractionRecord.create({
      data: {
        auditTaskId: task.id,
        noteId: note.id,
        adapterName: payload.adapterName,
        adapterVersion: payload.adapterVersion,
        pageStatus: payload.pageStatus,
        rawData: JSON.stringify(sanitizedPayload),
        extractedAt: new Date(payload.extractedAt),
      },
    });

    const auditResultData = {
      auditTaskId: task.id,
      noteId: note.id,
      ruleVersion: context.ruleVersion,
      softwareVersion: packageJson.version,
      rulePackageVersion: context.rulePackageVersion,
      ruleSnapshot: JSON.stringify(context),
      pageStatus: evaluation.pageStatus,
      bodyStatus: evaluation.bodyStatus,
      effectiveBodyLength: evaluation.effectiveBodyLength,
      bodyCompliant: evaluation.bodyCompliant,
      noteType: evaluation.noteType,
      imageExtractionStatus: evaluation.imageExtractionStatus,
      imageStatus: evaluation.imageStatus,
      imageCount: evaluation.imageCount ?? 0,
      imageCompliant: evaluation.imageCompliant ?? true,
      topicsCompliant: evaluation.topicsCompliant,
      clickableCompliant: evaluation.clickableCompliant,
      storeTopicStatus: evaluation.storeTopicStatus,
      expectedStoreTopic: evaluation.expectedStoreTopic,
      expectedStoreTopics: JSON.stringify(evaluation.expectedStoreTopics),
      requiredStoreTopics: JSON.stringify(evaluation.requiredStoreTopics),
      matchedStoreTopic: evaluation.matchedStoreTopic,
      matchedStoreTopics: JSON.stringify(evaluation.matchedStoreTopics),
      matchedRequiredStoreTopics: JSON.stringify(
        evaluation.matchedRequiredStoreTopics,
      ),
      storeTopicFailureReason: evaluation.storeTopicFailureReason,
      missingTopics: JSON.stringify(evaluation.missingTopics),
      forbiddenTopics: JSON.stringify(evaluation.forbiddenTopics),
      autoStatus: persistedAutoStatus,
      publicStatus: evaluation.publicStatus,
      retentionStatus: evaluation.retentionStatus,
      retentionDueAt: evaluation.retentionDueAt
        ? new Date(evaluation.retentionDueAt)
        : null,
      visualReviewStatus: "NOT_REQUIRED",
      visualReviewDetails: "{}",
      failureReasons: JSON.stringify(evaluation.failureReasons),
      aiStatus: ai.status,
      aiRelevance: ai.relevance,
      aiReason: ai.reason,
    };
    const ruleResultData = evaluation.ruleResults.map((item) => ({
      ruleKey: item.ruleKey,
      ruleName: item.ruleName,
      expectedValue: item.expectedValue,
      actualValue: item.actualValue,
      passed: item.passed,
      failureReason: item.failureReason,
      evidence: JSON.stringify(item.evidence),
    }));
    const resultSlot = await resolveAuditResultSlot(tx, task);
    const auditResult = await tx.auditResult.create({
      data: {
        ...auditResultData,
        originTaskId: resultSlot.originTaskId,
        resultSlotOrder: resultSlot.resultSlotOrder,
        resultSlotCreatedAt: resultSlot.resultSlotCreatedAt,
        ruleResults: { create: ruleResultData },
      },
      include: { ruleResults: true },
    });
    if (resultSlot.replacementResultId) {
      await markAuditResultSuperseded(tx, {
        previousResultId: resultSlot.replacementResultId,
        nextResultId: auditResult.id,
        supersededAt: new Date(),
      });
    }

    await tx.auditTask.update({
      where: { id: task.id },
      data: duplicateReauditOutcome.isDuplicateReaudit
        ? {
            status: "NEEDS_REVIEW",
            finishedAt: new Date(),
            notes: duplicateReauditOutcome.notes,
          }
        : evaluation.autoStatus === "READ_FAILED"
          ? { status: "READ_FAILED", finishedAt: new Date() }
          : evaluation.autoStatus === "NEEDS_REVIEW"
            ? { status: "NEEDS_REVIEW", finishedAt: new Date() }
          : completedAuditTaskUpdate(),
    });

    return auditResult;
  });

  if (task.createdBy) {
  }
  return result;
}
