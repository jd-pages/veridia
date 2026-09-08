import { expect, test, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { ExtractedNote } from "@/lib/types";
import { auditIngestExtraction, createAuditIngestFixture } from "../helpers/audit-ingest-fixture";
import { boundaryNote, boundaryTopic, plainBoundaryTopic, topicBoundaryChannels,
  type TopicBoundaryChannel, type TopicBoundaryClickability } from "../helpers/audit-topic-boundary-fixture";

type Fixture = Awaited<ReturnType<typeof createAuditIngestFixture>>;

function isolatedDatabase() {
  const datasourceUrl = process.env.E2E_DATABASE_URL?.trim();
  if (!datasourceUrl) throw new Error("只能通过隔离 E2E runner 执行，必须提供 E2E_DATABASE_URL");
  return new PrismaClient({ datasourceUrl });
}

async function configureRules(db: PrismaClient, fixture: Fixture, channel: TopicBoundaryChannel, input: {
  global: boolean; local: boolean; ruleType?: "REQUIRED" | "ANY"; topics?: string[]; minCount?: number;
}) {
  await db.$transaction(async (tx) => {
    await tx.campaign.update({ where: { id: fixture.campaign.id }, data: {
      contentChannel: channel, minBodyLength: 21, minImageCount: 2,
      publicRequired: false, retentionDays: 0, clickableTopicRequired: input.global,
    } });
    await tx.topicRule.deleteMany({ where: { productId: fixture.product.id, campaignId: fixture.campaign.id } });
    await tx.topicRule.createMany({ data: (input.topics || ["#required"]).map((topic, index) => ({
      campaignId: fixture.campaign.id, productId: fixture.product.id, brandName: fixture.product.brandName,
      contentChannel: channel, scope: "CAMPAIGN", ruleType: input.ruleType || "REQUIRED", topic,
      clickableRequired: input.local, minCount: input.minCount || 1, sortOrder: index,
    })) });
  });
}

async function submit(request: APIRequestContext, fixture: Fixture, channel: TopicBoundaryChannel, patch: Partial<ExtractedNote>) {
  const contentId = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 15)}`).toString();
  const url = `https://www.douyin.com/note/${contentId}`;
  const task = await fixture.task(channel === "DOUYIN" ? { url, normalizedUrl: url, channel } : {});
  const note = boundaryNote(channel, patch);
  const extraction = auditIngestExtraction(task, {
    ...note, url: task.url, finalUrl: task.url,
    noteId: channel === "DOUYIN" ? contentId : new URL(task.url).pathname.split("/").at(-1),
    ...(channel === "DOUYIN" ? { contentId, verifiedPlatformTopics: [] } : { verifiedDouyinTopics: [] }),
    extractedAt: new Date().toISOString(),
  });
  const response = await request.post(`/api/tasks/${task.id}/audit`, { data: { extraction } });
  expect(response.status(), await response.text()).toBe(200);
  const result = (await response.json()).data;
  const detailResponse = await request.get(`/api/results/${result.id}`);
  expect(detailResponse.status()).toBe(200);
  return (await detailResponse.json()).data;
}

test.beforeEach(async ({ page }) => {
  const response = await page.request.post("/api/auth/login", { data: { username: "admin", password: "Admin123!" } });
  expect(response.status()).toBe(200);
});

test("EFFECTIVE_BODY_EXCLUDES_ALL_HASHTAGS：真实 API 跨平台 20/21 字边界与普通话题隔离", async ({ page }) => {
  test.setTimeout(90_000);
  const db = isolatedDatabase();
  try {
    for (const channel of topicBoundaryChannels) {
      const fixture = await createAuditIngestFixture(db);
      try {
        await configureRules(db, fixture, channel, { global: true, local: false });
        for (const length of [20, 21]) {
          const result = await submit(page.request, fixture, channel, {
            title: `正文边界 ${channel} ${length}`,
            body: `${"真".repeat(length)} #required#中文普通话题#abcdefghijklmnopqrstuvwxyz https://example.com/long-url\n，。！？`,
            textHashtagCandidates: [plainBoundaryTopic("#中文普通话题")],
            bodyTextHashtagCandidates: [plainBoundaryTopic("#abcdefghijklmnopqrstuvwxyz")],
          });
          expect(result).toMatchObject({ effectiveBodyLength: length, bodyCompliant: length === 21,
            autoStatus: length === 21 ? "PASSED" : "FAILED", topicsCompliant: true, evidenceStatus: "RESULT_BOUND" });
          expect(result.ruleResults.find((rule: { ruleKey: string }) => rule.ruleKey === "GLOBAL_BODY"))
            .toMatchObject({ passed: length === 21, actualValue: `${length} 个有效正文字符` });
          await page.goto(`/results/${result.id}`);
          await expect(page.getByText(`正文边界 ${channel} ${length}`, { exact: true })).toBeVisible();
          await expect(page.getByText(`有效正文：${length} 个字符`, { exact: true })).toBeVisible();
        }
        await configureRules(db, fixture, channel, { global: false, local: false, topics: ["#普通中文"] });
        const plain = plainBoundaryTopic("#普通中文");
        const plainResult = await submit(page.request, fixture, channel, { body: `${"真".repeat(21)} #普通中文`,
          topics: [plain], verifiedPlatformTopics: [], verifiedDouyinTopics: [], bodyTextHashtagCandidates: [plain],
        });
        expect(plainResult).toMatchObject({ effectiveBodyLength: 21, bodyCompliant: true, autoStatus: "FAILED", topicsCompliant: false });
        expect(JSON.parse(plainResult.missingTopics)).toEqual(["#普通中文"]);
      } finally {
        await fixture.cleanup();
      }
    }
  } finally {
    await db.$disconnect();
  }
});

test("ANY_TOPIC_RESPECTS_CAMPAIGN_CLICKABILITY：真实 API 的全局局部要求、minCount 与 UNKNOWN", async ({ page }) => {
  test.setTimeout(90_000);
  const db = isolatedDatabase();
  const cases: { global: boolean; local: boolean; states: TopicBoundaryClickability[]; minCount: number;
    expected: string; matched: number; pending: number }[] = [
    { global: true, local: false, states: ["NOT_CLICKABLE"], minCount: 1, expected: "FAILED", matched: 0, pending: 0 },
    { global: false, local: true, states: ["NOT_CLICKABLE"], minCount: 1, expected: "FAILED", matched: 0, pending: 0 },
    { global: false, local: false, states: ["NOT_CLICKABLE"], minCount: 1, expected: "PASSED", matched: 1, pending: 0 },
    { global: true, local: false, states: ["CLICKABLE", "NOT_CLICKABLE"], minCount: 2, expected: "FAILED", matched: 1, pending: 0 },
    { global: true, local: false, states: ["CLICKABLE", "UNKNOWN"], minCount: 2, expected: "NEEDS_REVIEW", matched: 1, pending: 1 },
    { global: true, local: false, states: ["UNKNOWN"], minCount: 1, expected: "NEEDS_REVIEW", matched: 0, pending: 1 },
    { global: true, local: false, states: ["CLICKABLE", "CLICKABLE", "NOT_CLICKABLE"], minCount: 2, expected: "PASSED", matched: 2, pending: 0 },
  ];
  try {
    for (const channel of topicBoundaryChannels) {
      const fixture = await createAuditIngestFixture(db);
      try {
        for (const scenario of cases) {
          await configureRules(db, fixture, channel, { ...scenario, ruleType: "ANY", topics: ["#A", "#B", "#C"] });
          const topics = scenario.states.map((state, index) => boundaryTopic(channel, `#${String.fromCharCode(65 + index)}`, state));
          const result = await submit(page.request, fixture, channel, { topics,
            ...(channel === "DOUYIN" ? { verifiedDouyinTopics: topics } : { verifiedPlatformTopics: topics }),
          });
          expect(result.autoStatus, `${channel} ${JSON.stringify(scenario)}`).toBe(scenario.expected);
          const group = result.ruleResults.find((rule: { ruleKey: string }) => rule.ruleKey === "TOPIC_ANY_GROUP");
          expect(group.passed).toBe(scenario.expected !== "FAILED");
          expect(JSON.parse(group.evidence)).toMatchObject({ matchedCount: scenario.matched,
            pendingCount: scenario.pending, minCount: scenario.minCount,
            clickabilityNeedsReview: scenario.expected === "NEEDS_REVIEW" });
          expect((await db.auditResult.findUniqueOrThrow({ where: { id: result.id } })).autoStatus).toBe(scenario.expected);
        }
      } finally {
        await fixture.cleanup();
      }
    }
  } finally {
    await db.$disconnect();
  }
});
