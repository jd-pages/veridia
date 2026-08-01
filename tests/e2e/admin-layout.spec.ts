import { expect, test, type Page } from "@playwright/test";

const viewports = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
];

async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(response.ok()).toBeTruthy();
}

test("后台侧栏、顶部栏、主内容滚动和折叠布局", async ({ page }) => {
  await login(page);
  const resultsResponse = await page.request.get("/api/results?pageSize=1");
  expect(resultsResponse.ok()).toBeTruthy();
  const results = (await resultsResponse.json()).data.items as Array<{
    id: string;
  }>;
  expect(results.length).toBeGreaterThan(0);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(`/results/${results[0].id}`);
    await expect(page.getByRole("heading", { name: "审核详情" })).toBeVisible();
    await expect(page.getByRole("button", { name: "折叠侧边栏" })).toBeVisible();
    await expect(page.getByText("VERIDIA", { exact: true })).toBeVisible();
    await expect(
      page.getByText("CONTENT GOVERNANCE", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("VERIDIA V-Core")).toHaveCSS("width", "40px");
    for (const label of [
      "仪表盘",
      "审核任务",
      "审核结果",
      "产品管理",
      "活动管理",
      "话题规则",
      "导入记录",
      "系统设置",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    const before = await page.evaluate(() => {
      const sider = document.querySelector(".admin-sider")!;
      const header = document.querySelector(".admin-header")!;
      const main = document.querySelector(".admin-main")!;
      const content = document.querySelector(".admin-content")!;
      const activeMenuItem = document.querySelector(".ant-menu-item-selected")!;
      return {
        scrollHeight: document.documentElement.scrollHeight,
        sider: sider.getBoundingClientRect().toJSON(),
        header: header.getBoundingClientRect().toJSON(),
        main: main.getBoundingClientRect().toJSON(),
        content: content.getBoundingClientRect().toJSON(),
        activeMenuText: activeMenuItem.textContent?.trim(),
        siderOverflow: getComputedStyle(
          document.querySelector(".admin-sider-scroll")!,
        ).overflowY,
      };
    });

    expect(before.scrollHeight).toBeGreaterThan(viewport.height);
    expect(before.sider.left).toBe(0);
    expect(before.sider.top).toBe(0);
    expect(before.sider.height).toBe(viewport.height);
    expect(before.sider.width).toBe(224);
    expect(before.header.left).toBe(224);
    expect(before.header.top).toBe(0);
    expect(before.header.height).toBe(64);
    expect(before.main.left).toBe(224);
    expect(before.content.top).toBeGreaterThanOrEqual(64);
    expect(before.siderOverflow).toBe("auto");
    expect(before.activeMenuText).toBe("审核结果");

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);

    const afterScroll = await page.evaluate(() => ({
      scrollY: window.scrollY,
      siderTop: document
        .querySelector(".admin-sider")!
        .getBoundingClientRect().top,
      headerTop: document
        .querySelector(".admin-header")!
        .getBoundingClientRect().top,
      activeMenuText: document
        .querySelector(".ant-menu-item-selected")!
        .textContent?.trim(),
    }));
    expect(afterScroll.scrollY).toBeGreaterThan(0);
    expect(afterScroll.siderTop).toBe(0);
    expect(afterScroll.headerTop).toBe(0);
    expect(afterScroll.activeMenuText).toBe("审核结果");

    await page.getByRole("button", { name: "折叠侧边栏" }).click();
    await expect(page.getByRole("button", { name: "展开侧边栏" })).toBeVisible();
    await expect(page.getByText("VERIDIA", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("VERIDIA V-Core")).toBeVisible();
    await page.waitForTimeout(250);

    const collapsed = await page.evaluate(() => {
      const sider = document.querySelector(".admin-sider")!;
      const header = document.querySelector(".admin-header")!;
      const main = document.querySelector(".admin-main")!;
      return {
        sider: sider.getBoundingClientRect().toJSON(),
        header: header.getBoundingClientRect().toJSON(),
        main: main.getBoundingClientRect().toJSON(),
        selectedCount: document.querySelectorAll(".ant-menu-item-selected")
          .length,
      };
    });
    expect(collapsed.sider.width).toBe(72);
    expect(collapsed.header.left).toBe(72);
    expect(collapsed.main.left).toBe(72);
    expect(collapsed.selectedCount).toBe(1);
  }
});
