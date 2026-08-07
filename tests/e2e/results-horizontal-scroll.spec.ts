import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(response.ok()).toBeTruthy();
}

async function floatingScrollbarLayout(page: Page) {
  return page.evaluate(() => {
    const table = document.querySelector<HTMLElement>(".ant-table-body");
    const floating = document.querySelector<HTMLElement>(
      '[data-testid="results-floating-scrollbar"]',
    );
    if (!table) {
      return { matches: false, overflows: false, shouldFloat: false };
    }
    const rect = table.getBoundingClientRect();
    const overflows = table.scrollWidth - table.clientWidth > 1;
    const nativeScrollbarInView = rect.bottom <= window.innerHeight + 12;
    const intersectsViewport =
      rect.top < window.innerHeight - 8 && rect.bottom > 72;
    const shouldFloat =
      overflows && intersectsViewport && !nativeScrollbarInView;
    return {
      matches: Boolean(floating) === shouldFloat,
      overflows,
      shouldFloat,
    };
  });
}

test("审核结果表格悬浮横向滚动、固定列和重算", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/results");
  await expect(
    page.getByRole("heading", { name: "审核结果", exact: true }),
  ).toBeVisible();

  const tableBody = page.locator(".ant-table-body");
  const stickyScroll = page.getByTestId("results-floating-scrollbar");
  const stickyThumb = page.getByTestId("results-floating-scrollbar-thumb");
  const detailsButton = page.getByRole("button", { name: /查看详情/u }).first();
  const moreButton = page.getByRole("button", { name: "更多操作" }).first();

  await expect(detailsButton).toBeVisible();
  await expect(moreButton).toBeVisible();
  const actionLayout = await page.evaluate(() => {
    const table = document.querySelector<HTMLElement>(".ant-table-body");
    const action = document.querySelector<HTMLElement>(
      "th.ant-table-cell-fix-right-first",
    );
    const details = document.querySelector<HTMLElement>(
      "button[class*='primaryAction']",
    );
    const more = document.querySelector<HTMLElement>(
      'button[aria-label="更多操作"]',
    );
    const tableRect = table?.getBoundingClientRect();
    return {
      tableRight: tableRect?.right,
      actionRight: action?.getBoundingClientRect().right,
      detailsRight: details?.getBoundingClientRect().right,
      moreRight: more?.getBoundingClientRect().right,
    };
  });
  expect(actionLayout.actionRight).toBeLessThanOrEqual(
    actionLayout.tableRight! + 1,
  );
  expect(actionLayout.detailsRight).toBeLessThanOrEqual(
    actionLayout.tableRight! + 1,
  );
  expect(actionLayout.moreRight).toBeLessThanOrEqual(
    actionLayout.tableRight! + 1,
  );

  const columnWidths = await page.evaluate(() => {
    const widthFor = (title: string) => {
      const cell = [...document.querySelectorAll<HTMLElement>("th")].find(
        (candidate) => candidate.textContent?.trim() === title,
      );
      return cell?.getBoundingClientRect().width;
    };
    return {
      ownership: widthFor("归属信息"),
      topics: widthFor("话题审核"),
      images: widthFor("图片"),
      conclusion: widthFor("审核结论"),
      actions: widthFor("操作"),
    };
  });
  expect(columnWidths.ownership).toBeCloseTo(240, 0);
  expect(columnWidths.topics).toBeCloseTo(180, 0);
  expect(columnWidths.images).toBeCloseTo(120, 0);
  expect(columnWidths.conclusion).toBeCloseTo(250, 0);
  expect(columnWidths.actions).toBeCloseTo(160, 0);

  await tableBody.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const overflow = await tableBody.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(overflow).toBeGreaterThan(0);
  await expect(stickyScroll).toBeVisible();

  const initialThumbBox = await stickyThumb.boundingBox();
  expect(initialThumbBox).not.toBeNull();
  const scrollTarget = Math.min(300, overflow);
  await tableBody.evaluate(async (element, target) => {
    element.scrollTo({ left: target, behavior: "instant" });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, scrollTarget);
  await expect
    .poll(() => tableBody.evaluate((element) => element.scrollLeft))
    .toBe(scrollTarget);
  await expect
    .poll(async () => (await stickyThumb.boundingBox())?.x ?? 0)
    .toBeGreaterThan(initialThumbBox!.x + 1);

  const thumbBox = await stickyThumb.boundingBox();
  expect(thumbBox).not.toBeNull();
  const beforeDrag = await tableBody.evaluate((element) => element.scrollLeft);
  await stickyThumb.hover();
  await page.mouse.move(
    thumbBox!.x + thumbBox!.width / 2,
    thumbBox!.y + thumbBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    thumbBox!.x + thumbBox!.width / 2 - 120,
    thumbBox!.y + thumbBox!.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(() => tableBody.evaluate((element) => element.scrollLeft))
    .toBeLessThan(beforeDrag);

  const fixedColumns = await page.evaluate(() => {
    const left = document.querySelector("th.ant-table-cell-fix-left-last");
    const right = document.querySelector("th.ant-table-cell-fix-right-first");
    return {
      leftPosition: left ? getComputedStyle(left).position : "",
      rightPosition: right ? getComputedStyle(right).position : "",
      leftRect: left?.getBoundingClientRect().toJSON(),
      rightRect: right?.getBoundingClientRect().toJSON(),
    };
  });
  expect(fixedColumns.leftPosition).toBe("sticky");
  expect(fixedColumns.rightPosition).toBe("sticky");
  expect(fixedColumns.leftRect!.right).toBeLessThan(
    fixedColumns.rightRect!.left,
  );
  await expect(detailsButton).toBeVisible();
  await expect(moreButton).toBeVisible();

  await tableBody.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await expect(stickyScroll).toBeVisible();

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect
    .poll(async () => (await floatingScrollbarLayout(page)).matches)
    .toBe(true);
  expect((await floatingScrollbarLayout(page)).shouldFloat).toBe(false);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: /高级筛选/ }).click();
  const reasonFilter = page.getByRole("textbox", {
    name: "不通过原因",
    exact: true,
  });
  await reasonFilter.fill("图片数量不足");
  await page.getByRole("button", { name: /查询/ }).click();
  await expect(
    page.locator(".ant-empty-description, .ant-pagination-total-text").first(),
  ).toBeVisible();
  await tableBody.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  // 行数和 CI 视口会影响原生滚动条是否进入视口；只验证悬浮条与实时布局规则一致。
  await expect
    .poll(async () => (await floatingScrollbarLayout(page)).matches)
    .toBe(true);
  expect((await floatingScrollbarLayout(page)).overflows).toBe(true);

  await reasonFilter
    .locator("xpath=..")
    .getByRole("button", { name: "close-circle", exact: true })
    .click();
  await page.getByRole("button", { name: /查询/ }).click();
  const pageTwo = page.locator(".ant-pagination-item-2");
  if (await pageTwo.isVisible()) {
    await pageTwo.click();
    await expect(page.locator(".ant-pagination-item-active")).toHaveText("2");
  }
  await tableBody.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await expect
    .poll(async () => (await floatingScrollbarLayout(page)).matches)
    .toBe(true);
  expect((await floatingScrollbarLayout(page)).overflows).toBe(true);

  await page.setViewportSize({ width: 1920, height: 1080 });
  const wideLayout = await page.evaluate(() => ({
    pageOverflows:
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
    stickyWidth: document
      .querySelector('[data-testid="results-floating-scrollbar"]')
      ?.getBoundingClientRect().width,
    tableWidth: document
      .querySelector(".ant-table-body")
      ?.getBoundingClientRect().width,
  }));
  expect(wideLayout.pageOverflows).toBe(false);
  if (wideLayout.stickyWidth !== undefined) {
    expect(wideLayout.stickyWidth).toBe(wideLayout.tableWidth);
  }
});
