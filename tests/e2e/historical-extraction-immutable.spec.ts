import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
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

test("Protected AUDIT_RESULT_PRESENTATION_IMMUTABLE：List、Detail 与 Export 使用同一历史事实", async ({ page }) => {
  test.setTimeout(60_000);
  const databaseUrl = process.env.E2E_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("必须通过 isolated E2E runner 提供 E2E_DATABASE_URL");
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  let fixture: Awaited<ReturnType<typeof createAuditIngestFixture>> | undefined;
  try {
    const login = await page.request.post("/api/auth/login", {
      data: { username: "admin", password: "Admin123!" },
    });
    expect(login.status()).toBe(200);
    fixture = await createAuditIngestFixture(db);
    const task = await fixture.task();
    const audit = await page.request.post(`/api/tasks/${task.id}/audit`, {
      data: { extraction: auditIngestExtraction(task) },
    });
    expect(audit.status(), await audit.text()).toBe(200);
    const result = (await audit.json()).data as { id: string; noteId: string };

    const listResponse = await page.request.get(
      `/api/results?ids=${result.id}&pageSize=100`,
    );
    expect(listResponse.status(), await listResponse.text()).toBe(200);
    const listItem = (await listResponse.json()).data.items.find(
      (item: { id: string }) => item.id === result.id,
    );
    const detailResponse = await page.request.get(`/api/results/${result.id}`);
    expect(detailResponse.status(), await detailResponse.text()).toBe(200);
    const detail = (await detailResponse.json()).data;
    expect(listItem.presentation).toEqual(detail.presentation);
    expect(detail.presentation).toMatchObject({
      consistency: { status: "CONSISTENT" },
      conclusion: { label: "审核通过" },
      topic: { status: "COMPLIANT", expectedCount: 1, matchedCount: 1 },
    });

    await db.$transaction([
      db.noteTopic.deleteMany({ where: { noteId: result.noteId } }),
      db.noteRecord.update({
        where: { id: result.noteId },
        data: { title: "后来标题", body: "后来正文" },
      }),
      db.topicRule.updateMany({
        where: { productId: fixture.product.id, campaignId: fixture.campaign.id },
        data: { topic: "#后来规则" },
      }),
    ]);
    const immutableDetail = (
      await (await page.request.get(`/api/results/${result.id}`)).json()
    ).data;
    expect(immutableDetail.presentation).toEqual(detail.presentation);

    const exportResponse = await page.request.get(
      `/api/results/export?ids=${result.id}`,
    );
    expect(exportResponse.status(), await exportResponse.text()).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await exportResponse.body()) as unknown as ExcelJS.Buffer,
    );
    const sheet = workbook.worksheets[0];
    const headers = sheet.getRow(1).values as string[];
    const selfReviewColumn = headers.findIndex((value) => value === "自审");
    expect(selfReviewColumn).toBeGreaterThan(0);
    expect(sheet.getRow(2).getCell(selfReviewColumn).text).toBe("Y");
  } finally {
    try {
      await fixture?.cleanup();
    } finally {
      await db.$disconnect();
    }
  }
});

test("Protected RETENTION_DOES_NOT_AFFECT_AUDIT_DECISION：List、Detail、Summary、Filter、Export 与后台调度一致", async ({ page }) => {
  test.setTimeout(90_000);
  const databaseUrl = process.env.E2E_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("必须通过 isolated E2E runner 提供 E2E_DATABASE_URL");
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  let fixture: Awaited<ReturnType<typeof createAuditIngestFixture>> | undefined;
  try {
    const login = await page.request.post("/api/auth/login", {
      data: { username: "admin", password: "Admin123!" },
    });
    expect(login.status()).toBe(200);
    fixture = await createAuditIngestFixture(db);
    await db.campaign.update({
      where: { id: fixture.campaign.id },
      data: { retentionDays: 15 },
    });
    const day = 24 * 60 * 60 * 1_000;
    const audit = async (
      patch: Parameters<typeof auditIngestExtraction>[1],
    ) => {
      const task = await fixture!.task();
      const response = await page.request.post(`/api/tasks/${task.id}/audit`, {
        data: {
          extraction: auditIngestExtraction(task, {
            publishedAtSource: "NETWORK_JSON:note.publish_time",
            ...patch,
          }),
        },
      });
      expect(response.status(), await response.text()).toBe(200);
      return { task, result: (await response.json()).data };
    };
    const passed = await audit({
      publishedAt: new Date(Date.now() - 16 * day).toISOString(),
      isPublic: true,
    });
    const failed = await audit({
      publishedAt: new Date(Date.now() - 14 * day).toISOString(),
      isPublic: true,
      imageCount: 1,
    });
    const review = await audit({
      publishedAt: new Date(Date.now() - 14 * day).toISOString(),
      isPublic: null,
    });
    const pending = await audit({
      publishedAt: new Date(Date.now() - 14 * day).toISOString(),
      isPublic: true,
    });
    expect(pending.result).toMatchObject({
      autoStatus: "PASSED",
      publicStatus: "PUBLIC",
      retentionStatus: "PENDING",
    });

    // Legacy 1.1.34 compatibility: keep stored facts unchanged and derive workflow state.
    await db.$transaction([
      db.auditResult.update({
        where: { id: pending.result.id },
        data: { autoStatus: "NEEDS_REVIEW" },
      }),
      db.auditTask.update({
        where: { id: pending.task.id },
        data: { status: "NEEDS_REVIEW" },
      }),
    ]);
    const ids = [passed, failed, review, pending]
      .map((item) => item.result.id)
      .join(",");
    const listResponse = await page.request.get(`/api/results?ids=${ids}&pageSize=100`);
    expect(listResponse.status(), await listResponse.text()).toBe(200);
    const list = (await listResponse.json()).data;
    expect(list.summary).toMatchObject({
      total: 4,
      passed: 2,
      failed: 1,
      review: 1,
    });
    const listPending = list.items.find(
      (item: { id: string }) => item.id === pending.result.id,
    );
    expect(listPending.presentation).toMatchObject({
      automaticConclusion: { status: "PASSED", label: "审核通过" },
      failureReasons: [],
      reviewReasons: [],
      isManualReviewRequired: false,
      isPendingRetention: false,
      publicDisplay: { label: "当前公开" },
      retentionDisplay: { status: "PENDING", label: "仅作活动信息", requirementDays: 15, dueAt: null },
    });

    const pendingFilter = (await (
      await page.request.get(`/api/results?ids=${ids}&status=PENDING_RETENTION&pageSize=100`)
    ).json()).data;
    const reviewFilter = (await (
      await page.request.get(`/api/results?ids=${ids}&status=NEEDS_REVIEW&pageSize=100`)
    ).json()).data;
    const passFilter = (await (
      await page.request.get(`/api/results?ids=${ids}&status=PASSED&pageSize=100`)
    ).json()).data;
    const manualFilter = (await (
      await page.request.get(`/api/results?ids=${ids}&manualStatus=PENDING&pageSize=100`)
    ).json()).data;
    expect(pendingFilter.items).toEqual([]);
    expect(reviewFilter.items.map((item: { id: string }) => item.id))
      .toEqual([review.result.id]);
    expect(manualFilter.items.map((item: { id: string }) => item.id))
      .toEqual([review.result.id]);
    expect(new Set(passFilter.items.map((item: { id: string }) => item.id)))
      .toEqual(new Set([passed.result.id, pending.result.id]));

    const p95ByPageSize: Record<string, number> = {};
    for (const pageSize of [20, 100]) {
      await page.request.get(`/api/results?page=1&pageSize=${pageSize}`);
      const timings: number[] = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const startedAt = performance.now();
        const response = await page.request.get(`/api/results?page=1&pageSize=${pageSize}`);
        expect(response.status()).toBe(200);
        timings.push(performance.now() - startedAt);
      }
      timings.sort((left, right) => left - right);
      const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
      p95ByPageSize[String(pageSize)] = Math.round(p95 * 100) / 100;
      expect(p95).toBeLessThanOrEqual(500);
    }
    console.log(`RETENTION_RESULTS_PERFORMANCE=${JSON.stringify(p95ByPageSize)}`);

    const detailResponse = await page.request.get(`/api/results/${pending.result.id}`);
    expect(detailResponse.status(), await detailResponse.text()).toBe(200);
    const detail = (await detailResponse.json()).data;
    expect(detail.presentation).toEqual(listPending.presentation);
    const storedBefore = await db.auditResult.findUniqueOrThrow({
      where: { id: pending.result.id },
      select: { autoStatus: true, failureReasons: true, retentionStatus: true },
    });
    expect(storedBefore).toEqual({
      autoStatus: "NEEDS_REVIEW",
      failureReasons: "[]",
      retentionStatus: "PENDING",
    });

    await page.goto(`/results?status=PASSED&startDate=2020-01-01&endDate=2099-12-31`);
    const pendingRow = page.locator(`.ant-table-row[data-row-key="${pending.result.id}"]`);
    await expect(pendingRow.getByText("审核通过", { exact: true })).toBeVisible();
    await expect(pendingRow).not.toContainText("待留存验证");
    await page.goto(`/results/${pending.result.id}`);
    await expect(page.getByRole("heading", { name: "审核详情" })).toBeVisible();
    await expect(page.getByText("审核通过", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("region", { name: "失败原因" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "待验证事项" })).toHaveCount(0);
    await expect(page.getByText("当前公开", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("留存到期", { exact: true })).toHaveCount(0);
    await expect(page.getByText("公开留存", { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: ".playwright/v1.1.36-retention-result-after.png",
      fullPage: true,
    });

    const exported = await page.request.get(`/api/results/export?ids=${pending.result.id}`);
    expect(exported.status(), await exported.text()).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await exported.body()) as unknown as ExcelJS.Buffer);
    const sheet = workbook.worksheets[0];
    const headers = sheet.getRow(1).values as string[];
    const selfReviewColumn = headers.findIndex((value) => value === "自审");
    expect(sheet.getRow(2).getCell(selfReviewColumn).text).toBe("Y");

    // Moving the informational due time past now and hitting Desktop Health must
    // not create a task, batch or replacement result.
    await db.auditResult.update({
      where: { id: pending.result.id },
      data: { retentionDueAt: new Date(Date.now() - 1) },
    });
    const retentionBatchCount = await db.auditBatch.count({ where: { source: "RETENTION_RECHECK" } });
    const resultCount = await db.auditResult.count();
    const health = await page.request.get("/api/health");
    expect(health.status()).toBe(200);
    await page.waitForTimeout(250);
    expect(await db.auditTask.count({
      where: { replacesResultId: pending.result.id },
    })).toBe(0);
    expect(await db.auditBatch.count({ where: { source: "RETENTION_RECHECK" } }))
      .toBe(retentionBatchCount);
    expect(await db.auditResult.count()).toBe(resultCount);
    expect(await db.auditResult.findUniqueOrThrow({
      where: { id: pending.result.id },
      select: { autoStatus: true, supersededAt: true },
    })).toEqual({ autoStatus: "NEEDS_REVIEW", supersededAt: null });
  } finally {
    try {
      await fixture?.cleanup();
    } finally {
      await db.$disconnect();
    }
  }
});
