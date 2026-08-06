import { expect, test, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "./e2e-origin";

async function waitForCompletedBatch(page: Page, batchId: string) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/automation/batches?batchId=${batchId}`,
        );
        return (await response.json()).data?.[0]?.status;
      },
      { timeout: 420_000 },
    )
    .toMatch(/^(?:COMPLETED|COMPLETED_WITH_ERRORS)$/u);
}

test("连续两批300条及第三批100条复用或重建标准auditPage", async ({
  page,
}) => {
  test.setTimeout(1_200_000);
  await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  const products = (await (await page.request.get("/api/products")).json())
    .data as Array<{ id: string; name: string }>;
  const product =
    products.find((item) => item.name.includes("澳洲白金版")) || products[0];
  const campaigns = (
    await (await page.request.get(`/api/campaigns?productId=${product.id}`)).json()
  ).data as Array<{ id: string; name: string }>;
  const campaign =
    campaigns.find((item) => item.name.includes("爱他美2026年7月")) ||
    campaigns[0];
  const suffix = Date.now();
  const batchIds: string[] = [];

  const runBatch = async (batchNumber: number, count: number) => {
    const response = await page.request.post("/api/automation/batches", {
      data: {
        name: `浏览器生命周期压力-${batchNumber}-${suffix}`,
        productId: product.id,
        campaignId: campaign.id,
        productStage: "IFFO",
        urls: Array.from(
          { length: count },
          (_, index) =>
            `${E2E_ORIGIN}/mock/xhs?case=passed&browser-lifecycle=${suffix}-${batchNumber}-${index}`,
        ).join("\n"),
        intervalMs: 1000,
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const batchId = (await response.json()).data.batchId as string;
    batchIds.push(batchId);
    await waitForCompletedBatch(page, batchId);
    const batch = (
      await (
        await page.request.get(`/api/automation/batches?batchId=${batchId}`)
      ).json()
    ).data[0] as { tasks: Array<{ status: string }> };
    expect(batch.tasks).toHaveLength(count);
    expect(batch.tasks.every((task) => task.status === "COMPLETED")).toBe(true);
  };

  try {
    await runBatch(1, 300);
    const afterFirst = (
      await (await page.request.get("/api/automation/session")).json()
    ).data;
    await runBatch(2, 300);
    const afterSecond = (
      await (await page.request.get("/api/automation/session")).json()
    ).data;
    expect(afterSecond.contextLaunchCount).toBe(afterFirst.contextLaunchCount);
    expect(afterSecond.auditPageCreateCount).toBe(afterFirst.auditPageCreateCount);
    expect(afterSecond.controlReady).toBe(true);

    const closeResponse = await page.request.post("/api/automation/session", {
      data: { action: "CLOSE_AUDIT_PAGE_FOR_TEST" },
    });
    expect(closeResponse.ok()).toBeTruthy();
    await runBatch(3, 100);
    const afterThird = (
      await (await page.request.get("/api/automation/session")).json()
    ).data;
    expect(afterThird.contextLaunchCount).toBe(afterSecond.contextLaunchCount);
    expect(afterThird.auditPageCreateCount).toBe(
      afterSecond.auditPageCreateCount + 1,
    );
    expect(afterThird.controlReady).toBe(true);
  } finally {
    for (const batchId of batchIds.reverse()) {
      await page.request
        .post(`/api/automation/batches/${batchId}/clear`)
        .catch(() => undefined);
    }
  }
});
