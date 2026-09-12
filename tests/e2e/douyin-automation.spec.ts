import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { E2E_ORIGIN } from "./e2e-origin";
import { playwrightDouyinAdapter } from "../../lib/automation/douyin-adapter";
import { readDouyinCurrentContentEvidence } from "../../lib/automation/douyin-current-content-evidence";
import { DEFAULT_AUTOMATION_EXTRACTION_DEADLINE_MS } from "../../lib/automation/extraction-deadline";
import { DEFAULT_BROWSER_LIFECYCLE_CLEANUP_DEADLINE_MS } from "../../lib/automation/generation-lifecycle";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("Admin123!");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard/u);
}

type AutomationBatchTaskSnapshot = {
  id: string;
  status: string;
  claimEpoch: number | null;
  attempts: number;
  auditResults?: unknown[];
};

type AutomationBatchSnapshot = {
  id: string;
  status: string;
  runEpoch: number;
  currentTaskId: string | null;
  tasks: AutomationBatchTaskSnapshot[];
};

const AUTOMATION_STATE_PERSISTENCE_MARGIN_MS = 15_000;
const AUTOMATION_BATCH_STALL_DEADLINE_MS =
  DEFAULT_AUTOMATION_EXTRACTION_DEADLINE_MS +
  DEFAULT_BROWSER_LIFECYCLE_CLEANUP_DEADLINE_MS +
  AUTOMATION_STATE_PERSISTENCE_MARGIN_MS;
const AUTOMATION_BATCH_HARD_DEADLINE_MS =
  AUTOMATION_BATCH_STALL_DEADLINE_MS + 30_000;

function automationBatchDiagnostic(batch: AutomationBatchSnapshot) {
  const counts = batch.tasks.reduce<Record<string, number>>((summary, task) => {
    summary[task.status] = (summary[task.status] ?? 0) + 1;
    return summary;
  }, {});
  const currentTask = batch.tasks.find((task) => task.id === batch.currentTaskId);
  return {
    batchId: batch.id,
    status: batch.status,
    currentTaskId: batch.currentTaskId,
    PENDING: counts.PENDING ?? 0,
    PROCESSING: counts.PROCESSING ?? 0,
    COMPLETED: counts.COMPLETED ?? 0,
    FAILED: counts.FAILED ?? 0,
    READ_FAILED: counts.READ_FAILED ?? 0,
    runEpoch: batch.runEpoch,
    claimEpoch: currentTask?.claimEpoch ?? null,
  };
}

function automationBatchProgressSignature(batch: AutomationBatchSnapshot) {
  return JSON.stringify({
    status: batch.status,
    runEpoch: batch.runEpoch,
    currentTaskId: batch.currentTaskId,
    tasks: batch.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      claimEpoch: task.claimEpoch,
      attempts: task.attempts,
      resultCount: task.auditResults?.length ?? 0,
    })),
  });
}

async function waitForTerminalBatch(page: Page, batchId: string) {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastSignature = "";
  let latest: AutomationBatchSnapshot | undefined;
  while (Date.now() - startedAt < AUTOMATION_BATCH_HARD_DEADLINE_MS) {
    const response = await page.request.get(
      `/api/automation/batches?batchId=${batchId}`,
    );
    if (!response.ok()) {
      throw new Error(`读取自动审核批次失败：${batchId} HTTP ${response.status()}`);
    }
    const payload = await response.json();
    latest = payload.data[0] as AutomationBatchSnapshot | undefined;
    if (!latest) throw new Error(`自动审核批次不存在：${batchId}`);
    if (/^(?:COMPLETED|COMPLETED_WITH_ERRORS)$/u.test(latest.status)) {
      return latest;
    }
    const signature = automationBatchProgressSignature(latest);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= AUTOMATION_BATCH_STALL_DEADLINE_MS) {
      throw new Error(
        `自动审核批次长时间无状态进展：${JSON.stringify(automationBatchDiagnostic(latest))}`,
      );
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `自动审核批次超过绝对截止时间：${JSON.stringify(latest ? automationBatchDiagnostic(latest) : { batchId })}`,
  );
}

async function cleanupOwnedAutomationBatches(
  page: Page,
  batchIds: readonly string[],
) {
  for (const batchId of [...new Set(batchIds)].reverse()) {
    const response = await page.request.get(
      `/api/automation/batches?batchId=${batchId}`,
    );
    if (!response.ok()) throw new Error(`清理前读取自动审核批次失败：${batchId}`);
    const batch = (await response.json()).data[0] as AutomationBatchSnapshot | undefined;
    if (!batch) continue;
    if (![
      "COMPLETED",
      "COMPLETED_WITH_ERRORS",
      "CANCELLED",
      "CLEARED",
    ].includes(batch.status)) {
      const cancelResponse = await page.request.post(
        `/api/automation/batches/${batchId}/control`,
        { data: { action: "CANCEL" } },
      );
      if (!cancelResponse.ok()) {
        throw new Error(
          `取消测试自有自动审核批次失败：${JSON.stringify(automationBatchDiagnostic(batch))}`,
        );
      }
    }
    const clearResponse = await page.request.post(
      `/api/automation/batches/${batchId}/clear`,
    );
    if (!clearResponse.ok()) throw new Error(`清除测试自有自动审核批次失败：${batchId}`);
  }
}

async function getDouyinAutomationFixture(
  page: Page,
  options: { brandName?: string } = {},
) {
  const response = await page.request.get(
    "/api/campaigns?contentChannel=DOUYIN",
  );
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  const campaigns = payload.data as Array<{
    id: string;
    product: { id: string; brandName: string } | null;
    products: Array<{ product: { id: string; brandName: string } }>;
  }>;
  const fixture = campaigns
    .flatMap((campaign) => [
      ...(campaign.product ? [campaign.product] : []),
      ...campaign.products.map(({ product }) => product),
    ].map((product) => ({
      campaignId: campaign.id,
      productId: product.id,
      brandName: product.brandName,
    })))
    .find(({ brandName }) =>
      options.brandName ? brandName === options.brandName : true,
    );
  expect(
    fixture,
    options.brandName
      ? `未找到 ${options.brandName} 的有效抖音产品与活动关联`
      : "未找到有效的抖音产品与活动关联",
  ).toBeTruthy();
  return fixture!;
}

async function createDouyinBatchForUrl(page: Page, url: string) {
  const { productId, campaignId } = await getDouyinAutomationFixture(page);
  const response = await page.request.post("/api/automation/batches", {
    data: {
      contentChannel: "DOUYIN",
      productId,
      campaignId,
      productStage: "IFFO_P1",
      urls: [url],
    },
  });
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  return payload.data.batchId as string;
}

test("Protected DOUYIN_VISIBLE_CONTENT_ID_SCOPE：隐藏旧详情与同 ID clone 不覆盖当前正文和三张图片", async ({ page }) => {
  const url = "https://www.douyin.com/note/222";
  const fixture = fs.readFileSync(path.resolve("tests/regression/fixtures/douyin/visible-content-id-scope.html"), "utf8");
  await page.route("https://www.douyin.com/**", (route) => route.fulfill({
    status: 200, contentType: "text/html; charset=utf-8", body: fixture,
  }));
  await page.goto(url);
  expect(await readDouyinCurrentContentEvidence(page, "222")).toMatchObject({
    scopeContentId: "222", hasContentEvidence: true, contentIdMatches: true,
  });
  const note = await playwrightDouyinAdapter.extract(page, url, { contentId: "222" });
  expect(note).toMatchObject({
    noteId: "222", pageStatus: "NORMAL", title: "当前作品标题",
    body: "当前作品的真实正文必须与当前图片发布时间和互动保持一致。#当前话题",
    imageCount: 3, imageExtractionStatus: "SUCCESS",
    publishedAt: "2026-08-07T08:20:51.000Z",
    likeCount: 8, commentCount: 4, favoriteCount: 10,
  });
  expect(note.pageEvidence).toMatchObject({ domImageCount: 3, domCarouselTotal: 3, structuredImageCount: 3 });
  expect(note.body).not.toMatch(/旧|克隆/u);

  // The current document can disappear between readiness and extraction.
  await page.evaluate(() => {
    document.body.innerHTML = '<section data-testid="douyin-note-detail" data-content-id="111"><p data-testid="douyin-description">上一作品仍可见</p></section>';
  });
  expect(await readDouyinCurrentContentEvidence(page, "222")).toMatchObject({
    hasContentEvidence: false, contentIdMatches: false,
  });
  expect(await playwrightDouyinAdapter.extract(page, url, { contentId: "222" })).toMatchObject({
    pageStatus: "READ_FAILED", body: null, imageCount: 0,
  });
});

test("审核任务页提供相互隔离的小红书与抖音环境入口", async ({ page }) => {
  await login(page);
  await page.goto("/mock/douyin?case=topics");
  await expect(page.locator("a[data-douyin-topic]")).toHaveCount(2);
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "内容平台专用浏览器" })).toBeVisible();
  await expect(page.getByTestId("automation-session-browser-title")).toHaveText(
    "小红书专用浏览器",
  );
  await expect(async () => {
    await page.getByRole("tab", { name: "抖音" }).click();
    await expect(
      page.getByTestId("automation-session-browser-title"),
    ).toHaveText("抖音专用浏览器", { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "登录抖音" })).toBeVisible();
  await expect(page.getByRole("button", { name: "登录小红书" })).toHaveCount(0);
  await page.getByRole("tab", { name: "小红书" }).click();
  await expect(page.getByRole("button", { name: "登录小红书" })).toBeVisible();

  const xhs = (await (
    await page.request.get("/api/automation/session?platform=XIAOHONGSHU")
  ).json()).data;
  const douyin = (await (
    await page.request.get("/api/automation/session?platform=DOUYIN")
  ).json()).data;
  expect(xhs.platform).toBe("XIAOHONGSHU");
  expect(douyin.platform).toBe("DOUYIN");
  expect(xhs.profilePath).not.toBe(douyin.profilePath);
});

test("未登录但公开可访问的抖音作品保持 NORMAL 并继续提取", async ({ page }) => {
  await login(page);
  const batchId = await createDouyinBatchForUrl(
    page,
    `${E2E_ORIGIN}/mock/douyin?case=public-logged-out&dy=${Date.now()}`,
  );
  await waitForTerminalBatch(page, batchId);
  const batch = (await (
    await page.request.get(`/api/automation/batches?batchId=${batchId}`)
  ).json()).data[0];
  expect(batch.channel).toBe("DOUYIN");
  expect(batch.tasks[0].failureCode || "").not.toMatch(
    /LOGIN|PAGE_OPEN_FAILED|NETWORK_ERROR/u,
  );
  const result = (await (
    await page.request.get(`/api/results?batchId=${batchId}&pageSize=10`)
  ).json()).data.items[0];
  expect(result).toMatchObject({
    pageStatus: "NORMAL",
    publicStatus: "NOT_REQUIRED",
  });
  expect(result.effectiveBodyLength).toBeGreaterThan(0);
  expect(
    (await page.request.post(`/api/automation/batches/${batchId}/clear`)).ok(),
  ).toBeTruthy();
});

test("Protected DOUYIN_PUBLIC_IMAGE_TEXT_DETAIL：公开图文未登录仍为 NORMAL", async ({ page }) => {
  await login(page);
  const batchId = await createDouyinBatchForUrl(
    page,
    `${E2E_ORIGIN}/mock/douyin?case=public-image-text-detail&raw=true&dy=${Date.now()}`,
  );
  await waitForTerminalBatch(page, batchId);
  const batch = (await (
    await page.request.get(`/api/automation/batches?batchId=${batchId}`)
  ).json()).data[0];
  expect(batch.tasks[0].failureCode || "").not.toMatch(
    /STRUCTURE_MISMATCH|LOGIN_REQUIRED/u,
  );
  const result = (await (
    await page.request.get(`/api/results?batchId=${batchId}&pageSize=10`)
  ).json()).data.items[0];
  expect(result).toMatchObject({
    pageStatus: "NORMAL",
    noteType: "IMAGE_TEXT",
    imageCount: 2,
    publicStatus: "NOT_REQUIRED",
  });
  expect(
    (await page.request.post(`/api/automation/batches/${batchId}/clear`)).ok(),
  ).toBeTruthy();
});

test("Protected DOUYIN_PUBLIC_IMAGE_TEXT_CONTENT_ACCURACY：十个媒体节点仍为三张且正文完整", async ({ page }) => {
  await login(page);
  const batchId = await createDouyinBatchForUrl(
    page,
    `${E2E_ORIGIN}/mock/douyin?case=public-image-text-accuracy&raw=true&dy=${Date.now()}`,
  );
  await waitForTerminalBatch(page, batchId);
  const batch = (await (
    await page.request.get(`/api/automation/batches?batchId=${batchId}`)
  ).json()).data[0];
  expect(batch.tasks[0].failureCode || "").not.toMatch(
    /STRUCTURE_MISMATCH|BODY_NOT_RECOGNIZED|LOGIN_REQUIRED/u,
  );
  const result = (await (
    await page.request.get(`/api/results?batchId=${batchId}&pageSize=10`)
  ).json()).data.items[0];
  expect(result).toMatchObject({
    pageStatus: "NORMAL",
    noteType: "IMAGE_TEXT",
    imageCount: 3,
    publicStatus: "NOT_REQUIRED",
  });
  expect(result.effectiveBodyLength).toBeGreaterThan(0);
  expect(
    (await page.request.post(`/api/automation/batches/${batchId}/clear`)).ok(),
  ).toBeTruthy();
});

test("page.goto 超时但抖音作品 DOM 已出现时继续提取", async ({ page }) => {
  await login(page);
  const batchId = await createDouyinBatchForUrl(
    page,
    `${E2E_ORIGIN}/mock/douyin/stream-timeout?dy=${Date.now()}`,
  );
  await waitForTerminalBatch(page, batchId);
  const batch = (await (
    await page.request.get(`/api/automation/batches?batchId=${batchId}`)
  ).json()).data[0];
  expect(batch.tasks[0].failureCode || "").not.toMatch(
    /LOAD_TIMEOUT|PAGE_OPEN_FAILED|NETWORK_ERROR/u,
  );
  const result = (await (
    await page.request.get(`/api/results?batchId=${batchId}&pageSize=10`)
  ).json()).data.items[0];
  expect(result).toMatchObject({
    pageStatus: "NORMAL",
    noteType: "IMAGE_TEXT",
    imageCount: 2,
    publicStatus: "NOT_REQUIRED",
  });
  expect(
    (await page.request.post(`/api/automation/batches/${batchId}/clear`)).ok(),
  ).toBeTruthy();
});

test("规则与活动管理按内容渠道展示独立抖音副本", async ({ page }) => {
  await login(page);
  const xhsCampaigns = (await (
    await page.request.get("/api/campaigns?contentChannel=XIAOHONGSHU")
  ).json()).data as Array<{ id: string; name: string; contentChannel: string }>;
  const douyinCampaigns = (await (
    await page.request.get("/api/campaigns?contentChannel=DOUYIN")
  ).json()).data as Array<{
    id: string;
    name: string;
    contentChannel: string;
    publicRequired: boolean;
  }>;
  expect(xhsCampaigns).toHaveLength(3);
  expect(douyinCampaigns).toHaveLength(3);
  expect(xhsCampaigns.every((item) => item.contentChannel === "XIAOHONGSHU"))
    .toBe(true);
  expect(douyinCampaigns.every((item) => item.contentChannel === "DOUYIN"))
    .toBe(true);
  expect(douyinCampaigns.every((item) => item.name.includes("抖音"))).toBe(true);
  expect(douyinCampaigns.every((item) => item.publicRequired === false)).toBe(true);
  const augustDouyinCampaign = douyinCampaigns.find((item) =>
    item.name.includes("2026年8月"),
  );
  const augustXhsCampaign = xhsCampaigns.find((item) =>
    item.name.includes("2026年8月"),
  );
  expect(augustDouyinCampaign).toBeTruthy();
  expect(augustXhsCampaign).toBeTruthy();

  const douyinRules = (await (
    await page.request.get("/api/rules?contentChannel=DOUYIN")
  ).json()).data as Array<{
    id: string;
    topic: string;
    contentChannel: string;
    brandName: string | null;
    topicCategory: string;
  }>;
  expect(douyinRules).toHaveLength(20);
  expect(douyinRules.every((item) => item.contentChannel === "DOUYIN")).toBe(
    true,
  );
  expect(douyinRules.map((item) => item.topic)).not.toContain(
    "#爱他美新手爸妈日记",
  );
  expect(douyinRules.filter(
    (item) => item.brandName === "佳贝艾特" && item.topicCategory === "PRODUCT_STAGE",
  )).toHaveLength(0);

  await page.goto("/rules?channel=DOUYIN");
  await expect(page.locator(".ant-segmented-item-selected")).toContainText("抖音");
  const danoneCard = page.locator(".rule-brand-card").filter({
    has: page.getByText("达能", { exact: true }),
  });
  await danoneCard.getByRole("button", { name: "进入规则" }).click();
  await expect(page).toHaveURL(/channel=DOUYIN/u);
  await expect(page.getByText("#爱他美新手爸妈日记")).toHaveCount(0);

  await page.goto("/campaigns");
  await expect(async () => {
    await page.locator(".ant-segmented-item").filter({ hasText: "抖音" }).click();
    await expect(
      page.getByText(augustDouyinCampaign!.name, { exact: true }),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(
    page.getByText(augustXhsCampaign!.name, { exact: true }),
  ).toHaveCount(0);

  const removedAgencyTemplateResponse = await page.request.get(
    "/api/import/template?brand=danone-agency",
  );
  expect(removedAgencyTemplateResponse.status()).toBe(404);
  const templateResponse = await page.request.get(
    "/api/import/template?brand=danone-customer",
  );
  expect(templateResponse.ok()).toBeTruthy();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    (await templateResponse.body()) as unknown as ExcelJS.Buffer,
  );
  const activitySheet = workbook.getWorksheet("活动列表")!;
  const activityRows = activitySheet.getRows(2, activitySheet.rowCount - 1) || [];
  expect(activityRows.map((row) => row.getCell(1).text)).toEqual(
    expect.arrayContaining(douyinCampaigns.map((item) => item.name)),
  );
  expect(
    activityRows
      .filter((row) => row.getCell(1).text.includes("抖音"))
      .every((row) => row.getCell(2).text === "抖音"),
  ).toBe(true);
  const importSheet = workbook.getWorksheet("达能客户导入")!;
  expect(importSheet.rowCount).toBe(2);
  expect(
    (importSheet as unknown as {
      dataValidations: { find(address: string): ExcelJS.DataValidation | undefined };
    }).dataValidations.find("H10000"),
  ).toMatchObject({ type: "list", formulae: ['"小红书,抖音"'] });
  expect(importSheet.rowCount).toBe(2);
});

test("混合 Excel 只创建一个导入记录并拆分为两个串行平台批次", async ({ page }) => {
  test.setTimeout(AUTOMATION_BATCH_HARD_DEADLINE_MS * 2 + 60_000);
  await login(page);
  const campaigns = (await (
    await page.request.get("/api/campaigns")
  ).json()).data as Array<{
    id: string;
    name: string;
    month: string;
    contentChannel: string;
  }>;
  const xhsCampaign = campaigns.find(
    (item) => item.month === "2026-07" && item.contentChannel === "XIAOHONGSHU",
  )!;
  const douyinCampaign = campaigns.find(
    (item) => item.month === "2026-07" && item.contentChannel === "DOUYIN",
  )!;
  expect(xhsCampaign).toBeTruthy();
  expect(douyinCampaign).toBeTruthy();
  const suffix = Date.now();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("达能代发导入");
  sheet.addRow([
    "平台（必填）", "店铺名称（必填）", "客户名（必填）",
    "产品系列（必填）", "阶段（必填）", "订单编号（必填）",
    "内容渠道（必填）", "链接（必填）", "发布时间（必填）",
    "活动名称（必填）",
  ]);
  for (let index = 0; index < 10; index += 1) {
    const xhs = index < 6;
    sheet.addRow([
      "抖音电商",
      "ROCKCHECK海外专营店",
      `混合导入-${index + 1}`,
      "澳白2",
      "IFFO",
      `MIXED-${suffix}-${index + 1}`,
      xhs ? "小红书" : "抖音",
      xhs
        ? `${E2E_ORIGIN}/mock/xhs?case=aptamil-stage2-rockcheck-store-passed&mixed=${suffix}-${index}`
        : `${E2E_ORIGIN}/mock/douyin?case=video&mixed=${suffix}-${index}`,
      "2026-07-26",
      xhs ? xhsCampaign.name : douyinCampaign.name,
    ]);
  }
  const metadata = workbook.addWorksheet("VERIDIA模板信息", {
    state: "veryHidden",
  });
  metadata.getCell("B1").value = "DANONE_AGENCY";
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  sheet.getCell("J8").value = xhsCampaign.name;
  const douyinWithXhsCampaign = Buffer.from(await workbook.xlsx.writeBuffer());
  sheet.getCell("J8").value = douyinCampaign.name;
  sheet.getCell("J2").value = douyinCampaign.name;
  const xhsWithDouyinCampaign = Buffer.from(await workbook.xlsx.writeBuffer());
  sheet.getCell("J2").value = xhsCampaign.name;

  for (const [name, invalidBuffer] of [
    ["douyin-xhs-campaign", douyinWithXhsCampaign],
    ["xhs-douyin-campaign", xhsWithDouyinCampaign],
  ] as const) {
    const mismatchResponse = await page.request.post("/api/import/notes", {
      multipart: {
        file: {
          name: `${name}-${suffix}.xlsx`,
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: invalidBuffer,
        },
        commit: "false",
      },
    });
    const mismatch = (await mismatchResponse.json()).data;
    expect(mismatchResponse.ok()).toBeTruthy();
    expect(mismatch.invalidCount).toBe(1);
    expect(JSON.stringify(mismatch.errorRows)).toContain(
      "内容渠道与活动渠道不一致",
    );
  }

  const previewResponse = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: `mixed-platform-${suffix}.xlsx`,
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer,
      },
      commit: "false",
    },
  });
  const preview = (await previewResponse.json()).data;
  expect(previewResponse.ok()).toBeTruthy();
  expect(preview).toMatchObject({
    validCount: 10,
    invalidCount: 0,
    plannedBatchCount: 2,
    channelDistribution: { XIAOHONGSHU: 6, DOUYIN: 4 },
  });

  const commitResponse = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: `mixed-platform-${suffix}.xlsx`,
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer,
      },
      commit: "true",
    },
  });
  const commitPayload = await commitResponse.json();
  const ownedBatchIds = Array.isArray(commitPayload?.data?.batchIds)
    ? (commitPayload.data.batchIds as string[])
    : [];
  try {
    const committed = commitPayload.data as {
      importRecordId: string;
      batchIds: string[];
    };
    expect(commitResponse.ok()).toBeTruthy();
    expect(committed.batchIds).toHaveLength(2);

  const importRecordResponse = await page.request.get(
    `/api/results/import-batches?q=${encodeURIComponent(`mixed-platform-${suffix}`)}`,
  );
  const importRecords = (await importRecordResponse.json()).data as Array<{
    id: string;
    batchCount: number;
    taskCount: number;
    channelDistribution: Record<string, number>;
  }>;
  expect(importRecords).toHaveLength(1);
  expect(importRecords[0]).toMatchObject({
    id: committed.importRecordId,
    batchCount: 2,
    taskCount: 10,
    channelDistribution: { XIAOHONGSHU: 6, DOUYIN: 4 },
  });

  const initialBatches = (await (
    await page.request.get(
      `/api/automation/batches?batchIds=${committed.batchIds.join(",")}`,
    )
  ).json()).data as Array<{
    id: string;
    channel: string;
    status: string;
    importRecordId: string;
    tasks: Array<{
      channel: string;
      commercePlatform: string;
      importRecordId: string;
    }>;
  }>;
  expect(initialBatches.map((batch) => batch.channel).sort()).toEqual([
    "DOUYIN",
    "XIAOHONGSHU",
  ]);
  expect(
    initialBatches.every(
      (batch) =>
        batch.importRecordId === committed.importRecordId &&
        batch.tasks.every(
          (task) =>
            task.channel === batch.channel &&
            task.commercePlatform === "DOUYIN_ECOMMERCE" &&
            task.importRecordId === committed.importRecordId,
        ),
    ),
  ).toBe(true);

  for (let sample = 0; sample < 5; sample += 1) {
    const processing = (await (
      await page.request.get("/api/tasks?executionStatus=PROCESSING&pageSize=100")
    ).json()).data as { total: number };
    expect(processing.total).toBeLessThanOrEqual(1);
    await page.waitForTimeout(100);
  }
  await waitForTerminalBatch(page, committed.batchIds[0]);
  await waitForTerminalBatch(page, committed.batchIds[1]);

  const resultsResponse = await page.request.get(
    `/api/results?importRecordId=${committed.importRecordId}&pageSize=100`,
  );
  const allResults = (await resultsResponse.json()).data;
  expect(allResults.total).toBe(10);
  const xhsResults = await (
    await page.request.get(
      `/api/results?importRecordId=${committed.importRecordId}&channel=XIAOHONGSHU&pageSize=100`,
    )
  ).json();
  const douyinResults = await (
    await page.request.get(
      `/api/results?importRecordId=${committed.importRecordId}&channel=DOUYIN&pageSize=100`,
    )
  ).json();
  expect(xhsResults.data.total).toBe(6);
  expect(douyinResults.data.total).toBe(4);

  const exportResponse = await page.request.get(
    `/api/results/export?format=xlsx&importRecordId=${committed.importRecordId}`,
  );
  expect(exportResponse.ok()).toBeTruthy();
  const exported = new ExcelJS.Workbook();
  await exported.xlsx.load(
    (await exportResponse.body()) as unknown as ExcelJS.Buffer,
  );
  expect(exported.worksheets[0].actualRowCount - 1).toBe(10);

  } finally {
    await cleanupOwnedAutomationBatches(page, ownedBatchIds);
  }
});

test("抖音复用店铺映射但仅审核 ACCEPTED，小红书继续审核 REQUIRED", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  const products = (await (
    await page.request.get("/api/products")
  ).json()).data as Array<{ id: string; name: string; brandName: string }>;
  const product = products.find((item) => item.name === "爱他美澳洲白金版")!;
  expect(product).toBeTruthy();
  const campaigns = (await (
    await page.request.get(`/api/campaigns?productId=${product.id}`)
  ).json()).data as Array<{
    id: string;
    name: string;
    month: string;
    contentChannel: string;
  }>;
  const xhsCampaign = campaigns.find(
    (item) =>
      item.month === "2026-07" && item.contentChannel === "XIAOHONGSHU",
  )!;
  const douyinCampaign = campaigns.find(
    (item) => item.month === "2026-07" && item.contentChannel === "DOUYIN",
  )!;
  expect(xhsCampaign).toBeTruthy();
  expect(douyinCampaign).toBeTruthy();

  const suffix = Date.now();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("达能代发导入");
  sheet.addRow([
    "平台（必填）",
    "店铺名称（必填）",
    "客户名（必填）",
    "产品系列（必填）",
    "阶段（必填）",
    "订单编号（必填）",
    "内容渠道（必填）",
    "链接（必填）",
    "发布时间（必填）",
    "活动名称（必填）",
  ]);
  const douyinUrl = (caseId: string, topicText: string) =>
    `${E2E_ORIGIN}/mock/douyin?case=video&topic=${encodeURIComponent(topicText)}&store-policy=${suffix}-${caseId}`;
  const rows = [
    {
      platform: "京东",
      storeName: "FOLO海外官方旗舰店",
      orderNumber: `DY-JD-ACCEPTED-${suffix}`,
      channel: "抖音",
      url: douyinUrl("jd-accepted", "FOLO海外官方旗舰店"),
      campaignName: douyinCampaign.name,
    },
    {
      platform: "京东",
      storeName: "FOLO海外官方旗舰店",
      orderNumber: `DY-JD-PLATFORM-${suffix}`,
      channel: "抖音",
      url: douyinUrl("jd-platform", "京东"),
      campaignName: douyinCampaign.name,
    },
    {
      platform: "天猫",
      storeName: "FOLO海外专营店",
      orderNumber: `DY-TMALL-ACCEPTED-${suffix}`,
      channel: "抖音",
      url: douyinUrl("tmall-accepted", "FOLO海外专营店"),
      campaignName: douyinCampaign.name,
    },
    {
      platform: "淘宝",
      storeName: "ALG阿莱购",
      orderNumber: `DY-TAOBAO-ACCEPTED-${suffix}`,
      channel: "抖音",
      url: douyinUrl("taobao-accepted", "ALG阿莱购"),
      campaignName: douyinCampaign.name,
    },
    {
      platform: "天猫",
      storeName: "FOLO海外专营店",
      orderNumber: `XHS-TMALL-MISSING-${suffix}`,
      channel: "小红书",
      url: `${E2E_ORIGIN}/mock/xhs?case=aptamil-stage2-folo-store-passed&store-policy=${suffix}`,
      campaignName: xhsCampaign.name,
    },
  ];
  for (const [index, row] of rows.entries()) {
    sheet.addRow([
      row.platform,
      row.storeName,
      `渠道店铺策略-${index + 1}`,
      "澳白2",
      "IFFO",
      row.orderNumber,
      row.channel,
      row.url,
      "2026-07-26 12:00:00",
      row.campaignName,
    ]);
  }
  const metadata = workbook.addWorksheet("VERIDIA模板信息", {
    state: "veryHidden",
  });
  metadata.getCell("B1").value = "DANONE_AGENCY";

  const response = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: `store-topic-channel-policy-${suffix}.xlsx`,
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      },
      commit: "true",
      skipDuplicates: "true",
    },
  });
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  expect(payload.data).toMatchObject({
    validCount: 5,
    invalidCount: 0,
    plannedBatchCount: 2,
  });
  expect(payload.data.batchIds).toHaveLength(2);
  for (const batchId of payload.data.batchIds as string[]) {
    await waitForTerminalBatch(page, batchId);
  }

  const resultPayload = await (
    await page.request.get(
      `/api/results?importRecordId=${payload.data.importRecordId}&pageSize=100`,
    )
  ).json();
  const results = resultPayload.data.items as Array<{
    storeTopicStatus: string;
    requiredStoreTopics: string;
    matchedRequiredStoreTopics: string;
    storeTopicFailureReason: string | null;
    task: { orderNumber: string; channel: string };
  }>;
  expect(results).toHaveLength(5);
  const byOrder = new Map(
    results.map((item) => [item.task.orderNumber, item] as const),
  );
  for (const orderNumber of [
    `DY-JD-ACCEPTED-${suffix}`,
    `DY-TMALL-ACCEPTED-${suffix}`,
    `DY-TAOBAO-ACCEPTED-${suffix}`,
  ]) {
    expect(byOrder.get(orderNumber)).toMatchObject({
      storeTopicStatus: "COMPLIANT",
      storeTopicFailureReason: null,
      task: { channel: "DOUYIN" },
    });
    expect(JSON.parse(byOrder.get(orderNumber)!.requiredStoreTopics)).toEqual(
      [],
    );
    expect(
      JSON.parse(byOrder.get(orderNumber)!.matchedRequiredStoreTopics),
    ).toEqual([]);
  }
  expect(byOrder.get(`DY-JD-PLATFORM-${suffix}`)).toMatchObject({
    storeTopicStatus: "NON_COMPLIANT",
    task: { channel: "DOUYIN" },
  });
  expect(
    byOrder.get(`DY-JD-PLATFORM-${suffix}`)!.storeTopicFailureReason,
  ).toContain("可接受店铺话题");
  expect(byOrder.get(`XHS-TMALL-MISSING-${suffix}`)).toMatchObject({
    storeTopicStatus: "NON_COMPLIANT",
    task: { channel: "XIAOHONGSHU" },
  });
  expect(
    JSON.parse(
      byOrder.get(`XHS-TMALL-MISSING-${suffix}`)!.requiredStoreTopics,
    ),
  ).toEqual(["#天猫"]);
  expect(
    byOrder.get(`XHS-TMALL-MISSING-${suffix}`)!.storeTopicFailureReason,
  ).toContain("#天猫");

  for (const batchId of payload.data.batchIds as string[]) {
    expect(
      (await page.request.post(`/api/automation/batches/${batchId}/clear`)).ok(),
    ).toBeTruthy();
  }
});

test("抖音批次使用独立会话、单一后台页面并应用独立业务规则", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const { productId, campaignId } = await getDouyinAutomationFixture(page, {
    brandName: "达能",
  });
  const requirementsResponse = await page.request.get(
    `/api/campaigns/${campaignId}/requirements?productId=${productId}&stage=IFFO_P1`,
  );
  expect(requirementsResponse.ok()).toBeTruthy();
  const requirementContext = (await requirementsResponse.json()).data.context as {
    contentChannel: string;
    rulesConfigured: boolean;
    rules: Array<{ topic: string }>;
  };
  expect(requirementContext.contentChannel).toBe("DOUYIN");
  expect(requirementContext.rulesConfigured).toBe(true);
  expect(requirementContext.rules.map((rule) => rule.topic)).not.toContain(
    "#爱他美新手爸妈日记",
  );
  expect(requirementContext.rules.map((rule) => rule.topic)).toContain(
    "#新生儿奶粉",
  );
  const suffix = Date.now();
  const response = await page.request.post("/api/automation/batches", {
    data: {
      contentChannel: "DOUYIN",
      productId,
      campaignId,
      productStage: "IFFO_P1",
      urls: [
        `${E2E_ORIGIN}/mock/douyin?case=video&dy=${suffix}-1`,
        `${E2E_ORIGIN}/mock/douyin?case=multi-image&dy=${suffix}-2`,
      ],
    },
  });
  expect(response.ok()).toBeTruthy();
  const batchId = (await response.json()).data.batchId as string;

  await expect.poll(async () => {
    const payload = await (await page.request.get(`/api/automation/batches?batchId=${batchId}`)).json();
    return payload.data[0]?.status;
  }, { timeout: 90_000 }).toMatch(/^COMPLETED/u);

  const batchPayload = await (await page.request.get(`/api/automation/batches?batchId=${batchId}`)).json();
  const batch = batchPayload.data[0] as {
    channel: string;
    tasks: Array<{
      channel: string;
      status: string;
      auditResults: Array<{
        autoStatus: string;
      }>;
    }>;
  };
  expect(batch.channel).toBe("DOUYIN");
  expect(batch.tasks).toHaveLength(2);
  expect(batch.tasks.every((task) => task.channel === "DOUYIN")).toBe(true);
  expect(batch.tasks.every((task) => task.status === "COMPLETED")).toBe(true);
  expect(batch.tasks.every((task) => task.auditResults[0]?.autoStatus === "FAILED")).toBe(true);
  const resultPayload = await (
    await page.request.get(`/api/results?batchId=${batchId}&pageSize=100`)
  ).json();
  expect(resultPayload.data.total).toBe(2);
  expect(
    resultPayload.data.items.every(
      (item: { publicStatus: string }) => item.publicStatus === "NOT_REQUIRED",
    ),
  ).toBe(true);
  expect(
    resultPayload.data.items.every(
      (item: { failureReasons: string }) =>
        !item.failureReasons.includes("业务规则未配置"),
    ),
  ).toBe(true);
  const videoResult = resultPayload.data.items.find(
    (item: { task: { url: string } }) => item.task.url.includes("case=video"),
  );
  const imageTextResult = resultPayload.data.items.find(
    (item: { task: { url: string } }) =>
      item.task.url.includes("case=multi-image"),
  );
  expect(videoResult).toMatchObject({
    imageStatus: "NOT_REQUIRED",
    imageCount: 0,
  });
  expect(imageTextResult).toMatchObject({
    imageStatus: "COMPLIANT",
    imageCount: 5,
  });

  const douyinSession = (await (await page.request.get("/api/automation/session?platform=DOUYIN")).json()).data;
  const xhsSession = (await (await page.request.get("/api/automation/session?platform=XIAOHONGSHU")).json()).data;
  expect(douyinSession.profilePath).not.toBe(xhsSession.profilePath);
  expect(douyinSession.auditPageCreateCount).toBe(1);
  expect(douyinSession.auditPageReuseCount).toBeGreaterThanOrEqual(1);
  expect(douyinSession.pageCount).toBeLessThanOrEqual(2);

  const clear = await page.request.post(`/api/automation/batches/${batchId}/clear`);
  expect(clear.ok()).toBeTruthy();
});

test("抖音图文正文、真实话题、店铺话题和公开免审共同产生正常结论", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const products = (await (
    await page.request.get("/api/products")
  ).json()).data as Array<{ id: string; name: string }>;
  const product = products.find((item) => item.name === "爱他美澳洲白金版")!;
  const campaigns = (await (
    await page.request.get(
      `/api/campaigns?productId=${product.id}&contentChannel=DOUYIN`,
    )
  ).json()).data as Array<{
    id: string;
    name: string;
    month: string;
  }>;
  const campaign = campaigns.find((item) => item.month === "2026-07")!;
  const suffix = Date.now();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("达能客户导入");
  sheet.addRow([
    "平台（必填）",
    "店铺名称（必填）",
    "客户名（必填）",
    "产品系列（必填）",
    "段位（必填）",
    "阶段（必填）",
    "订单编号（必填）",
    "内容渠道（必填）",
    "链接（必填）",
    "发布时间（必填）",
    "活动名称（必填）",
  ]);
  sheet.addRow([
    "抖音电商",
    "FOLO海外旗舰店",
    "抖音正文话题回归",
    product.name,
    "2段",
    "IFFO",
    `DOUYIN-BUSINESS-${suffix}`,
    "抖音",
    `${E2E_ORIGIN}/mock/douyin?case=business-pass&raw=true&trailingHash=true&business=${suffix}`,
    "2026-07-26 12:00:00",
    campaign.name,
  ]);
  const metadata = workbook.addWorksheet("VERIDIA模板信息", {
    state: "veryHidden",
  });
  metadata.getCell("B1").value = "DANONE_CUSTOMER";
  const response = await page.request.post("/api/import/notes", {
    multipart: {
      file: {
        name: `douyin-body-topic-${suffix}.xlsx`,
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      },
      commit: "true",
      skipDuplicates: "true",
    },
  });
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  expect(payload.data).toMatchObject({ validCount: 1, invalidCount: 0 });
  const batchId = payload.data.batchIds[0] as string;
  await waitForTerminalBatch(page, batchId);

  const resultPayload = await (
    await page.request.get(
      `/api/results?importRecordId=${payload.data.importRecordId}&pageSize=100`,
    )
  ).json();
  expect(resultPayload.data.total).toBe(1);
  expect(resultPayload.data.items[0]).toMatchObject({
    autoStatus: "PASSED",
    publicStatus: "NOT_REQUIRED",
    effectiveBodyLength: 65,
    imageStatus: "COMPLIANT",
    imageCount: 3,
    storeTopicStatus: "COMPLIANT",
  });
  expect(JSON.parse(resultPayload.data.items[0].missingTopics)).toEqual([]);

  expect(
    (await page.request.post(`/api/automation/batches/${batchId}/clear`)).ok(),
  ).toBeTruthy();
});

test("抖音不存在作品使用独立终态且不阻断后续作品", async ({ page }) => {
  await login(page);
  const { productId, campaignId } = await getDouyinAutomationFixture(page);
  const suffix = Date.now();
  const response = await page.request.post("/api/automation/batches", {
    data: {
      contentChannel: "DOUYIN",
      productId,
      campaignId,
      urls: [
        `${E2E_ORIGIN}/mock/douyin?case=not-found&dy=${suffix}-missing`,
        `${E2E_ORIGIN}/mock/douyin?case=video&dy=${suffix}-normal`,
      ],
    },
  });
  expect(response.ok()).toBeTruthy();
  const batchId = (await response.json()).data.batchId as string;
  await expect.poll(async () => {
    const payload = await (await page.request.get(`/api/automation/batches?batchId=${batchId}`)).json();
    return payload.data[0]?.status;
  }, { timeout: 90_000 }).toMatch(/^COMPLETED/u);
  const payload = await (await page.request.get(`/api/automation/batches?batchId=${batchId}`)).json();
  expect(payload.data[0].tasks[0]).toMatchObject({ status: "COMPLETED", failureCode: "NOTE_NOT_FOUND" });
  expect(payload.data[0].tasks[1].status).toBe("COMPLETED");
  await page.request.post(`/api/automation/batches/${batchId}/clear`);
});

test("抖音临时网络错误最多重试两次且不创建新页面", async ({ page }) => {
  await login(page);
  const { productId, campaignId } = await getDouyinAutomationFixture(page);
  const before = (await (await page.request.get("/api/automation/session?platform=DOUYIN")).json()).data;
  const response = await page.request.post("/api/automation/batches", {
    data: {
      contentChannel: "DOUYIN",
      productId,
      campaignId,
      urls: [`${E2E_ORIGIN}/mock/douyin?case=network-error&dy=${Date.now()}`],
    },
  });
  expect(response.ok()).toBeTruthy();
  const batchId = (await response.json()).data.batchId as string;
  await expect.poll(async () => {
    const payload = await (await page.request.get(`/api/automation/batches?batchId=${batchId}`)).json();
    return payload.data[0]?.status;
  }, { timeout: 30_000 }).toMatch(/^COMPLETED_WITH_ERRORS$/u);
  const payload = await (await page.request.get(`/api/automation/batches?batchId=${batchId}`)).json();
  expect(payload.data[0].tasks[0]).toMatchObject({
    status: "READ_FAILED",
    failureCode: "NETWORK_ERROR",
    attempts: 3,
  });
  expect(payload.data[0].tasks[0].failureMessage).toContain(
    "抖音作品页面打开失败",
  );
  const failedResult = (await (
    await page.request.get(`/api/results?batchId=${batchId}&pageSize=10`)
  ).json()).data.items[0];
  expect(JSON.parse(failedResult.failureReasons)).toContain(
    "抖音作品页面打开失败，需人工确认",
  );
  expect(JSON.parse(failedResult.failureReasons).join("；")).not.toContain(
    "小红书页面打开失败",
  );
  const after = (await (await page.request.get("/api/automation/session?platform=DOUYIN")).json()).data;
  expect(after.auditPageCreateCount).toBe(before.auditPageCreateCount);
  expect(after.pageCount).toBeLessThanOrEqual(2);
  await page.request.post(`/api/automation/batches/${batchId}/clear`);
});

test("抖音安全限制暂停批次并只显示同一会话的人工页", async ({ page }) => {
  await login(page);
  const { productId, campaignId } = await getDouyinAutomationFixture(page);
  const response = await page.request.post("/api/automation/batches", {
    data: {
      contentChannel: "DOUYIN",
      productId,
      campaignId,
      urls: [`${E2E_ORIGIN}/mock/douyin?case=security&dy=${Date.now()}`],
    },
  });
  expect(response.ok()).toBeTruthy();
  const batchId = (await response.json()).data.batchId as string;
  await expect.poll(async () => {
    const payload = await (await page.request.get(`/api/automation/batches?batchId=${batchId}`)).json();
    return payload.data[0]?.status;
  }, { timeout: 30_000 }).toBe("SECURITY_RESTRICTED");
  const payload = await (await page.request.get(`/api/automation/batches?batchId=${batchId}`)).json();
  expect(payload.data[0].tasks[0]).toMatchObject({
    status: "PENDING",
    failureCode: "SECURITY_VERIFICATION",
  });
  expect(payload.data[0].tasks[0].auditResults).toHaveLength(0);
  const session = (await (await page.request.get("/api/automation/session?platform=DOUYIN")).json()).data;
  expect(session.interactivePageOpen).toBe(true);
  expect(session.browserInstanceCount).toBe(1);
  const clear = await page.request.post(`/api/automation/batches/${batchId}/clear`);
  expect(clear.ok()).toBeTruthy();
  const restarted = await page.request.post("/api/automation/session", {
    data: { platform: "DOUYIN", action: "RESTART_BROWSER" },
  });
  expect(restarted.ok()).toBeTruthy();
});

test("抖音未登录只暂停当前平台批次且不生成业务失败结果", async ({ page }) => {
  await login(page);
  const { productId, campaignId } = await getDouyinAutomationFixture(page);
  const response = await page.request.post("/api/automation/batches", {
    data: {
      contentChannel: "DOUYIN",
      productId,
      campaignId,
      urls: [
        `${E2E_ORIGIN}/mock/douyin?case=logged-out&dy=${Date.now()}`,
      ],
    },
  });
  expect(response.ok()).toBeTruthy();
  const batchId = (await response.json()).data.batchId as string;
  await expect.poll(async () => {
    const payload = await (
      await page.request.get(`/api/automation/batches?batchId=${batchId}`)
    ).json();
    return payload.data[0]?.status;
  }, { timeout: 30_000 }).toBe("LOGIN_EXPIRED");
  const batch = (await (
    await page.request.get(`/api/automation/batches?batchId=${batchId}`)
  ).json()).data[0];
  expect(batch.tasks[0]).toMatchObject({
    status: "PENDING",
    failureCode: "LOGIN_REQUIRED",
  });
  expect(batch.tasks[0].auditResults).toHaveLength(0);
  expect(
    (await page.request.post(`/api/automation/batches/${batchId}/clear`)).ok(),
  ).toBeTruthy();
  expect((await page.request.post("/api/automation/session", {
    data: { platform: "DOUYIN", action: "RESTART_BROWSER" },
  })).ok()).toBeTruthy();
});
