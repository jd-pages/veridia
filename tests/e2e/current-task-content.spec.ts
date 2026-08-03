import { expect, test } from "@playwright/test";
import { E2E_ORIGIN } from "./e2e-origin";

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
