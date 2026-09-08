import { expect, test, type Page } from "@playwright/test";

type ResultListItem = { id: string };
type DetailPayload = {
  id: string;
  task: { orderNumber: string | null };
  [key: string]: unknown;
};
type ControlledOutcome =
  | { type: "SUCCESS"; responseId: string; marker: string }
  | { type: "FAILURE"; message: string };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(response.status()).toBe(200);
}

async function controlledDrawer(page: Page, count = 3) {
  await login(page);
  const listResponse = await page.request.get("/api/results?page=1&pageSize=100");
  expect(listResponse.ok()).toBeTruthy();
  const listPayload = (await listResponse.json()) as {
    data: { items: ResultListItem[] };
  };
  const items = listPayload.data.items.slice(0, count);
  expect(items).toHaveLength(count);

  const details = new Map<string, DetailPayload>();
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const outcomes = new Map<string, ControlledOutcome>();
  const markers = new Map<string, string>();
  for (const [index, item] of items.entries()) {
    const response = await page.request.get(`/api/results/${item.id}`);
    expect(response.ok()).toBeTruthy();
    const payload = (await response.json()) as { data: DetailPayload };
    details.set(item.id, payload.data);
    gates.set(item.id, deferred());
    markers.set(item.id, `A11-DETAIL-${String.fromCharCode(65 + index)}`);
  }

  // Model a transport/mock that ignores AbortSignal so correctness must come
  // from generation and result identity, not cancellation alone.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const pathname = new URL(rawUrl, window.location.origin).pathname;
      if (/^\/api\/results\/[^/]+$/u.test(pathname) && init?.signal) {
        const withoutSignal = { ...init };
        delete withoutSignal.signal;
        return originalFetch(input, withoutSignal);
      }
      return originalFetch(input, init);
    };
  });

  await page.route("**/api/results/*", async (route) => {
    const match = new URL(route.request().url()).pathname.match(
      /^\/api\/results\/([^/]+)$/u,
    );
    if (!match) return route.continue();
    const id = decodeURIComponent(match[1]);
    const gate = gates.get(id);
    const detail = details.get(id);
    if (!gate || !detail) return route.continue();
    await gate.promise;
    const outcome = outcomes.get(id);
    if (!outcome) throw new Error(`缺少 ${id} 的受控响应`);
    if (outcome.type === "FAILURE") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: outcome.message }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: {
          ...detail,
          id: outcome.responseId,
          task: { ...detail.task, orderNumber: outcome.marker },
        },
      }),
    });
  });

  await page.goto("/results?startDate=2020-01-01&endDate=2099-12-31");
  const drawer = page.locator(".ant-drawer-content");
  const open = async (item: ResultListItem) => {
    const button = page
      .locator(`.ant-table-row[data-row-key="${item.id}"]`)
      .getByRole("button", { name: /查看详情/u });
    await expect(button).toBeVisible();
    await button.evaluate((element) => (element as HTMLButtonElement).click());
    await expect(drawer).toBeVisible();
  };
  const succeed = (item: ResultListItem, options?: { responseId?: string; marker?: string }) => {
    outcomes.set(item.id, {
      type: "SUCCESS",
      responseId: options?.responseId ?? item.id,
      marker: options?.marker ?? markers.get(item.id)!,
    });
    gates.get(item.id)!.resolve();
  };
  const fail = (item: ResultListItem, message: string) => {
    outcomes.set(item.id, { type: "FAILURE", message });
    gates.get(item.id)!.resolve();
  };
  return {
    items,
    markers,
    drawer,
    spinner: drawer.locator(".ant-spin-spinning"),
    open,
    close: () => page.locator(".ant-drawer-close").click(),
    succeed,
    fail,
  };
}

test("RESULT_DRAWER_RESPONSE_IDENTITY：A→B 时迟到的 A success 不能覆盖 B", async ({ page }) => {
  const control = await controlledDrawer(page, 2);
  const [a, b] = control.items;
  await control.open(a);
  await control.open(b);
  control.succeed(b);
  await expect(control.drawer.getByText(control.markers.get(b.id)!, { exact: true })).toBeVisible();
  control.succeed(a);
  await expect(control.drawer.getByText(control.markers.get(b.id)!, { exact: true })).toBeVisible();
  await expect(control.drawer.getByText(control.markers.get(a.id)!, { exact: true })).toHaveCount(0);
});

test("关闭 drawer 会使 pending A 失效且迟到 success 不会重新打开", async ({ page }) => {
  const control = await controlledDrawer(page, 1);
  const [a] = control.items;
  await control.open(a);
  await expect(control.spinner).toBeVisible();
  await control.close();
  await expect(control.drawer).toBeHidden();
  control.succeed(a);
  await expect(control.drawer).toBeHidden();
});

test("close → reopen B 后迟到 A success 不能污染 B", async ({ page }) => {
  const control = await controlledDrawer(page, 2);
  const [a, b] = control.items;
  await control.open(a);
  await control.close();
  await control.open(b);
  control.succeed(b);
  await expect(control.drawer.getByText(control.markers.get(b.id)!, { exact: true })).toBeVisible();
  control.succeed(a);
  await expect(control.drawer.getByText(control.markers.get(b.id)!, { exact: true })).toBeVisible();
  await expect(control.drawer.getByText(control.markers.get(a.id)!, { exact: true })).toHaveCount(0);
});

test("A→B→C 任意响应乱序后只允许 C detail", async ({ page }) => {
  const control = await controlledDrawer(page, 3);
  const [a, b, c] = control.items;
  await control.open(a);
  await control.open(b);
  await control.open(c);
  control.succeed(c);
  await expect(control.drawer.getByText(control.markers.get(c.id)!, { exact: true })).toBeVisible();
  control.succeed(a);
  control.succeed(b);
  await expect(control.drawer.getByText(control.markers.get(c.id)!, { exact: true })).toBeVisible();
  await expect(control.drawer.getByText(control.markers.get(a.id)!, { exact: true })).toHaveCount(0);
  await expect(control.drawer.getByText(control.markers.get(b.id)!, { exact: true })).toHaveCount(0);
});

test("stale A failure 不影响 B detail 且不能结束 B loading", async ({ page }) => {
  const control = await controlledDrawer(page, 2);
  const [a, b] = control.items;
  await control.open(a);
  await control.open(b);
  control.fail(a, "A11-STALE-A-FAILURE");
  await expect(control.spinner).toBeVisible();
  await expect(page.getByText("A11-STALE-A-FAILURE", { exact: true })).toHaveCount(0);
  control.succeed(b);
  await expect(control.drawer.getByText(control.markers.get(b.id)!, { exact: true })).toBeVisible();
  await expect(control.spinner).toHaveCount(0);
});

test("当前 B failure 清除旧 A detail 并保留现有错误语义", async ({ page }) => {
  const control = await controlledDrawer(page, 2);
  const [a, b] = control.items;
  await control.open(a);
  control.succeed(a);
  await expect(control.drawer.getByText(control.markers.get(a.id)!, { exact: true })).toBeVisible();
  await control.open(b);
  await expect(control.drawer.getByText(control.markers.get(a.id)!, { exact: true })).toHaveCount(0);
  control.fail(b, "A11-CURRENT-B-FAILURE");
  await expect(page.getByText("A11-CURRENT-B-FAILURE", { exact: true })).toBeVisible();
  await expect(control.drawer.getByText(control.markers.get(a.id)!, { exact: true })).toHaveCount(0);
  await expect(control.spinner).toHaveCount(0);
});

test("当前 payload result ID mismatch 不会被 drawer 接受", async ({ page }) => {
  const control = await controlledDrawer(page, 2);
  const [a, b] = control.items;
  await control.open(a);
  control.succeed(a, { responseId: b.id, marker: "A11-MISMATCH-PAYLOAD" });
  await expect(page.getByText("审核详情响应身份不匹配，请重试", { exact: true })).toBeVisible();
  await expect(control.drawer.getByText("A11-MISMATCH-PAYLOAD", { exact: true })).toHaveCount(0);
  await expect(control.spinner).toHaveCount(0);
});

test("正常当前请求仍渲染对应 drawer detail", async ({ page }) => {
  const control = await controlledDrawer(page, 1);
  const [a] = control.items;
  await control.open(a);
  control.succeed(a);
  await expect(control.drawer.getByText(control.markers.get(a.id)!, { exact: true })).toBeVisible();
  await expect(control.spinner).toHaveCount(0);
});
