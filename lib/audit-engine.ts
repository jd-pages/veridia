import type {
  AuditContext,
  AuditEvaluation,
  ExtractedNote,
  ExtractedTopic,
  RuleEvaluation,
} from "@/lib/types";
import { compareTopic, normalizeTopic } from "@/lib/topic";
import {
  classifyTopicCandidates,
  type TopicClickabilityContext,
  type TopicClickability,
} from "@/lib/topic-clickability";
import {
  detectBodyProductStages,
  productStageTopicLabel,
} from "@/lib/product-stage";

const pageFailureLabels: Record<string, string> = {
  NOT_FOUND: "笔记页面不存在",
  DELETED: "笔记已删除",
  NO_PERMISSION: "当前账号无权访问笔记",
  LOGIN_EXPIRED: "登录状态已失效",
  SECURITY_VERIFICATION: "页面要求验证码或安全验证",
  READ_FAILED: "页面读取失败",
  NEEDS_CONFIRMATION: "页面状态需要人工确认",
};

function findExactTopics(
  topics: ExtractedTopic[],
  expected: string,
  caseSensitive: boolean,
): ExtractedTopic[] {
  return topics.filter((topic) =>
    compareTopic(topic.displayText, expected, caseSensitive),
  );
}

function preferredTopicCandidate(
  candidates: ExtractedTopic[],
  clickability: TopicClickability,
  context: TopicClickabilityContext,
) {
  return (
    candidates.find(
      (candidate) =>
        classifyTopicCandidates([candidate], context) === clickability,
    ) || candidates[0]
  );
}

export function countEffectiveBodyCharacters(input: string | null | undefined) {
  return String(input || "")
    .replace(/https?:\/\/\S+|www\.\S+/giu, "")
    .replace(/#[^\s#]+/gu, "")
    .replace(/[\p{P}\p{S}\s]/gu, "").length;
}

export function evaluateAudit(
  note: ExtractedNote,
  context: AuditContext,
): AuditEvaluation {
  const evaluations: RuleEvaluation[] = [];
  const failures: string[] = [];
  const missingTopics: string[] = [];
  const forbiddenTopics: string[] = [];
  const clickableChecks: boolean[] = [];
  let clickabilityNeedsReview = false;
  const technicalWarnings = new Set(note.technicalWarnings || []);
  const extractedBodyAvailable = Boolean(note.body?.trim());
  const extractedTopicsAvailable = note.topics.length > 0;
  const bodyReadIncomplete =
    technicalWarnings.has("BODY_NOT_RECOGNIZED") && !extractedBodyAvailable;
  const topicsReadIncomplete =
    technicalWarnings.has("TOPICS_NOT_RECOGNIZED") && !extractedTopicsAvailable;
  const unresolvedTechnicalWarnings = new Set(
    [...technicalWarnings].filter(
      (warning) =>
        !(
          (warning === "BODY_NOT_RECOGNIZED" && extractedBodyAvailable) ||
          (warning === "TOPICS_NOT_RECOGNIZED" && extractedTopicsAvailable)
        ),
    ),
  );
  const topicClickabilityContext: TopicClickabilityContext = {
    pageUrl: note.finalUrl || note.url,
  };

  const pagePassed = note.pageStatus === "NORMAL";
  evaluations.push({
    ruleKey: "GLOBAL_PAGE_STATUS",
    ruleName: "页面状态",
    expectedValue: "正常",
    actualValue: note.pageStatus,
    passed: pagePassed,
    failureReason: pagePassed ? undefined : pageFailureLabels[note.pageStatus],
    evidence: { url: note.url, pageStatus: note.pageStatus },
  });
  if (!pagePassed) failures.push(pageFailureLabels[note.pageStatus] ?? "页面状态异常");

  if (!pagePassed) {
    return {
      pageStatus: note.pageStatus,
      bodyStatus: "UNKNOWN",
      effectiveBodyLength: 0,
      bodyCompliant: true,
      noteType: note.noteType ?? "UNKNOWN",
      imageExtractionStatus: note.imageExtractionStatus ?? "NOT_CHECKED",
      imageStatus: "NOT_REQUIRED",
      imageCount: null,
      imageCompliant: null,
      topicsCompliant: true,
      clickableCompliant: true,
      publicStatus: "UNKNOWN",
      retentionStatus: "NOT_REQUIRED",
      retentionDueAt: null,
      missingTopics: [],
      forbiddenTopics: [],
      autoStatus:
        note.pageStatus === "READ_FAILED" ? "READ_FAILED" : "NEEDS_REVIEW",
      failureReasons: [...new Set(failures)],
      ruleResults: evaluations,
    };
  }

  const noteType = note.noteType ?? "UNKNOWN";
  const imageExtractionStatus =
    note.imageExtractionStatus ??
    (Number.isInteger(note.imageCount) && Number(note.imageCount) >= 0
      ? "SUCCESS"
      : "IMAGES_READ_FAILED");
  let imageStatus: AuditEvaluation["imageStatus"] = "NOT_REQUIRED";
  let imageCount: number | null = null;
  let imageCompliant: boolean | null = null;

  if (pagePassed && noteType === "VIDEO_NOTE") {
    imageStatus = "VIDEO_NOTE";
    evaluations.push({
      ruleKey: "GLOBAL_IMAGE_COUNT",
      ruleName: "图片数量",
      expectedValue: `图文笔记至少 ${context.minImageCount} 张图片`,
      actualValue: "视频笔记，不适用图片数量规则",
      passed: true,
      evidence: { noteType, imageExtractionStatus: "VIDEO_NOTE" },
    });
  } else if (pagePassed && imageExtractionStatus === "SUCCESS") {
    imageCount = Number.isInteger(note.imageCount)
      ? Math.max(0, Number(note.imageCount))
      : null;
    if (imageCount === null) {
      imageStatus = "IMAGES_READ_FAILED";
      evaluations.push({
        ruleKey: "GLOBAL_IMAGE_COUNT",
        ruleName: "图片数量",
        expectedValue: `图文笔记至少 ${context.minImageCount} 张图片`,
        actualValue: "图片数量读取失败",
        passed: true,
        evidence: { noteType, imageExtractionStatus: "IMAGES_READ_FAILED" },
      });
    } else {
      imageCompliant = imageCount >= context.minImageCount;
      imageStatus = imageCompliant ? "COMPLIANT" : "NON_COMPLIANT";
      evaluations.push({
        ruleKey: "GLOBAL_IMAGE_COUNT",
        ruleName: "图片数量",
        expectedValue: `至少 ${context.minImageCount} 张`,
        actualValue: `${imageCount} 张`,
        passed: imageCompliant,
        failureReason: imageCompliant
          ? undefined
          : `图片数量不足：要求至少 ${context.minImageCount} 张，实际 ${imageCount} 张`,
        evidence: {
          noteType,
          imageExtractionStatus,
          imageCount,
          minImageCount: context.minImageCount,
        },
      });
      if (!imageCompliant) {
        failures.push(`图片数量不足（${imageCount}/${context.minImageCount}）`);
      }
    }
  } else if (pagePassed) {
    imageStatus = "IMAGES_READ_FAILED";
    evaluations.push({
      ruleKey: "GLOBAL_IMAGE_COUNT",
      ruleName: "图片数量",
      expectedValue: `图文笔记至少 ${context.minImageCount} 张图片`,
      actualValue: "图片数量读取失败，待人工复核",
      passed: true,
      evidence: { noteType, imageExtractionStatus },
    });
  }

  const bodyPresent = Boolean(note.body && note.body.trim().length > 0);
  const effectiveBodyLength = countEffectiveBodyCharacters(note.body);
  const bodyPassed =
    bodyReadIncomplete ||
    !context.bodyRequired ||
    (bodyPresent && effectiveBodyLength >= context.minBodyLength);
  evaluations.push({
    ruleKey: "GLOBAL_BODY",
    ruleName: "笔记正文",
    expectedValue: context.bodyRequired
      ? `至少 ${context.minBodyLength} 个有效正文字符`
      : "正文可选",
    actualValue: bodyPresent
      ? `${effectiveBodyLength} 个有效正文字符`
      : "正文为空",
    passed: bodyPassed,
    failureReason: bodyPassed
      ? undefined
      : bodyPresent
        ? `有效正文字数不足：要求至少 ${context.minBodyLength} 个，实际 ${effectiveBodyLength} 个`
        : "笔记正文为空",
    evidence: {
      rawBodyLength: note.body?.length ?? 0,
      effectiveBodyLength,
      excluded: "话题标签、链接、空格、换行、纯标点和符号",
    },
  });
  if (!bodyPassed) {
    failures.push(
      bodyPresent
        ? `有效正文字数不足（${effectiveBodyLength}/${context.minBodyLength}）`
        : "笔记正文为空",
    );
  }

  const configuredStageTopic =
    context.rules.find(
      (rule) =>
        rule.topicCategory === "PRODUCT_STAGE" && Boolean(rule.topic),
    )?.topic || null;
  const bodyStage = context.bodyStageRequired !== false
    ? detectBodyProductStages(note.body, context.productStage, {
        label: context.productStageLabel,
        canonicalStages: context.canonicalBodyStages,
        bodyTerms: context.allowedBodyStageTerms,
      })
    : null;
  if (bodyStage) {
    const bodyStageFailure = bodyStage.passed
      ? undefined
      : bodyStage.status === "OUTSIDE_GROUP"
        ? `正文段位不属于当前产品阶段话题：${productStageTopicLabel(context.productStage)}`
        : "正文未出现对应段位";
    evaluations.push({
      ruleKey: "PRODUCT_STAGE_BODY",
      ruleName: "正文段位",
      expectedValue: `出现以下任意一个：${bodyStage.allowedStages.join("、")}`,
      actualValue: bodyStage.detectedStages.length
        ? bodyStage.detectedStages.join("、")
        : "段位未识别",
      passed: bodyStage.passed,
      failureReason: bodyStageFailure,
      evidence: {
        productStageTopic: bodyStage.groupLabel,
        allowedStages: bodyStage.allowedStages,
        detectedStages: bodyStage.detectedStages,
        matchedAllowedStages: bodyStage.matchedAllowedStages,
        requiredStageTopic: configuredStageTopic,
      },
    });
    if (bodyStageFailure) failures.push(bodyStageFailure);
  }

  const publicStatus: AuditEvaluation["publicStatus"] = !context.publicRequired
    ? "NOT_REQUIRED"
    : note.isPublic === true
      ? "PUBLIC"
      : note.isPublic === false
        ? "NOT_PUBLIC"
        : "UNKNOWN";
  const publicPassed = !context.publicRequired || publicStatus !== "NOT_PUBLIC";
  evaluations.push({
    ruleKey: "GLOBAL_PUBLIC_STATUS",
    ruleName: "笔记公开状态",
    expectedValue: context.publicRequired ? "当前必须公开" : "不要求",
    actualValue:
      publicStatus === "PUBLIC"
        ? "已公开"
        : publicStatus === "NOT_PUBLIC"
          ? "未公开"
          : publicStatus === "UNKNOWN"
            ? "无法自动确认"
            : "不要求",
    passed: publicPassed,
    failureReason: publicPassed ? undefined : "笔记当前未公开",
    evidence: { isPublic: note.isPublic ?? null },
  });
  if (!publicPassed) failures.push("笔记当前未公开");

  let retentionStatus: AuditEvaluation["retentionStatus"] = "NOT_REQUIRED";
  let retentionDueAt: string | null = null;
  if (context.retentionDays > 0 && publicStatus !== "NOT_PUBLIC") {
    if (note.publishedAt) {
      const publishedAt = new Date(note.publishedAt);
      if (!Number.isNaN(publishedAt.getTime())) {
        const dueAt = new Date(
          publishedAt.getTime() + context.retentionDays * 24 * 60 * 60 * 1000,
        );
        retentionDueAt = dueAt.toISOString();
        retentionStatus =
          publicStatus === "PUBLIC" && Date.now() >= dueAt.getTime()
            ? "SATISFIED"
            : "PENDING";
      } else {
        retentionStatus = "PENDING";
      }
    } else {
      retentionStatus = "PENDING";
    }
  } else if (context.retentionDays > 0 && publicStatus === "NOT_PUBLIC") {
    retentionStatus = "NOT_SATISFIED";
  }
  evaluations.push({
    ruleKey: "GLOBAL_RETENTION",
    ruleName: "公开留存",
    expectedValue:
      context.retentionDays > 0 ? `公开保留至少 ${context.retentionDays} 天` : "不要求",
    actualValue:
      retentionStatus === "SATISFIED"
        ? "已满足"
        : retentionStatus === "PENDING"
          ? "待验证"
          : retentionStatus === "NOT_SATISFIED"
            ? "未满足"
            : "不要求",
    passed: retentionStatus !== "NOT_SATISFIED",
    failureReason:
      retentionStatus === "NOT_SATISFIED" ? "公开留存要求未满足" : undefined,
    evidence: {
      publishedAt: note.publishedAt ?? null,
      retentionDays: context.retentionDays,
      dueAt: retentionDueAt,
    },
  });

  const activeRules = topicsReadIncomplete
    ? []
    : [...context.rules].sort((a, b) => a.sortOrder - b.sortOrder);
  if (topicsReadIncomplete) {
    evaluations.push({
      ruleKey: "TOPIC_TECHNICAL_READ",
      ruleName: "话题读取状态",
      expectedValue: "读取页面中的要求话题及可点击状态",
      actualValue: "未识别到话题，待人工确认",
      passed: true,
      evidence: {
        technicalWarning: "TOPICS_NOT_RECOGNIZED",
        detectedTopics: note.topics.map((topic) => topic.displayText),
      },
    });
  }
  const productStageRules = activeRules.filter(
    (rule) =>
      rule.topicCategory === "PRODUCT_STAGE" &&
      rule.ruleType !== "FORBIDDEN" &&
      rule.ruleType !== "ALIAS",
  );
  const anyRules = activeRules.filter(
    (rule) =>
      rule.ruleType === "ANY" && rule.topicCategory !== "PRODUCT_STAGE",
  );
  const nonAnyRules = activeRules.filter(
    (rule) =>
      rule.ruleType !== "ANY" &&
      rule.topicCategory !== "PRODUCT_STAGE",
  );

  for (const rule of nonAnyRules) {
    if (rule.ruleType === "ALIAS") continue;
    const expected = normalizeTopic(rule.topic);
    const matches = findExactTopics(
      note.topics,
      expected,
      rule.caseSensitive,
    );
    const clickability = classifyTopicCandidates(
      matches,
      topicClickabilityContext,
    );
    const match = preferredTopicCandidate(
      matches,
      clickability,
      topicClickabilityContext,
    );
    const clickableRequired =
      rule.clickableRequired || context.clickableTopicRequired;

    if (rule.ruleType === "FORBIDDEN") {
      const passed = !match;
      evaluations.push({
        ruleKey: `TOPIC_${rule.id}`,
        ruleName: `禁止话题 ${expected}`,
        expectedValue: "不得出现",
        actualValue: match ? "已命中" : "未出现",
        passed,
        failureReason: passed ? undefined : `命中禁止话题 ${expected}`,
        evidence: { match: match ?? null },
      });
      if (!passed) {
        forbiddenTopics.push(expected);
        failures.push(`命中禁止话题 ${expected}`);
      }
      continue;
    }

    const present = matches.length > 0;
    const clickable = clickability === "CLICKABLE";
    const clickabilityUnknown =
      present && clickableRequired && clickability === "UNKNOWN";
    const passed =
      present &&
      (!clickableRequired || clickability !== "NOT_CLICKABLE");
    let failureReason: string | undefined;
    if (!present) {
      const expectedBody = expected.replace(/^#/u, "");
      const nearMatch = note.topics.find((topic) => {
        const actualBody = normalizeTopic(topic.displayText).replace(/^#/u, "");
        return (
          actualBody !== expectedBody &&
          (actualBody.includes(expectedBody) ||
            expectedBody.includes(actualBody))
        );
      });
      failureReason = nearMatch
        ? `话题文字不准确：要求 ${expected}，实际 ${normalizeTopic(nearMatch.displayText)}`
        : `缺少精确话题 ${expected}`;
    } else if (
      clickableRequired &&
      clickability === "NOT_CLICKABLE"
    ) {
      failureReason = `要求话题不可点击 ${expected}`;
    }

    if (present && clickableRequired) {
      clickableChecks.push(clickability !== "NOT_CLICKABLE");
      clickabilityNeedsReview ||= clickabilityUnknown;
    }

    evaluations.push({
      ruleKey: `TOPIC_${rule.id}`,
      ruleName:
        rule.topicCategory === "BRAND_COMMON" ||
        rule.ruleType === "BRAND_COMMON"
          ? `品牌通用话题 ${expected}`
          : rule.topicCategory === "PRODUCT_STAGE"
            ? `产品阶段话题 ${productStageTopicLabel(context.productStage)} · ${expected}`
            : rule.topicCategory === "PRODUCT_COMMON"
              ? `产品通用话题 ${expected}`
          : `必须话题 ${expected}`,
      expectedValue: clickableRequired
        ? "精确出现且为可点击话题"
        : "精确出现",
      actualValue: present
        ? clickable
          ? "精确出现，可点击"
          : clickabilityUnknown
            ? "精确出现，可点击状态需人工确认"
            : "精确出现，不可点击"
        : "未精确出现",
      passed,
      failureReason,
      evidence: {
        expected,
        detectedTopics: note.topics.map((topic) => topic.displayText),
        dom: match
          ? {
              isLinkElement: match.isLinkElement,
              hasHref: match.hasHref,
              href: match.href,
              styleFeature: match.styleFeature,
              source: match.source || null,
              finalClickability: clickability,
            }
          : null,
      },
    });
    if (!passed) {
      if (!present) missingTopics.push(expected);
      if (failureReason) failures.push(failureReason);
    }
  }

  if (productStageRules.length) {
    const candidates = productStageRules.map((rule) => {
      const topics = findExactTopics(
        note.topics,
        rule.topic,
        rule.caseSensitive,
      );
      const clickability = classifyTopicCandidates(
        topics,
        topicClickabilityContext,
      );
      return {
        rule,
        topics,
        clickability,
        clickableRequired:
          rule.clickableRequired || context.clickableTopicRequired,
        preferred: preferredTopicCandidate(
          topics,
          clickability,
          topicClickabilityContext,
        ),
      };
    });
    const matchedCandidates = candidates.filter(
      (candidate) => candidate.topics.length > 0,
    );
    const acceptedCandidates = matchedCandidates.filter(
      (candidate) =>
        !candidate.clickableRequired ||
        candidate.clickability !== "NOT_CLICKABLE",
    );
    const passed = acceptedCandidates.length > 0;
    const expectedTopics = productStageRules.map((rule) =>
      normalizeTopic(rule.topic),
    );
    const matchedTopics = matchedCandidates.map((candidate) =>
      normalizeTopic(candidate.rule.topic),
    );
    const nearMatches = candidates.flatMap((candidate) => {
      if (candidate.topics.length) return [];
      const expected = normalizeTopic(candidate.rule.topic);
      const expectedBody = expected.replace(/^#/u, "");
      const nearMatch = note.topics.find((topic) => {
        const actualBody = normalizeTopic(topic.displayText).replace(/^#/u, "");
        return (
          actualBody !== expectedBody &&
          (actualBody.includes(expectedBody) ||
            expectedBody.includes(actualBody))
        );
      });
      return nearMatch
        ? [
            {
              expected,
              actual: normalizeTopic(nearMatch.displayText),
            },
          ]
        : [];
    });
    const acceptedTopics = acceptedCandidates.map((candidate) =>
      normalizeTopic(candidate.rule.topic),
    );
    const stageLabel = productStageTopicLabel(context.productStage);
    const clickabilityUnknown =
      passed &&
      acceptedCandidates.every(
        (candidate) => candidate.clickability === "UNKNOWN",
      );
    if (matchedCandidates.some((candidate) => candidate.clickableRequired)) {
      clickableChecks.push(passed);
      clickabilityNeedsReview ||= clickabilityUnknown;
    }
    const failureReason = passed
      ? undefined
      : matchedCandidates.length
        ? `要求话题不可点击 ${matchedTopics.join("、")}`
        : nearMatches.length
          ? `话题文字不准确：要求 ${nearMatches[0].expected}，实际 ${nearMatches[0].actual}`
          : `${stageLabel} 阶段话题未命中：${expectedTopics.join("、")} 中至少出现 1 个`;
    evaluations.push({
      ruleKey: `TOPIC_PRODUCT_STAGE_GROUP_${stageLabel}`,
      ruleName: `产品阶段话题 ${stageLabel}`,
      expectedValue: `${expectedTopics.join("、")} 中任意 1 个${
        context.clickableTopicRequired ? "，且可点击" : ""
      }`,
      actualValue: matchedCandidates.length
        ? `已命中 ${matchedTopics.join("、")}${
            clickabilityUnknown ? "，可点击状态需人工确认" : ""
          }`
        : "未命中阶段话题候选",
      passed,
      failureReason,
      evidence: {
        stageGroup: stageLabel,
        expectedTopics,
        matchedTopics,
        acceptedTopics,
        candidates: candidates.map((candidate) => ({
          topic: normalizeTopic(candidate.rule.topic),
          applicableStage: candidate.rule.applicableStage || null,
          present: candidate.topics.length > 0,
          clickability: candidate.clickability,
          match: candidate.preferred || null,
        })),
      },
    });
    if (!passed && failureReason) failures.push(failureReason);
  }

  if (anyRules.length) {
    for (const rule of anyRules) {
      const topics = findExactTopics(
        note.topics,
        rule.topic,
        rule.caseSensitive,
      );
      const clickability = classifyTopicCandidates(
        topics,
        topicClickabilityContext,
      );
      if (topics.length && rule.clickableRequired) {
        clickableChecks.push(clickability !== "NOT_CLICKABLE");
        clickabilityNeedsReview ||= clickability === "UNKNOWN";
      }
    }
    const matches = anyRules
      .map((rule) => {
        const topics = findExactTopics(
          note.topics,
          rule.topic,
          rule.caseSensitive,
        );
        const clickability = classifyTopicCandidates(
          topics,
          topicClickabilityContext,
        );
        return {
          rule,
          topic: preferredTopicCandidate(
            topics,
            clickability,
            topicClickabilityContext,
          ),
          clickability,
        };
      })
      .filter(
        (entry) =>
          Boolean(entry.topic) &&
          (!entry.rule.clickableRequired ||
            entry.clickability !== "NOT_CLICKABLE"),
      );
    const minCount = Math.max(...anyRules.map((rule) => rule.minCount), 1);
    const passed = matches.length >= minCount;
    const expectedTopics = anyRules.map((rule) => normalizeTopic(rule.topic));
    evaluations.push({
      ruleKey: "TOPIC_ANY_GROUP",
      ruleName: "任意包含话题",
      expectedValue: `${expectedTopics.join("、")} 中至少 ${minCount} 个`,
      actualValue: `命中 ${matches.length} 个：${matches
        .map((entry) => normalizeTopic(entry.rule.topic))
        .join("、") || "无"}`,
      passed,
      failureReason: passed ? undefined : `任意话题命中不足 ${minCount} 个`,
      evidence: { expectedTopics, matchedCount: matches.length },
    });
    if (!passed) failures.push(`任意话题命中不足 ${minCount} 个`);
  }

  const topicEvaluations = evaluations.filter((item) =>
    item.ruleKey.startsWith("TOPIC_"),
  );
  const bodyStageEvaluation = evaluations.find(
    (item) => item.ruleKey === "PRODUCT_STAGE_BODY",
  );
  const topicsCompliant =
    topicEvaluations.every((item) => item.passed) &&
    (bodyStageEvaluation?.passed ?? true);
  // 目标话题缺失属于“话题存在性”问题。只有已出现的目标话题才参与
  // 蓝色可点击判断，避免把“缺少话题”误报为“可点击异常”。
  const clickableCompliant = clickableChecks.every(Boolean);

  if (bodyReadIncomplete) failures.push("未提取到正文，需人工复核");
  if (topicsReadIncomplete) failures.push("未识别到话题内容，需人工复核");

  let autoStatus: AuditEvaluation["autoStatus"] = "PASSED";
  if (!pagePassed) {
    autoStatus =
      note.pageStatus === "READ_FAILED" ? "READ_FAILED" : "NEEDS_REVIEW";
  } else if (unresolvedTechnicalWarnings.size > 0 || clickabilityNeedsReview) {
    autoStatus = "NEEDS_REVIEW";
  } else if (failures.length) {
    autoStatus = "FAILED";
  } else if (
    publicStatus === "UNKNOWN" ||
    imageStatus === "IMAGES_READ_FAILED"
  ) {
    autoStatus = "NEEDS_REVIEW";
  }

  return {
    pageStatus: note.pageStatus,
    bodyStatus: bodyPresent ? "PRESENT" : "EMPTY",
    effectiveBodyLength,
    bodyCompliant: bodyPassed,
    noteType,
    imageExtractionStatus,
    imageStatus,
    imageCount,
    imageCompliant,
    topicsCompliant,
    clickableCompliant,
    publicStatus,
    retentionStatus,
    retentionDueAt,
    missingTopics: [...new Set(missingTopics)],
    forbiddenTopics: [...new Set(forbiddenTopics)],
    autoStatus,
    failureReasons: [...new Set(failures)],
    ruleResults: evaluations,
  };
}
