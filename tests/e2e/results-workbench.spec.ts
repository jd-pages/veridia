import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";

const resultExportHeaders = [
  "平台",
  "店铺名称",
  "客户名",
  "产品系列",
  "阶段",
  "段位",
  "订单编号",
  "内容渠道",
  "链接",
  "发布时间",
  "活动名称",
  "自审",
];

const kabritaResultExportHeaders = [
  "登记时间",
  "渠道",
  "店铺名称",
  "客户备注",
  "买家购买ID",
  "购买订单号",
  "购买时间",
  "购买罐数",
  "参与次数",
  "发布小红书账号",
  "小红书发布链接",
  "购买产品线",
  "活动名称",
  "自审",
];

const removedResultExportHeaders = [
  "异常分类",
  "笔记链接",
  "最终链接",
  "笔记ID",
  "任务来源",
  "正文允许段位",
  "正文实际识别段位",
  "达人昵称",
  "图片数量合规",
  "图片提取状态",
  "规则版本",
  "命中规则",
  "审核创建时间",
  "审核完成时间",
  "页面状态",
  "笔记状态",
  "话题审核",
  "图片",
  "审核结论",
  "失败原因",
  "客服修改留言 日期-已留言",
  "审核时间",
  "正文",
  "笔记正文",
  "原文正文",
  "提取正文",
  "正文内容",
  "noteContent",
  "contentText",
];

const danoneMixedSummaryHeaders = [
  "模板类型",
  "活动月份",
  "活动名称",
  "平台",
  "店铺名称",
  "客户名",
  "产品系列",
  "阶段",
  "段位",
  "订单编号",
  "内容渠道",
  "链接",
  "发布时间",
  "自审",
];

function resultExportFileNamePattern(scope: "当前筛选" | "所选结果") {
  return new RegExp(
    `^VERIDIA(?:佳贝艾特)?审核结果_${scope}_\\d{8}_\\d{6}\\.xlsx$`,
    "u",
  );
}

async function login(page: Page) {
  const isTransientConnectionError = (error: unknown) =>
    /\b(?:ECONNRESET|ECONNREFUSED)\b|socket hang up/iu.test(
      error instanceof Error ? error.message : String(error),
    );

  for (let attempt = 0; attempt <= 2; attempt += 1) {
    try {
      const response = await page.request.post("/api/auth/login", {
        data: { username: "admin", password: "Admin123!" },
      });
      if (!response.ok()) {
        throw new Error(
          `E2E 管理员登录失败 (${response.status()}): ${await response.text()}`,
        );
      }
      return;
    } catch (error) {
      if (!isTransientConnectionError(error) || attempt === 2) {
        throw error;
      }
      await expect
        .poll(
          async () => {
            try {
              return (await page.request.get("/api/health")).status();
            } catch (healthError) {
              if (!isTransientConnectionError(healthError)) {
                throw healthError;
              }
              return 0;
            }
          },
          { timeout: 5_000, intervals: [100, 250, 500] },
        )
        .toBe(200);
    }
  }
}

test("审核结果决策工作台整合列、筛选、批量操作和详情抽屉", async ({
  page,
  context,
}) => {
  await login(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/results?startDate=2026-08-01&endDate=2026-08-31");
  await expect(page).toHaveTitle("VERIDIA");
  await expect(page.getByText("日期范围", { exact: true })).toBeVisible();
  await expect(page.getByLabel("开始日期")).toHaveValue("2026-08-01");
  await expect(page.getByLabel("结束日期")).toHaveValue("2026-08-31");
  const datePickerPopup = page.locator(".ant-picker-dropdown:visible");
  await expect(async () => {
    if (!(await datePickerPopup.isVisible())) {
      await page.getByLabel("开始日期").click();
    }
    await expect(datePickerPopup.locator(".ant-picker-header-view")).toContainText(
      "八月",
      { timeout: 2_000 },
    );
  }).toPass({ timeout: 15_000 });
  await expect(datePickerPopup.locator(".ant-picker-header-view")).toContainText(
    "八月",
  );
  await expect(datePickerPopup.locator("thead th")).toHaveText([
    "日",
    "一",
    "二",
    "三",
    "四",
    "五",
    "六",
  ]);
  await expect(datePickerPopup.getByText("今天", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  const resultFilterRequests: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/results") resultFilterRequests.push(url);
  });
  await page.getByRole("button", { name: "查询" }).click();
  await expect
    .poll(() =>
      resultFilterRequests.some(
        (url) =>
          url.searchParams.get("startDate") === "2026-08-01" &&
          url.searchParams.get("endDate") === "2026-08-31",
      ),
    )
    .toBe(true);
  const dateDivider = page.getByLabel("日期范围分隔符");
  await expect(dateDivider).toHaveValue("至");
  const dividerBox = await dateDivider.boundingBox();
  expect(dividerBox).toBeTruthy();
  expect(dividerBox!.width).toBeGreaterThan(dividerBox!.height);
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 1093, height: 614 },
    { width: 1536, height: 864 },
  ]) {
    await page.setViewportSize(viewport);
    const startBox = await page.getByLabel("开始日期").boundingBox();
    const separatorBox = await dateDivider.boundingBox();
    const endBox = await page.getByLabel("结束日期").boundingBox();
    expect(startBox).toBeTruthy();
    expect(separatorBox).toBeTruthy();
    expect(endBox).toBeTruthy();
    expect(startBox!.width).toBeGreaterThan(80);
    expect(endBox!.width).toBeGreaterThan(80);
    expect(
      await page.getByLabel("开始日期").evaluate(
        (input) => input.scrollWidth <= input.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.getByLabel("结束日期").evaluate(
        (input) => input.scrollWidth <= input.clientWidth,
      ),
    ).toBe(true);
    expect(startBox!.x + startBox!.width).toBeLessThanOrEqual(separatorBox!.x);
    expect(separatorBox!.x + separatorBox!.width).toBeLessThanOrEqual(endBox!.x);
    expect(
      await page
        .getByRole("region", { name: "审核结果筛选" })
        .evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page
      .getByRole("region", { name: "审核结果筛选" })
      .evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
  ).toBe(true);
  await page.setViewportSize({ width: 1366, height: 768 });

  await expect(
    page.getByText("查看自动审核结论、异常原因及人工复核记录"),
  ).toBeVisible();
  await expect(page.getByText("平台", { exact: true })).toBeVisible();
  await expect(page.getByText("渠道", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("订单编号")).toBeVisible();
  for (const label of ["结果总数", "审核通过", "审核不通过", "笔记不存在", "待人工复核"]) {
    await expect(page.getByRole("button", { name: new RegExp(label) })).toBeVisible();
  }

  const headers = page.locator(".ant-table-thead th");
  await expect(headers).toContainText([
    "笔记对象",
    "归属信息",
    "渠道",
    "话题审核",
    "图片",
    "正文审核",
    "审核结论",
    "操作",
  ]);
  for (const removedColumn of [
    "笔记ID",
    "产品名称",
    "活动名称",
    "页面状态",
    "文章状态",
    "标签内容",
    "缺失标签",
    "不通过原因",
  ]) {
    await expect(
      page.locator(".ant-table-thead").getByText(removedColumn, { exact: true }),
    ).toHaveCount(0);
  }

  await page.getByRole("button", { name: /高级筛选/ }).click();
  await expect(page.getByLabel("不通过原因")).toBeVisible();
  for (const removedFilter of [
    "蓝色话题可点击状态",
    "规则版本",
    "留存验证状态",
  ]) {
    await expect(page.getByText(removedFilter, { exact: true })).toHaveCount(0);
  }

  await page.getByRole("combobox", { name: "页面状态" }).click();
  await page.getByText("页面正常", { exact: true }).last().click();
  await page.getByRole("button", { name: "查询" }).click();

  const exportRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/results/export")) {
      exportRequests.push(request.url());
    }
  });
  const pagesBeforeExport = context.pages().length;
  const exportButton = page.getByRole("button", {
    name: /导出当前结果/u,
  });
  const downloadPromise = page.waitForEvent("download");
  await exportButton.evaluate((button) => {
    for (let index = 0; index < 5; index += 1) {
      (button as HTMLButtonElement).click();
    }
  });
  const download = await downloadPromise;
  await expect.poll(() => exportRequests.length).toBe(1);
  expect(context.pages()).toHaveLength(pagesBeforeExport);
  expect(download.suggestedFilename()).toMatch(
    resultExportFileNamePattern("当前筛选"),
  );
  const exportedUrl = new URL(exportRequests[0]);
  expect(exportedUrl.searchParams.get("startDate")).toMatch(
    /^\d{4}-\d{2}-01$/u,
  );
  expect(exportedUrl.searchParams.get("endDate")).toMatch(
    /^\d{4}-\d{2}-\d{2}$/u,
  );
  expect(exportedUrl.searchParams.get("dateType")).toBe("AUDITED_AT");
  expect(exportedUrl.searchParams.get("pageStatus")).toBe("NORMAL");
  const filteredList = (await (
    await page.request.get(
      `/api/results?${exportedUrl.searchParams.toString()}&page=1&pageSize=1`,
    )
  ).json()).data as { total: number };
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile((await download.path())!);
  const danoneSummary = workbook.getWorksheet("达能审核结果汇总");
  const mixedSummary = workbook.getWorksheet("审核结果汇总");
  const exportedRecordCount = mixedSummary
    ? Math.max(mixedSummary.rowCount - 1, 0)
    : danoneSummary
      ? Math.max(danoneSummary.rowCount - 1, 0) +
        Math.max(
          (workbook.getWorksheet("佳贝艾特审核结果")?.rowCount || 1) - 1,
          0,
        )
      : workbook.worksheets.reduce(
          (total, worksheet) => total + Math.max(worksheet.rowCount - 1, 0),
          0,
        );
  expect(exportedRecordCount).toBe(filteredList.total);
  const exportHeaders = workbook.worksheets[0]
    .getRow(1)
    .values as unknown[];
  expect(exportHeaders.slice(1)).toEqual(
    danoneSummary || mixedSummary
      ? danoneMixedSummaryHeaders
      : resultExportHeaders,
  );
  for (const removedHeader of removedResultExportHeaders) {
    expect(exportHeaders).not.toContain(removedHeader);
  }
  await expect(page.getByText(/导出成功，共 \d+ 条/u)).toBeVisible();

  await page.getByLabel("关键词搜索").fill(`无结果-${Date.now()}`);
  await page.getByRole("button", { name: "查询" }).click();
  await expect(page.getByText("当前筛选共 0 条", { exact: true })).toBeVisible();
  await exportButton.evaluate((button) =>
    (button as HTMLButtonElement).click(),
  );
  await expect(
    page.getByText("当前筛选无结果，未生成文件", { exact: true }),
  ).toBeVisible();
  expect(exportRequests).toHaveLength(1);
  await page.getByRole("button", { name: "重置" }).click();
  await expect(page.locator(".ant-spin-spinning")).toHaveCount(0);
  await expect(page.locator(".ant-table-row").first()).toBeVisible();

  const firstRowCheckbox = page
    .locator(".ant-table-row")
    .first()
    .getByRole("checkbox");
  await firstRowCheckbox.check({ force: true });
  await expect(page.getByText(/已选择\s*1\s*条/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "批量重新审核" }),
  ).toBeEnabled();

  const selectedDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出所选" }).click();
  const selectedDownload = await selectedDownloadPromise;
  const selectedFileName = selectedDownload.suggestedFilename();
  expect(selectedFileName).toMatch(
    resultExportFileNamePattern("所选结果"),
  );
  const selectedWorkbook = new ExcelJS.Workbook();
  await selectedWorkbook.xlsx.readFile((await selectedDownload.path())!);
  expect(selectedWorkbook.worksheets[0].rowCount - 1).toBe(1);
  const selectedHeaders = selectedWorkbook.worksheets[0].getRow(1)
    .values as unknown[];
  expect(selectedHeaders.slice(1)).toEqual(
    selectedFileName.startsWith("VERIDIA佳贝艾特")
      ? kabritaResultExportHeaders
      : resultExportHeaders,
  );
  for (const removedHeader of removedResultExportHeaders) {
    expect(selectedHeaders).not.toContain(removedHeader);
  }

  await page
    .getByRole("button", { name: /查看详情/ })
    .first()
    .click();
  const drawer = page.locator(".ant-drawer-content");
  await expect(drawer.getByRole("region", { name: "顶部结论" })).toBeVisible();
  await expect(drawer.getByRole("region", { name: "审核明细" })).toBeVisible();
  await expect(drawer.getByRole("region", { name: "链接操作" })).toBeVisible();
  await expect(drawer.getByRole("region", { name: "人工复核记录" })).toBeVisible();
  for (const label of [
    "渠道",
    "平台",
    "店铺",
    "订单编号",
    "发帖时间",
    "实际审核时间",
  ]) {
    await expect(drawer.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(
    drawer.getByText("发帖时间", { exact: true }).locator("..").locator("strong"),
  ).toHaveText(/^(?:—|(?:\d{2}-\d{2}|\d{4}-\d{2}-\d{2})(?: \d{2}:\d{2}(?::\d{2})?)?)$/u);
  await expect(drawer.getByText("笔记基础信息", { exact: true })).toHaveCount(0);
  await expect(drawer.getByText(/笔记ID/u)).toHaveCount(0);
  await expect(page).toHaveURL(/\/results$/u);
});

test("审核详情只展示业务判断卡片并隐藏自动取证技术字段", async ({ page }) => {
  await login(page);
  const listResponse = await page.request.get("/api/results?page=1&pageSize=100");
  expect(listResponse.ok()).toBeTruthy();
  const listPayload = (await listResponse.json()) as {
    data: {
      items: Array<{
        id: string;
        note: { platformNoteId: string | null };
      }>;
    };
  };
  const evidenceFixture = listPayload.data.items.find((item) =>
    item.note.platformNoteId?.startsWith("isolated-fixture-"),
  );
  expect(evidenceFixture).toBeTruthy();

  await page.goto(`/results/${evidenceFixture!.id}`);
  for (const section of [
    "顶部结论",
    "失败原因",
    "审核明细",
    "链接操作",
    "人工复核记录",
  ]) {
    await expect(page.getByRole("region", { name: section })).toBeVisible();
  }
  for (const hidden of [
    "笔记基础信息",
    "笔记正文",
    "自动取证证据",
    "NOTE_DETAIL",
    "异常或失败原因",
  ]) {
    await expect(page.getByText(hidden, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText(/笔记ID/u)).toHaveCount(0);
  await expect(page.getByText("小红书", { exact: true }).first()).toBeVisible();
  const topConclusion = page.getByRole("region", { name: "顶部结论" });
  await expect(
    topConclusion.getByText("京东健康进口超市 Playwright 测试长店铺名称", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    topConclusion.getByText(`ORDER-${evidenceFixture!.note.platformNoteId}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    topConclusion
      .getByText("实际审核时间", { exact: true })
      .locator("..")
      .locator("strong"),
  ).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
});

test("成交平台、内容渠道和订单编号可同时筛选并重置", async ({ page }) => {
  await login(page);
  await page.goto("/results?startDate=2026-08-01&endDate=2026-08-31");
  const resultRequests: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/results") resultRequests.push(url);
  });

  await page.getByRole("combobox", { name: "平台" }).click();
  await page.getByText("京东", { exact: true }).last().click();
  await page.getByRole("combobox", { name: "渠道" }).click();
  await page.getByText("小红书", { exact: true }).last().click();
  await page.getByLabel("订单编号").fill("  ORDER-isolated-fixture-15  ");
  await page.getByRole("button", { name: "查询" }).click();
  await expect(page.getByText("当前筛选共 1 条", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      resultRequests.some(
        (url) =>
          url.searchParams.get("commercePlatform") === "JD" &&
          url.searchParams.get("channel") === "XIAOHONGSHU" &&
          url.searchParams.get("orderNumber") === "ORDER-isolated-fixture-15",
      ),
    )
    .toBe(true);

  await page.getByRole("button", { name: "重置" }).click();
  await expect(page.getByLabel("订单编号")).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "平台" })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "渠道" })).toHaveValue("");
  await expect(page.locator(".ant-table-row").first()).toBeVisible();
});

test("产品筛选从历史审核任务加载已结束活动", async ({ page }) => {
  await login(page);
  const response = await page.request.get("/api/results?page=1&pageSize=1");
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as {
    data: { items: Array<{ task: {
      product: { id: string; name: string };
      campaign: { id: string; name: string };
    } }> };
  };
  const fixture = payload.data.items[0].task;
  await page.goto("/results?startDate=2026-08-01&endDate=2026-08-31");
  await page.locator(".ant-spin-spinning").waitFor({ state: "detached" });
  await page.getByText("产品", { exact: true }).locator("..").locator(".ant-select").click();
  const campaignResponsePromise = page.waitForResponse((candidate) =>
    candidate.url().includes(
      `/api/results/campaign-options?productId=${encodeURIComponent(fixture.product.id)}`,
    ),
  );
  await page.getByText(fixture.product.name, { exact: true }).last().click();
  const campaignResponse = await campaignResponsePromise;
  expect(campaignResponse.ok()).toBeTruthy();
  await page.getByText("活动", { exact: true }).locator("..").locator(".ant-select").click();
  await expect(page.getByText(fixture.campaign.name, { exact: true }).last()).toBeVisible();
  await expect(page.getByText("正在加载活动...", { exact: true })).toHaveCount(0);
});

test("审核详情区分原笔记链接与最终链接并复制完整原始 URL", async ({
  page,
  context,
}) => {
  await login(page);
  const listResponse = await page.request.get("/api/results?page=1&pageSize=100");
  expect(listResponse.ok()).toBeTruthy();
  const listPayload = (await listResponse.json()) as {
    data: {
      items: Array<{
        id: string;
        failureReasons: string;
        task: { url: string; finalUrl: string | null };
        note: {
          url: string;
          finalUrl: string | null;
          platformNoteId: string | null;
        };
      }>;
    };
  };
  const fixture = listPayload.data.items.find(
    (item) => item.note.platformNoteId === "isolated-fixture-1",
  );
  expect(fixture).toBeTruthy();
  const originalUrl = fixture!.task.url;
  const finalUrl = fixture!.task.finalUrl || fixture!.note.finalUrl || fixture!.note.url;
  const missingTopic = (JSON.parse(fixture!.failureReasons) as string[])
    .find((reason) => reason.startsWith("缺少精确话题"))
    ?.match(/#[^\s；，,]+/u)?.[0];
  expect(finalUrl).not.toBe(originalUrl);
  expect(missingTopic).toBeTruthy();

  await page.goto(`/results/${fixture!.id}`);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  const linkActions = page.getByRole("region", { name: "链接操作" });
  await expect(
    linkActions.getByRole("link", { name: "打开原笔记", exact: true }),
  ).toHaveAttribute("href", originalUrl);
  await expect(
    linkActions.getByRole("link", { name: "打开最终链接", exact: true }),
  ).toHaveAttribute("href", finalUrl);
  await expect(page.getByText(originalUrl, { exact: true })).toHaveCount(0);
  await expect(page.getByText(finalUrl, { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "失败原因" })
      .getByText(`缺少必带话题：${missingTopic}`, { exact: true }),
  ).toBeVisible();
  await linkActions
    .getByRole("button", { name: "复制原链接", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(originalUrl);

  await page.goto("/results");
  await page.getByLabel("关键词搜索").fill("isolated-fixture-1");
  await page.getByRole("button", { name: "查询" }).click();
  const fixtureRow = page.locator(".ant-table-row").filter({
    has: page.getByRole("link", { name: originalUrl, exact: true }),
  });
  await expect(fixtureRow).toHaveCount(1);
  await expect(fixtureRow.getByText("最终链接：", { exact: true })).toBeVisible();
  await expect(
    fixtureRow.getByRole("link", { name: originalUrl, exact: true }),
  ).toHaveAttribute("href", originalUrl);
  await expect(
    fixtureRow.getByRole("link", { name: finalUrl, exact: true }),
  ).toHaveAttribute("href", finalUrl);
  await expect(
    fixtureRow.getByRole("link", { name: "打开原笔记链接", exact: true }),
  ).toHaveAttribute("href", originalUrl);
  await expect(
    fixtureRow.getByRole("link", { name: "打开最终链接", exact: true }),
  ).toHaveAttribute("href", finalUrl);
  await fixtureRow.getByRole("button", { name: /查看详情/u }).click();
  const drawer = page.locator(".ant-drawer-content");
  const drawerLinkActions = drawer.getByRole("region", { name: "链接操作" });
  await expect(
    drawerLinkActions.getByRole("link", { name: "打开原笔记", exact: true }),
  ).toHaveAttribute("href", originalUrl);
  await expect(
    drawerLinkActions.getByRole("link", { name: "打开最终链接", exact: true }),
  ).toHaveAttribute("href", finalUrl);
  await expect(drawer.getByText(originalUrl, { exact: true })).toHaveCount(0);
  await expect(drawer.getByText(finalUrl, { exact: true })).toHaveCount(0);
  await expect(drawer.getByText(/笔记ID/u)).toHaveCount(0);
  await expect(drawer.getByRole("heading", { name: "失败原因" })).toHaveCount(1);
  await expect(
    drawer
      .getByRole("region", { name: "失败原因" })
      .getByText(`缺少必带话题：${missingTopic}`, { exact: true }),
  ).toBeVisible();
});

test("ADMIN 可确认单条删除和批量删除审核结果", async ({ page }) => {
  await login(page);
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/tasks");
        const payload = (await response.json()) as {
          data: Array<{ status: string }>;
        };
        return payload.data.filter(({ status }) =>
          ["PENDING", "PROCESSING"].includes(status),
        ).length;
      },
      { timeout: 30_000 },
    )
    .toBe(0);
  await page.goto("/results");
  await expect(page.locator(".ant-table-row").first()).toBeVisible();

  const initialList = (await (
    await page.request.get("/api/results?page=1&pageSize=100")
  ).json()) as {
    data: { total: number; items: Array<{ id: string }> };
  };
  const firstResultId = initialList.data.items[0].id;
  const detailResponse = await page.request.get(`/api/results/${firstResultId}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()) as {
    data: {
      task: {
        id: string;
        batchId: string | null;
        url: string;
        productStage: string | null;
        product: { id: string };
        campaign: { id: string };
      };
    };
  };
  const rulesBefore = (await (
    await page.request.get(
      `/api/rules?campaignId=${detail.data.task.campaign.id}`,
    )
  ).json()) as { data: Array<{ id: string }> };

  const deleteRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "DELETE" &&
      url.pathname === `/api/results/${firstResultId}`
    ) {
      deleteRequests.push(request.url());
    }
  });

  await page.getByLabel("更多操作").first().click();
  await page.getByText("删除该结果", { exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("确认删除该审核结果？", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "删除后，该审核结果及其关联审核明细将无法恢复，但不会删除原审核任务、导入记录、产品、活动或规则。",
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: /取\s*消/u }).click();
  await expect(dialog).toBeHidden();
  expect(deleteRequests).toHaveLength(0);

  await page.getByLabel("更多操作").first().click();
  await page.getByText("删除该结果", { exact: true }).click();
  dialog = page.getByRole("dialog");
  const singleDeleteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === `/api/results/${firstResultId}`,
  );
  await dialog.getByRole("button", { name: /确认删除/u }).click();
  const singleDeletePayload = (await (await singleDeleteResponse).json()) as {
    data: { deletedCount: number; deletedIds: string[] };
  };
  expect(singleDeletePayload.data).toEqual({
    deletedCount: 1,
    deletedIds: [firstResultId],
  });
  await expect(
    page.getByText("已成功删除 1 条审核结果", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => deleteRequests.length).toBe(1);

  const deletedDetail = await page.request.get(`/api/results/${firstResultId}`);
  expect(deletedDetail.status()).toBe(404);
  const deletedExport = await page.request.get(
    `/api/results/export?ids=${firstResultId}`,
  );
  expect(deletedExport.status()).toBe(404);
  const deletedSearch = (await (
    await page.request.get(
      `/api/results?keyword=${encodeURIComponent(detail.data.task.url)}&page=1&pageSize=100`,
    )
  ).json()) as { data: { items: Array<{ id: string }> } };
  expect(deletedSearch.data.items.map(({ id }) => id)).not.toContain(
    firstResultId,
  );
  const afterSingleDelete = (await (
    await page.request.get("/api/results?page=1&pageSize=100")
  ).json()) as { data: { total: number } };
  expect(afterSingleDelete.data.total).toBe(initialList.data.total - 1);
  const taskQuery = detail.data.task.batchId
    ? `?batchId=${detail.data.task.batchId}`
    : "";
  const tasks = (await (
    await page.request.get(`/api/tasks${taskQuery}`)
  ).json()) as {
    data: Array<{ id: string }>;
  };
  const products = (await (await page.request.get("/api/products")).json()) as {
    data: Array<{ id: string }>;
  };
  const campaigns = (await (
    await page.request.get("/api/campaigns")
  ).json()) as { data: Array<{ id: string }> };
  expect(tasks.data.some(({ id }) => id === detail.data.task.id)).toBeTruthy();
  expect(
    products.data.some(({ id }) => id === detail.data.task.product.id),
  ).toBeTruthy();
  expect(
    campaigns.data.some(({ id }) => id === detail.data.task.campaign.id),
  ).toBeTruthy();
  const rulesAfter = (await (
    await page.request.get(
      `/api/rules?campaignId=${detail.data.task.campaign.id}`,
    )
  ).json()) as { data: Array<{ id: string }> };
  expect(rulesAfter.data.map(({ id }) => id)).toEqual(
    rulesBefore.data.map(({ id }) => id),
  );

  const recreateResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: "E2E 删除后重新审核",
      urls: detail.data.task.url,
      productId: detail.data.task.product.id,
      campaignId: detail.data.task.campaign.id,
      productStage: detail.data.task.productStage,
    },
  });
  expect(recreateResponse.status()).toBe(400);
  expect((await recreateResponse.json()).error).toBe(
    "该笔记今天已创建过审核任务，请勿重复创建。",
  );

  await page.reload();
  const beforeBatchDelete = (await (
    await page.request.get("/api/results?page=1&pageSize=20")
  ).json()) as { data: { items: Array<{ id: string }> } };
  const visibleCandidates = await Promise.all(
    beforeBatchDelete.data.items.map(async ({ id }) => {
      const payload = (await (
        await page.request.get(`/api/results/${id}`)
      ).json()) as {
        data: {
          task: {
            url: string;
            productStage: string | null;
            product: { id: string };
            campaign: { id: string };
          };
        };
      };
      return { resultId: id, task: payload.data.task };
    }),
  );
  const batchCandidates = visibleCandidates.filter(
    (candidate, index, candidates) =>
      candidates.findIndex(
        (other) =>
          other.task.url === candidate.task.url &&
          other.task.campaign.id === candidate.task.campaign.id,
      ) === index,
  ).slice(0, 2);
  expect(batchCandidates).toHaveLength(2);
  for (const candidate of batchCandidates) {
    const keyedRow = page.locator(
      `.ant-table-row[data-row-key="${candidate.resultId}"]`,
    );
    await expect(keyedRow).toBeVisible();
    const selectionControl = keyedRow.locator(
      "td.ant-table-selection-column label.ant-checkbox-wrapper",
    );
    const checkbox = selectionControl.getByRole("checkbox");
    await selectionControl.scrollIntoViewIfNeeded();
    await expect(checkbox).not.toBeChecked();
    await selectionControl.click();
    await expect(checkbox).toBeChecked();
  }
  const batchDeleteButton = page.getByRole("button", {
    name: "批量删除（2）",
  });
  await expect(batchDeleteButton).toBeEnabled();

  const batchRequests: string[] = [];
  let batchDeletedIds: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/results/batch-delete"
    ) {
      batchRequests.push(request.url());
      batchDeletedIds = (request.postDataJSON() as { ids: string[] }).ids;
    }
  });
  await batchDeleteButton.click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("确认批量删除？", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "确认删除已选择的 2 条审核结果？删除后不可恢复。",
      { exact: true },
    ),
  ).toBeVisible();
  const batchDeleteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/results/batch-delete",
  );
  await dialog.getByRole("button", { name: /确认删除/u }).click();
  const batchDeletePayload = (await (await batchDeleteResponse).json()) as {
    data: { deletedCount: number; deletedIds: string[] };
  };
  expect(batchDeletePayload.data.deletedCount).toBe(2);
  expect([...batchDeletePayload.data.deletedIds].sort()).toEqual(
    [...batchDeletedIds].sort(),
  );
  expect([...batchDeletedIds].sort()).toEqual(
    batchCandidates.map(({ resultId }) => resultId).sort(),
  );
  await expect(
    page.getByText("已成功删除 2 条审核结果", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => batchRequests.length).toBe(1);
  await expect(page.getByText(/已选择\s*0\s*条/u)).toBeVisible();

  for (const { task: deletedTask } of batchCandidates) {
    const response = await page.request.post("/api/automation/batches", {
      data: {
        name: "E2E 批量删除后重新审核",
        urls: deletedTask.url,
        productId: deletedTask.product.id,
        campaignId: deletedTask.campaign.id,
        productStage: deletedTask.productStage,
      },
    });
    const payload = (await response.json()) as {
      data?: { batchId?: string; created?: number };
      error?: string;
    };
    expect(response.status(), JSON.stringify(payload)).toBe(400);
    expect(payload.error).toBe(
      "该笔记今天已创建过审核任务，请勿重复创建。",
    );
  }

  const finalList = (await (
    await page.request.get("/api/results?page=1&pageSize=100")
  ).json()) as {
    data: { total: number; items: Array<{ id: string }> };
  };
  const finalIds = finalList.data.items.map(({ id }) => id);
  expect(finalIds).not.toContain(firstResultId);
  for (const deletedId of batchDeletedIds) {
    expect(finalIds).not.toContain(deletedId);
  }
  await page.reload();
  await expect(
    page.getByText(`当前筛选共 ${finalList.data.total} 条`, { exact: true }),
  ).toBeVisible();
});
