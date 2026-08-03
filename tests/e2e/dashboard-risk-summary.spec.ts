import { expect, test, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "./e2e-origin";

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
      { timeout: 45_000 },
    )
    .toMatch(/COMPLETED/u);
}

test("风险摘要只展示三类非零风险并下钻到对应结果", async ({ page }) => {
  const loginResponse = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(loginResponse.ok()).toBeTruthy();

  const products = (await (await page.request.get("/api/products")).json())
    .data as Array<{ id: string; name: string }>;
  const product =
    products.find((item) => item.name.includes("澳洲白金版")) || products[0];
  const campaigns = (
    await (
      await page.request.get(`/api/campaigns?productId=${product.id}`)
    ).json()
  ).data as Array<{ id: string; name: string }>;
  const campaign = campaigns[0];
  const suffix = Date.now();
  const urls = {
    unavailable: `${E2E_ORIGIN}/mock/xhs?case=not-found&dashboard-risk=${suffix}`,
    topic: `${E2E_ORIGIN}/mock/xhs?case=no-topics&dashboard-risk=${suffix}`,
    image: `${E2E_ORIGIN}/mock/xhs?case=few-images&dashboard-risk=${suffix}`,
  };
  const batchResponse = await page.request.post("/api/automation/batches", {
    data: {
      name: `仪表盘风险摘要-${suffix}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO",
      urls: Object.values(urls).join("\n"),
      intervalMs: 1000,
    },
  });
  expect(batchResponse.ok()).toBeTruthy();
  const batchId = (await batchResponse.json()).data.batchId as string;
  await waitForBatch(page, batchId);

  const month = new Date().toISOString().slice(0, 7);
  const startDate = `${month}-01`;
  const endDate = new Date(
    Date.UTC(
      Number(month.slice(0, 4)),
      Number(month.slice(5, 7)),
      0,
    ),
  )
    .toISOString()
    .slice(0, 10);
  const dashboardData = (
    await (await page.request.get(`/api/dashboard?month=${month}`)).json()
  ).data as {
    noteUnavailable: number;
    topicMissing: number;
    imageInsufficient: number;
  };
  const riskResults = async (riskType: string) =>
    (
      await (
        await page.request.get(
          `/api/results?page=1&pageSize=100&startDate=${startDate}&endDate=${endDate}&riskType=${riskType}`,
        )
      ).json()
    ).data as { total: number; items: Array<{ task: { url: string } }> };
  const unavailableResults = await riskResults("NOTE_UNAVAILABLE");
  const topicResults = await riskResults("TOPIC_MISSING");
  const imageResults = await riskResults("IMAGE_INSUFFICIENT");

  expect(dashboardData.noteUnavailable).toBe(unavailableResults.total);
  expect(dashboardData.topicMissing).toBe(topicResults.total);
  expect(dashboardData.imageInsufficient).toBe(imageResults.total);
  expect(unavailableResults.items.some((item) => item.task.url === urls.unavailable)).toBe(true);
  expect(topicResults.items.some((item) => item.task.url === urls.topic)).toBe(true);
  expect(imageResults.items.some((item) => item.task.url === urls.image)).toBe(true);
  expect(topicResults.items.some((item) => item.task.url === urls.unavailable)).toBe(false);
  expect(imageResults.items.some((item) => item.task.url === urls.unavailable)).toBe(false);

  const openRisk = async (
    label: string,
    riskType: string,
    expectedUrl: string,
  ) => {
    await page.goto("/dashboard");
    const summary = page.getByRole("region", { name: "风险摘要" });
    await expect(summary.getByText("读取失败", { exact: true })).toHaveCount(0);
    await expect(
      summary.getByText("蓝色话题异常", { exact: true }),
    ).toHaveCount(0);
    await summary.getByRole("button", { name: new RegExp(label, "u") }).click();
    await expect(page).toHaveURL(new RegExp(`riskType=${riskType}`, "u"));
    await expect(page.getByText(`风险类型：${label}`, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: expectedUrl, exact: true }).first(),
    ).toBeVisible();
  };

  await openRisk("笔记不存在", "NOTE_UNAVAILABLE", urls.unavailable);
  const filterPanel = page.getByRole("region", { name: "审核结果筛选" });
  await filterPanel.getByRole("button", { name: "重置" }).click();
  await expect(page).toHaveURL(/\/results$/u);
  await expect(page.getByText("风险类型：笔记不存在", { exact: true })).toHaveCount(0);

  await openRisk("话题缺失", "TOPIC_MISSING", urls.topic);
  await openRisk("图片不足", "IMAGE_INSUFFICIENT", urls.image);
});
