import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import path from "node:path";
import { E2E_ORIGIN } from "./e2e-origin";

const databaseUrl =
  process.env.E2E_DATABASE_URL?.trim() ||
  `file:${path.resolve(process.cwd(), "prisma", "e2e.db").replaceAll("\\", "/")}`;

async function waitForBatchToStop(page: Page, batchId: string) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/automation/batches?batchId=${batchId}&includeTasks=false`,
        );
        const batches = (await response.json()).data as Array<{ status: string }>;
        return batches[0]?.status;
      },
      { timeout: 60_000 },
    )
    .toMatch(/^(?:COMPLETED|COMPLETED_WITH_ERRORS)$/u);
}

async function clearVisibleE2eBatches(page: Page) {
  const response = await page.request.get(
    "/api/automation/batches?includeTasks=false",
  );
  const batches = (await response.json()).data as Array<{
    id: string;
    status: string;
  }>;
  const clearable = new Set([
    "COMPLETED",
    "COMPLETED_WITH_ERRORS",
    "FAILED",
    "READ_FAILED",
    "CANCELLED",
    "PAUSED",
    "LOGIN_EXPIRED",
    "SECURITY_RESTRICTED",
  ]);
  for (const batch of batches) {
    if (!clearable.has(batch.status)) {
      await page.request.post(`/api/automation/batches/${batch.id}/control`, {
        data: { action: "CANCEL" },
      });
      await expect
        .poll(async () => {
          const current = await page.request.get(
            `/api/automation/batches?batchId=${batch.id}&includeTasks=false`,
          );
          return ((await current.json()).data as Array<{ status: string }>)[0]
            ?.status;
        })
        .toBe("CANCELLED");
    }
    const clearResponse = await page.request.post(
      `/api/automation/batches/${batch.id}/clear`,
    );
    expect(clearResponse.ok()).toBeTruthy();
  }
}

test("旧版遗留 RUNNING/PROCESSING 无 Runner 可从页面直接清除并释放重复占用", async ({ page }) => {
  expect((await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  })).ok()).toBeTruthy();
  await clearVisibleE2eBatches(page);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const suffix = Date.now();
  const recreatedTaskIds: string[] = [];
  try {
    const product = await prisma.product.findFirstOrThrow({
      where: { name: { contains: "澳洲白金版" }, status: "ACTIVE" },
    });
    const campaign = await prisma.campaign.findFirstOrThrow({
      where: {
        name: { contains: "爱他美2026年7月" },
        contentChannel: "XIAOHONGSHU",
        OR: [
          { productId: product.id },
          { products: { some: { productId: product.id } } },
        ],
      },
    });
    const url = `${E2E_ORIGIN}/mock/xhs?case=passed&stale=${suffix}`;
    const batch = await prisma.auditBatch.create({
      data: {
        name: `遗留僵尸批次-${suffix}`,
        productId: product.id,
        campaignId: campaign.id,
        productStage: "IFFO",
        source: "EXCEL",
        channel: "XIAOHONGSHU",
        status: "RUNNING",
        totalCount: 1,
      },
    });
    const task = await prisma.auditTask.create({
      data: {
        batchId: batch.id,
        url,
        normalizedUrl: url,
        productId: product.id,
        campaignId: campaign.id,
        productStage: "IFFO",
        source: "EXCEL",
        status: "PROCESSING",
        platform: "XIAOHONGSHU",
        channel: "XIAOHONGSHU",
      },
    });
    await prisma.auditBatch.update({
      where: { id: batch.id },
      data: { currentTaskId: task.id },
    });

    await page.goto(`/tasks?batchId=${batch.id}`);
    await expect(page.getByText(batch.name!, { exact: false }).first()).toBeVisible();
    await page.getByRole("button", { name: "清除当前批次" }).click();
    await page.getByRole("button", { name: "确认清除", exact: true }).click();
    await expect(page.getByText("暂无审核任务", { exact: true }).first()).toBeVisible();

    expect(await prisma.auditBatch.findUnique({ where: { id: batch.id } })).toMatchObject({
      status: "CANCELLED",
      currentTaskId: null,
      lastErrorCode: "STALE_BATCH_RECOVERY",
      clearedAt: expect.any(Date),
    });
    expect(await prisma.auditTask.findUnique({ where: { id: task.id } })).toMatchObject({
      status: "CANCELLED",
      failureCode: "STALE_BATCH_RECOVERY",
    });

    const reimport = await page.request.post("/api/tasks", {
      data: {
        urls: url,
        productId: product.id,
        campaignId: campaign.id,
        productStage: "IFFO",
      },
    });
    expect(reimport.ok()).toBeTruthy();
    const reimportPayload = (await reimport.json()).data as {
      created: Array<{ id: string }>;
    };
    expect(reimportPayload.created).toHaveLength(1);
    recreatedTaskIds.push(...reimportPayload.created.map(({ id }) => id));

    const repeatedClear = await page.request.post(
      `/api/automation/batches/${batch.id}/clear`,
    );
    expect(repeatedClear.ok()).toBeTruthy();
    expect((await repeatedClear.json()).data.alreadyCleared).toBe(true);
  } finally {
    await prisma.auditTask.deleteMany({
      where: { id: { in: recreatedTaskIds } },
    });
    await prisma.$disconnect();
  }
});

test("清除当前批次仅移出任务页并保留正式审核结果", async ({ page }) => {
  test.setTimeout(180_000);
  const loginResponse = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(loginResponse.ok()).toBeTruthy();
  await clearVisibleE2eBatches(page);

  const products = (
    await (await page.request.get("/api/products")).json()
  ).data as Array<{ id: string; name: string }>;
  const product =
    products.find((item) => item.name.includes("澳洲白金版")) || products[0];
  const campaigns = (
    await (
      await page.request.get(
        `/api/campaigns?productId=${product.id}&contentChannel=XIAOHONGSHU`,
      )
    ).json()
  ).data as Array<{ id: string; name: string }>;
  const campaign = campaigns.find((item) =>
    item.name.includes("爱他美2026年7月"),
  ) || campaigns[0];
  const suffix = Date.now();

  const createBatch = async (name: string, url: string) => {
    const response = await page.request.post("/api/automation/batches", {
      data: {
        name,
        productId: product.id,
        campaignId: campaign.id,
        productStage: "IFFO",
        urls: url,
        intervalMs: 1000,
      },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).data.batchId as string;
  };

  const historyName = `待切换历史批次-${suffix}`;
  const historyBatchId = await createBatch(
    historyName,
    `${E2E_ORIGIN}/mock/xhs?case=passed&clear-history=${suffix}`,
  );
  await page.request.post(`/api/automation/batches/${historyBatchId}/control`, {
    data: { action: "CANCEL" },
  });

  const targetName = `待清除批次-${suffix}`;
  const targetBatchId = await createBatch(
    targetName,
    `${E2E_ORIGIN}/mock/xhs?case=aptamil-stage2-passed&clear-target=${suffix}`,
  );
  await waitForBatchToStop(page, targetBatchId);
  const resultBeforeClear = (
    await (
      await page.request.get(`/api/results?batchId=${targetBatchId}`)
    ).json()
  ).data as { total: number; items: Array<{ id: string }> };
  expect(resultBeforeClear.total).toBe(1);
  const retainedResultId = resultBeforeClear.items[0].id;

  await page.goto(`/tasks?batchId=${targetBatchId}`);
  await expect(page.getByText(targetName, { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "清除当前批次" }).click();
  await expect(page.getByText("清除当前批次？", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "清除后，该批次的审核进度、执行记录和任务内容将从审核任务页面移除。此操作不可撤销。",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "清除当前批次？" })
    .getByRole("button", { name: /取\s*消/u })
    .click();
  await expect(page.getByText(targetName, { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "清除当前批次" }).click();
  const clearResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/automation/batches/${targetBatchId}/clear`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "确认清除", exact: true }).click();
  const clearResponse = await clearResponsePromise;
  expect(clearResponse.ok()).toBeTruthy();
  const clearResult = (await clearResponse.json()).data as {
    clearedBatchId: string;
    clearedTaskCount: number;
    retainedAuditResultCount: number;
    nextBatchId: string | null;
    alreadyCleared: boolean;
  };
  expect(clearResult).toMatchObject({
    clearedBatchId: targetBatchId,
    clearedTaskCount: 1,
    retainedAuditResultCount: 1,
    nextBatchId: historyBatchId,
    alreadyCleared: false,
  });
  await expect(page.getByText(historyName, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(targetName, { exact: false })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "筛选全部记录" }),
  ).toHaveAttribute("aria-pressed", "true");

  const hiddenBatch = (
    await (
      await page.request.get(
        `/api/automation/batches?batchId=${targetBatchId}&includeTasks=false`,
      )
    ).json()
  ).data as unknown[];
  expect(hiddenBatch).toHaveLength(0);
  const hiddenTasks = (
    await (
      await page.request.get(
        `/api/tasks?batchIds=${targetBatchId}&page=1&pageSize=50`,
      )
    ).json()
  ).data as { total: number };
  expect(hiddenTasks.total).toBe(0);
  const resultAfterClear = (
    await (
      await page.request.get(`/api/results?batchId=${targetBatchId}`)
    ).json()
  ).data as { total: number };
  expect(resultAfterClear.total).toBe(1);
  expect((await page.request.get(`/api/results/${retainedResultId}`)).ok()).toBe(
    true,
  );
  const repeatedClear = await page.request.post(
    `/api/automation/batches/${targetBatchId}/clear`,
  );
  expect(repeatedClear.ok()).toBeTruthy();
  expect((await repeatedClear.json()).data).toMatchObject({
    clearedBatchId: targetBatchId,
    nextBatchId: historyBatchId,
    alreadyCleared: true,
  });

  await page.getByRole("button", { name: "清除当前批次" }).click();
  await page.getByRole("button", { name: "确认清除", exact: true }).click();
  await expect(
    page.getByText("暂无审核任务", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("创建审核任务后，审核进度和执行记录将在这里显示。", {
      exact: true,
    }).first(),
  ).toBeVisible();
  const statusCards = page.locator('button[aria-label^="筛选"][aria-label$="记录"]');
  await expect(statusCards).toHaveCount(6);
  await expect(statusCards.locator("strong")).toHaveText(["0", "0", "0", "0", "0", "0"]);
  await expect(page.getByLabel("执行记录批次筛选")).toHaveCount(0);
  await expect(
    page.getByText("对应审核结果已删除，可重新提交审核", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText("暂无审核任务", { exact: true }).first(),
  ).toBeVisible();
  await expect(statusCards.locator("strong")).toHaveText(["0", "0", "0", "0", "0", "0"]);
  await expect(page.getByText(targetName, { exact: false })).toHaveCount(0);
  await expect(page.getByText(historyName, { exact: false })).toHaveCount(0);

  const deletedResultBatchName = `结果已删除后清除-${suffix}`;
  const deletedResultBatchId = await createBatch(
    deletedResultBatchName,
    `${E2E_ORIGIN}/mock/xhs?case=read-failed&clear-deleted-result=${suffix}`,
  );
  await waitForBatchToStop(page, deletedResultBatchId);
  const deletedResultBeforeClear = (
    await (
      await page.request.get(`/api/results?batchId=${deletedResultBatchId}`)
    ).json()
  ).data as { total: number; items: Array<{ id: string }> };
  expect(deletedResultBeforeClear.total).toBe(1);
  const deleteResultResponse = await page.request.delete(
    `/api/results/${deletedResultBeforeClear.items[0].id}`,
  );
  expect(deleteResultResponse.ok()).toBeTruthy();

  await page.goto(`/tasks?batchId=${deletedResultBatchId}`);
  await expect(
    page.getByText("对应审核结果已删除，可重新提交审核", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除当前批次" }).click();
  await page.getByRole("button", { name: "确认清除", exact: true }).click();
  await expect(
    page.getByText("暂无审核任务", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(deletedResultBatchName, { exact: false })).toHaveCount(0);
  await expect(
    page.getByText("对应审核结果已删除，可重新提交审核", { exact: true }),
  ).toHaveCount(0);
  const hiddenDeletedResultTasks = (
    await (
      await page.request.get(
        `/api/tasks?batchIds=${deletedResultBatchId}&page=1&pageSize=50`,
      )
    ).json()
  ).data as { total: number };
  expect(hiddenDeletedResultTasks.total).toBe(0);
  await page.reload();
  await expect(
    page.getByText("暂无审核任务", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(deletedResultBatchName, { exact: false })).toHaveCount(0);
  await expect(
    page.getByText("对应审核结果已删除，可重新提交审核", { exact: true }),
  ).toHaveCount(0);

  const runningBatchId = await createBatch(
    `运行中不可清除-${suffix}`,
    `${E2E_ORIGIN}/mock/xhs?case=passed&autoDelay=5000&clear-running=${suffix}`,
  );
  await page.goto(`/tasks?batchId=${runningBatchId}`);
  await page.getByRole("button", { name: "清除当前批次" }).click();
  await page.getByRole("button", { name: "确认清除", exact: true }).click();
  await expect(
    page.getByText("当前批次正在执行，请先取消任务后再清除。", {
      exact: true,
    }),
  ).toBeVisible();
  const blockedClear = await page.request.post(
    `/api/automation/batches/${runningBatchId}/clear`,
  );
  expect(blockedClear.status()).toBe(409);
  expect((await blockedClear.json()).errorDetail.code).toBe(
    "BATCH_STILL_RUNNING",
  );
  await page.request.post(`/api/automation/batches/${runningBatchId}/control`, {
    data: { action: "CANCEL" },
  });
});
