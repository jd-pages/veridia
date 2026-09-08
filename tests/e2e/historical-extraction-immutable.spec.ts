import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createAuditIngestFixture, auditIngestExtraction } from "../helpers/audit-ingest-fixture";

test("HISTORICAL_EXTRACTION_IMMUTABLE: 成功、失败和多次重审后历史证据不漂移", async ({ page }) => {
  test.setTimeout(90_000);
  const databaseUrl = process.env.E2E_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("必须通过 isolated E2E runner 提供 E2E_DATABASE_URL");
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  let fixture: Awaited<ReturnType<typeof createAuditIngestFixture>> | undefined;
  try {
    const login = await page.request.post("/api/auth/login", { data: { username: "admin", password: "Admin123!" } });
    expect(login.status()).toBe(200);
    fixture = await createAuditIngestFixture(db);
    await db.campaign.update({ where: { id: fixture.campaign.id }, data: { interactionRewardEnabled: true, interactionRewardThreshold: 10 } });
    const firstTask = await fixture.task();
    const firstResponse = await page.request.post(`/api/tasks/${firstTask.id}/audit`, { data: { extraction: auditIngestExtraction(firstTask, {
      title: "历史证据标题 A", body: "历史正文 A，这是足够长的合成正文，第一次审核完成后不能被新内容覆盖。",
      likeCount: 0, commentCount: 4, favoriteCount: 6, interactionExtractionStatus: "SUCCESS",
    }) } });
    expect(firstResponse.status(), await firstResponse.text()).toBe(200);
    const first = (await firstResponse.json()).data;
    expect(first.autoStatus).toBe("PASSED");
    const original = (await (await page.request.get(`/api/results/${first.id}`)).json()).data;
    let previousId = first.id;
    for (let index = 1; index <= 6; index += 1) {
      const task = await fixture.task({ url: firstTask.url, normalizedUrl: firstTask.url, replacesResultId: previousId });
      const failed = index === 1;
      const response = await page.request.post(`/api/tasks/${task.id}/audit`, { data: { extraction: auditIngestExtraction(task, {
        title: failed ? null : `后来标题 ${index}`, body: failed ? null : "新的正文内容已发生变化，仍然足够二十一字，但不允许影响过去的审核证据。",
        pageStatus: failed ? "READ_FAILED" : "NORMAL", publishedAt: failed ? null : "2026-08-02T00:00:00.000Z",
        topics: failed ? [] : auditIngestExtraction(task).topics,
        verifiedPlatformTopics: failed ? [] : auditIngestExtraction(task).verifiedPlatformTopics,
        isPublic: failed ? null : true, likeCount: index, commentCount: 0, favoriteCount: 0, interactionExtractionStatus: "SUCCESS",
      }) } });
      expect(response.status(), await response.text()).toBe(200);
      previousId = (await response.json()).data.id;
      const historical = (await (await page.request.get(`/api/results/${first.id}`)).json()).data;
      expect(historical.note).toEqual(original.note);
      expect(historical).toMatchObject({ isCurrent: false, evidenceStatus: "RESULT_BOUND", likeCount: 0,
        interactionTotal: 10, interactionRewardThreshold: 10, interactionRewardStatus: original.interactionRewardStatus });
    }
    expect(await db.extractionRecord.count({ where: { noteId: first.noteId } })).toBe(7);
    await page.goto(`/results/${first.id}`);
    await expect(page.getByText("历史证据标题 A", { exact: true })).toBeVisible();
    await expect(page.getByText("后来标题 6", { exact: true })).toHaveCount(0);

    // Simulate an upgraded legacy result: an available latest extraction is not a proven binding.
    await db.auditResult.update({ where: { id: first.id }, data: { extractionRecordId: null } });
    await page.reload();
    await expect(page.getByText("历史采集证据未能确认", { exact: true })).toBeVisible();
    await expect(page.getByText("历史证据标题 A", { exact: true })).toHaveCount(0);
    const legacy = (await (await page.request.get(`/api/results/${first.id}`)).json()).data;
    expect(legacy.note).toMatchObject({ title: null, body: null, publishedAt: null, topics: [], extractions: [] });
  } finally {
    try { await fixture?.cleanup(); } finally { await db.$disconnect(); }
  }
});
