import { expect, test, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "./e2e-origin";
import { cleanupAutomaticBatches } from "./automation-cleanup";

const cleanupBatchIds: string[] = [];

test.afterEach(async ({ page }) => {
  try {
    await cleanupAutomaticBatches(page, cleanupBatchIds);
  } finally {
    cleanupBatchIds.length = 0;
  }
});

async function waitForBatch(page: Page, batchId: string) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/automation/batches?batchId=${batchId}`,
        );
        const batches = (await response.json()).data as Array<{
          status: string;
        }>;
        return batches[0]?.status;
      },
      { timeout: 90_000 },
    )
    .toMatch(
      /^(?:COMPLETED|COMPLETED_WITH_ERRORS|LOGIN_EXPIRED|SECURITY_RESTRICTED)$/u,
    );
  const response = await page.request.get(
    `/api/automation/batches?batchId=${batchId}`,
  );
  const status = ((await response.json()).data as Array<{ status: string }>)[0]
    ?.status;
  expect(status).toMatch(/^(?:COMPLETED|COMPLETED_WITH_ERRORS)$/u);
}

test("连续审核与网络重试复用唯一后台 auditPage", async ({ page }) => {
  test.setTimeout(150_000);
  const loginResponse = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(loginResponse.ok()).toBeTruthy();

  const diagnosticsBefore = (
    await (await page.request.get("/api/automation/session")).json()
  ).data as {
    browserInstanceCount: number;
    contextLaunchCount: number;
    pageCount: number;
    auditPageOpen: boolean;
    auditPageCreateCount: number;
    auditPageReuseCount: number;
    auditPageRequestCount: number;
    pageSummaries: Array<Record<string, unknown>>;
  };
  console.info(
    `[AUDIT_PAGE_REUSE_DIAGNOSTICS] before=${JSON.stringify(diagnosticsBefore)}`,
  );

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

  const fiveUrls = Array.from(
    { length: 5 },
    (_, index) =>
      `${E2E_ORIGIN}/mock/xhs?case=aptamil-stage2-passed&audit-page=${suffix}-${index}`,
  );
  const batchResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: `后台单页复用-${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO",
      urls: fiveUrls.join("\n"),
      intervalMs: 1000,
    },
  });
  const batchPayload = await batchResponse.json();
  expect(
    batchResponse.ok(),
    `batch create failed: ${batchResponse.status()} ${JSON.stringify(batchPayload)}`,
  ).toBeTruthy();
  const batchId = batchPayload.data.batchId as string;
  cleanupBatchIds.push(batchId);
  await waitForBatch(page, batchId);

  const batch = (
    await (
      await page.request.get(`/api/automation/batches?batchId=${batchId}`)
    ).json()
  ).data[0] as {
    tasks: Array<{ status: string; finalUrl: string | null }>;
  };
  expect(batch.tasks).toHaveLength(5);
  expect(batch.tasks.every((task) => task.status === "COMPLETED")).toBe(true);
  expect(batch.tasks.every((task) => Boolean(task.finalUrl))).toBe(true);

  const diagnosticsAfterFive = (
    await (await page.request.get("/api/automation/session")).json()
  ).data as {
    browserInstanceCount: number;
    contextLaunchCount: number;
    pageCount: number;
    auditPageOpen: boolean;
    auditPageCreateCount: number;
    auditPageReuseCount: number;
    auditPageRequestCount: number;
    interactivePageOpen: boolean;
    windowState: string;
    controlState: string;
    controlReady: boolean;
    pageSummaries: Array<Record<string, unknown>>;
  };
  console.info(
    `[AUDIT_PAGE_REUSE_DIAGNOSTICS] afterFive=${JSON.stringify(diagnosticsAfterFive)}`,
  );
  expect(diagnosticsAfterFive).toMatchObject({
    browserInstanceCount: 1,
    pageCount: 1,
    auditPageOpen: true,
    interactivePageOpen: false,
    windowState: "minimized",
    controlState: "READY",
    controlReady: true,
  });
  expect(diagnosticsAfterFive.contextLaunchCount).toBe(
    diagnosticsBefore.contextLaunchCount +
      (diagnosticsBefore.browserInstanceCount === 0 ? 1 : 0),
  );
  expect(diagnosticsAfterFive.auditPageCreateCount).toBe(
    diagnosticsBefore.auditPageCreateCount +
      (diagnosticsBefore.auditPageOpen ? 0 : 1),
  );
  expect(diagnosticsAfterFive.auditPageRequestCount).toBe(
    diagnosticsBefore.auditPageRequestCount + 5,
  );
  expect(diagnosticsAfterFive.auditPageReuseCount).toBeGreaterThanOrEqual(
    diagnosticsBefore.auditPageReuseCount + 4,
  );

  const closeAuditPage = await page.request.post("/api/automation/session", {
    data: { action: "CLOSE_AUDIT_PAGE_FOR_TEST" },
  });
  expect(closeAuditPage.ok()).toBeTruthy();
  const afterClose = (await closeAuditPage.json()).data as typeof diagnosticsAfterFive;
  expect(afterClose.auditPageOpen).toBe(false);

  const secondBatchResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: `关闭页面后重建-${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO",
      urls: Array.from(
        { length: 5 },
        (_, index) =>
          `${E2E_ORIGIN}/mock/xhs?case=aptamil-stage2-passed&audit-page-rebuild=${suffix}-${index}`,
      ).join("\n"),
      intervalMs: 1000,
    },
  });
  expect(secondBatchResponse.ok()).toBeTruthy();
  const secondBatchId = (await secondBatchResponse.json()).data.batchId as string;
  cleanupBatchIds.push(secondBatchId);
  await waitForBatch(page, secondBatchId);
  const diagnosticsAfterRebuild = (
    await (await page.request.get("/api/automation/session")).json()
  ).data as typeof diagnosticsAfterFive;
  expect(diagnosticsAfterRebuild.contextLaunchCount).toBe(
    diagnosticsAfterFive.contextLaunchCount,
  );
  expect(diagnosticsAfterRebuild.auditPageCreateCount).toBe(
    diagnosticsAfterFive.auditPageCreateCount + 1,
  );
  expect(diagnosticsAfterRebuild.controlReady).toBe(true);

  const retryResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: `后台重试复用-${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO",
      urls: `${E2E_ORIGIN}/mock/xhs?case=passed&simulate=network-error&audit-retry=${suffix}`,
      intervalMs: 1000,
    },
  });
  expect(retryResponse.ok()).toBeTruthy();
  const retryBatchId = (await retryResponse.json()).data.batchId as string;
  cleanupBatchIds.push(retryBatchId);
  await waitForBatch(page, retryBatchId);

  const diagnosticsAfterRetry = (
    await (await page.request.get("/api/automation/session")).json()
  ).data as typeof diagnosticsAfterFive;
  expect(diagnosticsAfterRetry.auditPageCreateCount).toBe(
    diagnosticsAfterRebuild.auditPageCreateCount,
  );
  expect(diagnosticsAfterRetry.auditPageRequestCount).toBe(
    diagnosticsAfterRebuild.auditPageRequestCount + 3,
  );
  expect(diagnosticsAfterRetry.pageCount).toBe(1);
  expect(diagnosticsAfterRetry.interactivePageOpen).toBe(false);
  expect(diagnosticsAfterRetry.windowState).toBe("minimized");

  const notFoundResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: `后台识别页面不存在-${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO",
      urls: `${E2E_ORIGIN}/mock/xhs?case=not-found&audit-not-found=${suffix}`,
      intervalMs: 1000,
    },
  });
  expect(notFoundResponse.ok()).toBeTruthy();
  const notFoundBatchId = (await notFoundResponse.json()).data.batchId as string;
  cleanupBatchIds.push(notFoundBatchId);
  await waitForBatch(page, notFoundBatchId);

  const diagnosticsAfterNotFound = (
    await (await page.request.get("/api/automation/session")).json()
  ).data as typeof diagnosticsAfterFive;
  expect(diagnosticsAfterNotFound.auditPageCreateCount).toBe(
    diagnosticsAfterRebuild.auditPageCreateCount,
  );
  expect(diagnosticsAfterNotFound.auditPageRequestCount).toBe(
    diagnosticsAfterRetry.auditPageRequestCount + 1,
  );
  expect(diagnosticsAfterNotFound.pageCount).toBe(1);
  expect(diagnosticsAfterNotFound.interactivePageOpen).toBe(false);
  expect(diagnosticsAfterNotFound.windowState).toBe("minimized");
});
