import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { E2E_ORIGIN } from "./e2e-origin";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("Admin123!");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard/u);
}

async function waitForTerminalBatch(page: Page, batchId: string) {
  await expect.poll(async () => {
    const payload = await (
      await page.request.get(`/api/automation/batches?batchId=${batchId}`)
    ).json();
    return payload.data[0]?.status;
  }, { timeout: 120_000 }).toMatch(
    /^(?:COMPLETED|COMPLETED_WITH_ERRORS)$/u,
  );
}

test("审核任务页提供相互隔离的小红书与抖音环境入口", async ({ page }) => {
  await login(page);
  await page.goto("/mock/douyin?case=topics");
  await expect(page.locator("a[data-douyin-topic]")).toHaveCount(2);
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "内容平台专用浏览器" })).toBeVisible();
  await expect(page.getByTestId("automation-session-browser-title")).toHaveText(
    "小红书专用浏览器",
  );
  await page.getByRole("tab", { name: "抖音" }).click();
  await expect(page.getByTestId("automation-session-browser-title")).toHaveText(
    "抖音专用浏览器",
  );
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

test("规则与活动管理按内容渠道展示独立抖音副本", async ({ page }) => {
  await login(page);
  const xhsCampaigns = (await (
    await page.request.get("/api/campaigns?contentChannel=XIAOHONGSHU")
  ).json()).data as Array<{ id: string; name: string; contentChannel: string }>;
  const douyinCampaigns = (await (
    await page.request.get("/api/campaigns?contentChannel=DOUYIN")
  ).json()).data as Array<{ id: string; name: string; contentChannel: string }>;
  expect(xhsCampaigns).toHaveLength(3);
  expect(douyinCampaigns).toHaveLength(3);
  expect(xhsCampaigns.every((item) => item.contentChannel === "XIAOHONGSHU"))
    .toBe(true);
  expect(douyinCampaigns.every((item) => item.contentChannel === "DOUYIN"))
    .toBe(true);
  expect(douyinCampaigns.every((item) => item.name.includes("抖音"))).toBe(true);
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
  ).json()).data as Array<{ id: string; topic: string; contentChannel: string }>;
  expect(douyinRules).toHaveLength(26);
  expect(douyinRules.every((item) => item.contentChannel === "DOUYIN")).toBe(
    true,
  );
  expect(douyinRules.map((item) => item.topic)).not.toContain(
    "#爱他美新手爸妈日记",
  );

  await page.goto("/rules?channel=DOUYIN");
  await expect(page.locator(".ant-segmented-item-selected")).toContainText("抖音");
  const danoneCard = page.locator(".rule-brand-card").filter({
    has: page.getByText("达能", { exact: true }),
  });
  await danoneCard.getByRole("button", { name: "进入规则" }).click();
  await expect(page).toHaveURL(/channel=DOUYIN/u);
  await expect(page.getByText("#爱他美新手爸妈日记")).toHaveCount(0);

  await page.goto("/campaigns");
  await page.locator(".ant-segmented-item").filter({ hasText: "抖音" }).click();
  await expect(page.getByText(augustDouyinCampaign!.name, { exact: true }))
    .toBeVisible();
  await expect(
    page.getByText(augustXhsCampaign!.name, { exact: true }),
  ).toHaveCount(0);

  const templateResponse = await page.request.get(
    "/api/import/template?brand=danone-agency",
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
  expect(
    workbook.getWorksheet("达能代发导入")?.getCell("G10000").dataValidation,
  ).toMatchObject({ type: "list", formulae: ['"小红书,抖音"'] });
});

test("混合 Excel 只创建一个导入记录并拆分为两个串行平台批次", async ({ page }) => {
  test.setTimeout(180_000);
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
    "产品系列（必填）", "段位（必填）", "订单编号（必填）",
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
  const committed = (await commitResponse.json()).data as {
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

  for (const batchId of committed.batchIds) {
    expect(
      (await page.request.post(`/api/automation/batches/${batchId}/clear`)).ok(),
    ).toBeTruthy();
  }
});

test("抖音批次使用独立会话、单一后台页面并应用独立业务规则", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const products = (await (await page.request.get("/api/products")).json()).data as Array<{
    id: string;
    brandName: string;
  }>;
  const product = products.find((item) => item.brandName === "达能")!;
  const campaigns = (await (await page.request.get(`/api/campaigns?productId=${product.id}&contentChannel=DOUYIN`)).json()).data as Array<{ id: string }>;
  const campaign = campaigns[0];
  const requirementsResponse = await page.request.get(
    `/api/campaigns/${campaign.id}/requirements?productId=${product.id}&stage=IFFO_P1`,
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
      productId: product.id,
      campaignId: campaign.id,
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

test("抖音不存在作品使用独立终态且不阻断后续作品", async ({ page }) => {
  await login(page);
  const products = (await (await page.request.get("/api/products")).json()).data as Array<{ id: string }>;
  const product = products[0];
  const campaigns = (await (await page.request.get(`/api/campaigns?productId=${product.id}&contentChannel=DOUYIN`)).json()).data as Array<{ id: string }>;
  const suffix = Date.now();
  const response = await page.request.post("/api/automation/batches", {
    data: {
      contentChannel: "DOUYIN",
      productId: product.id,
      campaignId: campaigns[0].id,
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
  const product = ((await (await page.request.get("/api/products")).json()).data as Array<{ id: string }>)[0];
  const campaign = ((await (await page.request.get(`/api/campaigns?productId=${product.id}&contentChannel=DOUYIN`)).json()).data as Array<{ id: string }>)[0];
  const before = (await (await page.request.get("/api/automation/session?platform=DOUYIN")).json()).data;
  const response = await page.request.post("/api/automation/batches", {
    data: {
      contentChannel: "DOUYIN",
      productId: product.id,
      campaignId: campaign.id,
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
  const after = (await (await page.request.get("/api/automation/session?platform=DOUYIN")).json()).data;
  expect(after.auditPageCreateCount).toBe(before.auditPageCreateCount);
  expect(after.pageCount).toBeLessThanOrEqual(2);
  await page.request.post(`/api/automation/batches/${batchId}/clear`);
});

test("抖音安全限制暂停批次并只显示同一会话的人工页", async ({ page }) => {
  await login(page);
  const product = ((await (await page.request.get("/api/products")).json()).data as Array<{ id: string }>)[0];
  const campaign = ((await (await page.request.get(`/api/campaigns?productId=${product.id}&contentChannel=DOUYIN`)).json()).data as Array<{ id: string }>)[0];
  const response = await page.request.post("/api/automation/batches", {
    data: {
      contentChannel: "DOUYIN",
      productId: product.id,
      campaignId: campaign.id,
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
  const product = ((await (
    await page.request.get("/api/products")
  ).json()).data as Array<{ id: string }>)[0];
  const campaign = ((await (
    await page.request.get(`/api/campaigns?productId=${product.id}&contentChannel=DOUYIN`)
  ).json()).data as Array<{ id: string }>)[0];
  const response = await page.request.post("/api/automation/batches", {
    data: {
      contentChannel: "DOUYIN",
      productId: product.id,
      campaignId: campaign.id,
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
