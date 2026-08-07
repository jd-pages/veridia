import { expect, test } from "@playwright/test";
import { E2E_ORIGIN } from "./e2e-origin";

const cleanupBatchIds: string[] = [];

test.afterEach(async ({ page }) => {
  for (const batchId of [...new Set(cleanupBatchIds)].reverse()) {
    await page.request
      .post(`/api/automation/batches/${batchId}/control`, {
        data: { action: "CANCEL" },
      })
      .catch(() => undefined);
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/automation/batches?batchId=${batchId}&includeTasks=false`,
          );
          const batch = (
            (await response.json()).data as Array<{ status: string }>
          )[0];
          return batch?.status || "CLEARED";
        },
        { timeout: 15_000 },
      )
      .toMatch(
        /^(?:CANCELLED|COMPLETED|COMPLETED_WITH_ERRORS|FAILED|READ_FAILED|PAUSED|LOGIN_EXPIRED|SECURITY_RESTRICTED|CLEARED)$/u,
      );
    await page.request
      .post(`/api/automation/batches/${batchId}/clear`)
      .catch(() => undefined);
  }
  cleanupBatchIds.length = 0;
});

test("审核任务页只展示当前批次的执行记录和笔记", async ({ page }) => {
  const loginResponse = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(loginResponse.ok()).toBeTruthy();

  const products = (
    await (await page.request.get("/api/products")).json()
  ).data as Array<{ id: string; name: string }>;
  const product =
    products.find((item) => item.name.includes("澳洲白金版")) || products[0];
  const campaigns = (
    await (
      await page.request.get(`/api/campaigns?productId=${product.id}`)
    ).json()
  ).data as Array<{ id: string; name: string }>;
  const campaign = campaigns.find((item) =>
    item.name.includes("爱他美2026年7月"),
  ) || campaigns[0];
  const suffix = Date.now();
  const historyUrl = `${E2E_ORIGIN}/mock/xhs?case=passed&history-task=${suffix}`;
  const currentUrls = [
    `${E2E_ORIGIN}/mock/xhs?case=passed&current-task=${suffix}-1`,
    `${E2E_ORIGIN}/mock/xhs?case=passed&current-task=${suffix}-2`,
  ];

  const historyResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: `历史批次-${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO",
      urls: historyUrl,
      intervalMs: 1000,
    },
  });
  expect(historyResponse.ok()).toBeTruthy();
  const historyBatchId = (await historyResponse.json()).data.batchId as string;
  cleanupBatchIds.push(historyBatchId);
  await page.request.post(`/api/automation/batches/${historyBatchId}/control`, {
    data: { action: "CANCEL" },
  });

  const currentResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: `当前批次-${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO",
      urls: currentUrls.join("\n"),
      intervalMs: 1000,
    },
  });
  expect(currentResponse.ok()).toBeTruthy();
  const currentBatchId = (await currentResponse.json()).data.batchId as string;
  cleanupBatchIds.push(currentBatchId);

  const currentTaskResponse = await page.request.get(
    `/api/tasks?batchId=${currentBatchId}`,
  );
  expect(currentTaskResponse.ok()).toBeTruthy();
  const currentTasks = (await currentTaskResponse.json()).data as Array<{
    id: string;
    batchId: string;
    url: string;
  }>;
  expect(currentTasks).toHaveLength(2);
  expect(currentTasks.every((task) => task.batchId === currentBatchId)).toBe(true);
  expect(currentTasks.map((task) => task.url)).toEqual(currentUrls);

  const historyTaskResponse = await page.request.get(
    `/api/tasks?batchId=${historyBatchId}`,
  );
  const historyTasks = (await historyTaskResponse.json()).data as Array<{
    batchId: string;
  }>;
  expect(historyTasks).toHaveLength(1);
  expect(historyTasks[0].batchId).toBe(historyBatchId);

  const currentBatchResponse = await page.request.get(
    `/api/automation/batches?batchId=${currentBatchId}`,
  );
  const currentBatches = (await currentBatchResponse.json()).data as Array<{
    id: string;
    tasks: Array<{ batchId: string }>;
  }>;
  expect(currentBatches).toHaveLength(1);
  expect(currentBatches[0].id).toBe(currentBatchId);
  expect(
    currentBatches[0].tasks.every((task) => task.batchId === currentBatchId),
  ).toBe(true);

  await page.goto(`/tasks?batchId=${currentBatchId}`);
  await expect(
    page.getByRole("heading", { name: "本次任务内容", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("最近全部任务", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("查看本次审核任务中的全部笔记及最新执行状态。", {
      exact: true,
    }),
  ).toBeVisible();

  const executionCard = page.locator(".ant-card").filter({
    has: page.getByRole("heading", { name: "自动审核进度", exact: true }),
  });
  const currentContentCard = page.locator(".ant-card").filter({
    has: page.getByRole("heading", { name: "本次任务内容", exact: true }),
  });
  await expect(
    executionCard.locator(".ant-table-tbody .ant-table-row"),
  ).toHaveCount(2);
  await expect(
    currentContentCard.locator(".ant-table-tbody .ant-table-row"),
  ).toHaveCount(2);
  for (const url of currentUrls) {
    await expect(
      executionCard.getByRole("link", { name: url, exact: true }),
    ).toBeVisible();
    await expect(
      currentContentCard.getByRole("link", { name: url, exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByText(historyUrl, { exact: true })).toHaveCount(0);

  for (const label of [
    "批次名称",
    "所属产品",
    "所属活动",
    "产品阶段话题",
    "任务来源",
    "本次笔记数",
    "审核通过",
    "审核不通过",
    "待人工复核",
    "任务状态",
    "创建时间",
    "完成时间",
  ]) {
    await expect(
      currentContentCard.getByText(label, { exact: true }).first(),
    ).toBeVisible();
  }
  await expect(currentContentCard.getByText("2 条", { exact: true }).first()).toBeVisible();
  await expect(currentContentCard.getByText("IFFO", { exact: true }).first()).toBeVisible();
  await expect(executionCard.locator(".ant-progress")).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`batchId=${currentBatchId}`, "u"));
  await expect(
    page.getByRole("heading", { name: "本次任务内容", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(historyUrl, { exact: true })).toHaveCount(0);
  for (const url of currentUrls) {
    await expect(page.getByText(url, { exact: true }).first()).toBeVisible();
  }
});

test("运行中阻止第二批次，暂停后可创建并汇总筛选", async ({ page }) => {
  test.setTimeout(60_000);
  await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  const products = (
    await (await page.request.get("/api/products")).json()
  ).data as Array<{ id: string; name: string }>;
  const product =
    products.find((item) => item.name.includes("澳洲白金版")) || products[0];
  const campaigns = (
    await (
      await page.request.get(`/api/campaigns?productId=${product.id}`)
    ).json()
  ).data as Array<{ id: string; name: string }>;
  const campaign = campaigns.find((item) =>
    item.name.includes("爱他美2026年7月"),
  ) || campaigns[0];
  const suffix = Date.now();
  const requestBatch = (name: string, count: number, marker: string) =>
    page.request.post("/api/automation/batches", {
      data: {
        name,
        productId: product.id,
        campaignId: campaign.id,
        productStage: "IFFO",
        urls: Array.from(
          { length: count },
          (_, index) =>
            `${E2E_ORIGIN}/mock/xhs?case=passed&autoDelay=2000&${marker}=${suffix}-${index}`,
        ).join("\n"),
        intervalMs: 1000,
      },
    });
  const firstResponse = await requestBatch(
    `德白批次-${suffix}`,
    2,
    "first-batch",
  );
  expect(firstResponse.ok()).toBeTruthy();
  const firstBatchId = (await firstResponse.json()).data.batchId as string;
  cleanupBatchIds.push(firstBatchId);
  const blockedResponse = await requestBatch(
    `澳白批次-${suffix}`,
    3,
    "blocked-second-batch",
  );
  expect(blockedResponse.status()).toBe(409);
  expect((await blockedResponse.json()).error).toContain(
    "当前已有内容平台自动审核任务正在运行",
  );
  await page.request.post(`/api/automation/batches/${firstBatchId}/control`, {
    data: { action: "PAUSE" },
  });
  const secondResponse = await requestBatch(
    `澳白批次-${suffix}`,
    3,
    "second-batch",
  );
  expect(secondResponse.ok()).toBeTruthy();
  const secondBatchId = (await secondResponse.json()).data.batchId as string;
  cleanupBatchIds.push(secondBatchId);
  const batchIds = [firstBatchId, secondBatchId];

  const summary = (
    await (
      await page.request.get(
        `/api/automation/batches?batchIds=${batchIds.join(",")}&includeTasks=false`,
      )
    ).json()
  ).data as Array<{ stats: { total: number }; tasks: unknown[] }>;
  expect(summary.reduce((total, batch) => total + batch.stats.total, 0)).toBe(5);
  expect(summary.every((batch) => batch.tasks.length === 0)).toBe(true);

  const allTasks = (
    await (
      await page.request.get(
        `/api/tasks?batchIds=${batchIds.join(",")}&page=1&pageSize=50`,
      )
    ).json()
  ).data as { items: Array<{ batchId: string }>; total: number };
  expect(allTasks.total).toBe(5);
  expect(new Set(allTasks.items.map((task) => task.batchId))).toEqual(
    new Set(batchIds),
  );

  for (const batchId of batchIds) {
    await page.request.post(`/api/automation/batches/${batchId}/control`, {
      data: { action: "CANCEL" },
    });
  }

  await page.goto(`/tasks?batchIds=${batchIds.join(",")}`);
  await expect(
    page.getByText("当前显示 5 条记录", { exact: true }),
  ).toBeVisible();
  const executionCard = page.locator(".ant-card").filter({
    has: page.getByRole("heading", { name: "自动审核进度", exact: true }),
  });
  await expect(
    executionCard.locator(".ant-table-tbody .ant-table-row"),
  ).toHaveCount(5);

  await page
    .getByText("全部当前批次（2）", { exact: true })
    .click({ force: true });
  await page.getByText(`澳白批次-${suffix}（3 条）`, { exact: true }).click();
  await expect(
    page.getByText("当前显示 3 条记录", { exact: true }),
  ).toBeVisible();
  await expect(
    executionCard.locator(".ant-table-tbody .ant-table-row"),
  ).toHaveCount(3);

  await page.getByRole("button", { name: "筛选处理失败记录" }).click();
  await expect(
    page.getByRole("button", { name: "筛选处理失败记录" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("当前批次暂无处理失败记录", { exact: true }),
  ).toBeVisible();
  const batchSelector = executionCard.locator(".ant-select").filter({
    has: page.getByRole("combobox", { name: "执行记录批次筛选" }),
  });
  await batchSelector.click({ force: true });
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
    .getByText(`德白批次-${suffix}（2 条）`, { exact: true })
    .evaluate((element) => (element as HTMLElement).click());
  await expect(
    page.getByRole("button", { name: "筛选处理失败记录" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("当前批次暂无处理失败记录", { exact: true }),
  ).toBeVisible();
});

test("自动审核进度卡片按执行状态和人工复核状态筛选", async ({ page }) => {
  test.setTimeout(90_000);
  await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  const products = (
    await (await page.request.get("/api/products")).json()
  ).data as Array<{ id: string; name: string }>;
  const product =
    products.find((item) => item.name.includes("澳洲白金版")) || products[0];
  const campaigns = (
    await (
      await page.request.get(`/api/campaigns?productId=${product.id}`)
    ).json()
  ).data as Array<{ id: string; name: string }>;
  const campaign = campaigns.find((item) =>
    item.name.includes("爱他美2026年7月"),
  ) || campaigns[0];
  const suffix = Date.now();
  const urls = {
    succeeded: `${E2E_ORIGIN}/mock/xhs?case=failed&status-filter=${suffix}-success`,
    failed: `${E2E_ORIGIN}/mock/xhs?case=read-failed&status-filter=${suffix}-failed`,
    needsReview: `${E2E_ORIGIN}/mock/xhs?case=no-images&status-filter=${suffix}-review`,
  };
  const response = await page.request.post("/api/automation/batches", {
    data: {
      name: `状态筛选-${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO",
      urls: Object.values(urls).join("\n"),
      intervalMs: 1000,
    },
  });
  expect(response.ok()).toBeTruthy();
  const batchId = (await response.json()).data.batchId as string;
  cleanupBatchIds.push(batchId);

  await expect
    .poll(
      async () => {
        const result = await page.request.get(
          `/api/tasks?batchIds=${batchId}&page=1&pageSize=50`,
        );
        const data = (await result.json()).data as {
          items: Array<{ status: string }>;
        };
        return data.items.map((item) => item.status).sort();
      },
      { timeout: 75_000 },
    )
    .toEqual(["COMPLETED", "COMPLETED", "READ_FAILED"]);

  const loadFilteredTasks = async (executionStatus: string) => {
    const result = await page.request.get(
      `/api/tasks?batchIds=${batchId}&page=1&pageSize=50&executionStatus=${executionStatus}`,
    );
    expect(result.ok()).toBeTruthy();
    return (await result.json()).data as {
      items: Array<{
        status: string;
        url: string;
        auditResults: Array<{ id: string; autoStatus: string }>;
      }>;
      total: number;
    };
  };

  const allTasks = await loadFilteredTasks("ALL");
  expect(allTasks.total).toBe(3);
  const pendingManualResult = allTasks.items.find(
    (item) => item.url === urls.needsReview,
  )?.auditResults[0];
  expect(pendingManualResult).toBeTruthy();
  const manualReviewResponse = await page.request.post(
    `/api/results/${pendingManualResult!.id}/review`,
    { data: { result: "NEEDS_REVIEW", comment: "状态筛选验收" } },
  );
  expect(manualReviewResponse.ok()).toBeTruthy();
  expect((await loadFilteredTasks("WAITING")).total).toBe(0);
  expect((await loadFilteredTasks("PROCESSING")).total).toBe(0);
  const succeeded = await loadFilteredTasks("SUCCEEDED");
  expect(succeeded.total).toBe(2);
  expect(succeeded.items.some((item) => item.url === urls.succeeded)).toBe(true);
  expect(
    succeeded.items.find((item) => item.url === urls.succeeded)?.auditResults[0]
      .autoStatus,
  ).toBe("FAILED");
  const failed = await loadFilteredTasks("FAILED");
  expect(failed.total).toBe(1);
  expect(failed.items[0].url).toBe(urls.failed);
  const needsReview = await loadFilteredTasks("NEEDS_REVIEW");
  expect(needsReview.total).toBe(2);
  expect(new Set(needsReview.items.map((item) => item.url))).toEqual(
    new Set([urls.failed, urls.needsReview]),
  );

  await page.goto(`/tasks?batchId=${batchId}`);
  const executionCard = page.locator(".ant-card").filter({
    has: page.getByRole("heading", { name: "自动审核进度", exact: true }),
  });
  await expect(
    page.getByRole("button", { name: "筛选全部记录" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("当前显示 3 条记录", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "筛选成功记录" }).click();
  await expect(page.getByText("当前显示 2 条记录", { exact: true })).toBeVisible();
  await expect(executionCard.getByRole("link", { name: urls.succeeded })).toBeVisible();
  await expect(
    executionCard.getByText("审核不通过", { exact: true }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "筛选处理失败记录" }).click();
  await expect(page.getByText("当前显示 1 条记录", { exact: true })).toBeVisible();
  await expect(executionCard.getByRole("link", { name: urls.failed })).toBeVisible();

  await page.getByRole("button", { name: "筛选待人工复核记录" }).click();
  await expect(page.getByText("当前显示 2 条记录", { exact: true })).toBeVisible();
  await expect(executionCard.getByRole("link", { name: urls.failed })).toBeVisible();
  await expect(
    executionCard.getByRole("link", { name: urls.needsReview }),
  ).toBeVisible();

  await page.getByRole("button", { name: "筛选等待中记录" }).click();
  await expect(
    page.getByText("当前批次暂无等待中记录", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "筛选全部记录" }).click();
  await expect(page.getByText("当前显示 3 条记录", { exact: true })).toBeVisible();
});

test("300 条任务分片入队且执行记录只读取当前页", async ({ page }) => {
  test.setTimeout(60_000);
  await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  const products = (
    await (await page.request.get("/api/products")).json()
  ).data as Array<{ id: string; name: string }>;
  const product =
    products.find((item) => item.name.includes("澳洲白金版")) || products[0];
  const campaigns = (
    await (
      await page.request.get(`/api/campaigns?productId=${product.id}`)
    ).json()
  ).data as Array<{ id: string; name: string }>;
  const campaign = campaigns.find((item) =>
    item.name.includes("爱他美2026年7月"),
  ) || campaigns[0];
  const suffix = Date.now();
  const response = await page.request.post("/api/automation/batches", {
    data: {
      name: `300条压力验证-${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO",
      urls: Array.from(
        { length: 300 },
        (_, index) =>
          `${E2E_ORIGIN}/mock/xhs?case=passed&stress=${suffix}-${index}`,
      ).join("\n"),
      intervalMs: 1000,
    },
  });
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()).data as {
    batchId: string;
    created: number;
  };
  cleanupBatchIds.push(payload.batchId);
  expect(payload.created).toBe(300);

  const firstPage = (
    await (
      await page.request.get(
        `/api/tasks?batchIds=${payload.batchId}&page=1&pageSize=50`,
      )
    ).json()
  ).data as { items: unknown[]; total: number; pageSize: number };
  expect(firstPage.total).toBe(300);
  expect(firstPage.pageSize).toBe(50);
  expect(firstPage.items).toHaveLength(50);

  await page.request.post(`/api/automation/batches/${payload.batchId}/control`, {
    data: { action: "CANCEL" },
  });

  await page.goto(`/tasks?batchId=${payload.batchId}`);
  await expect(
    page.getByText("当前显示 300 条记录", { exact: true }),
  ).toBeVisible();
  const executionCard = page.locator(".ant-card").filter({
    has: page.getByRole("heading", { name: "自动审核进度", exact: true }),
  });
  await expect(
    executionCard.locator(".ant-table-tbody .ant-table-row"),
  ).toHaveCount(50);
});
