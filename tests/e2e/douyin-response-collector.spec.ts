import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { createDouyinResponseCollector } from "../../lib/automation/douyin-response-collector";

let server: Server;
let origin: string;
const hungResponses = new Set<ServerResponse>();
const current = { aweme_id: "222", desc: "当前作品的合法 JSON", images: [{ url_list: ["image-1"] }] };

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/note/222") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>当前图文</title><main>DOM fallback 可读取</main><script>
        fetch('/aweme/v1/web/aweme/detail/?kind=hung').catch(() => {});
        ${url.searchParams.get("valid") === "1" ? "setTimeout(() => fetch('/aweme/v1/web/aweme/detail/?kind=valid').catch(() => {}), 100);" : ""}
      </script>`);
      return;
    }
    if (url.pathname === "/aweme/v1/web/aweme/detail/") {
      response.writeHead(200, { "Content-Type": "application/json" });
      if (url.searchParams.get("kind") === "hung") {
        // Headers and an initial body chunk arrive; response.json() is waiting
        // for the rest of this real streamed response, rather than for fetch.
        response.write('{"aweme_detail":');
        hungResponses.add(response);
        response.on("close", () => hungResponses.delete(response));
      } else response.end(JSON.stringify({ aweme_detail: current }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  for (const response of hungResponses) response.destroy();
  hungResponses.clear();
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("Protected DOUYIN_RESPONSE_COLLECTION_DEADLINE：真实流式 hung A 不阻塞 100ms 合法 B", async ({ page }) => {
  const collector = createDouyinResponseCollector(page, [], { responseTimeoutMs: 10_000 });
  try {
    const firstResponse = page.waitForResponse((response) => response.url().endsWith("?kind=hung"));
    await page.goto(`${origin}/note/222?valid=1`, { waitUntil: "domcontentloaded" });
    const hung = await firstResponse;
    expect(hung.status()).toBe(200);
    let bodyFinished = false;
    void hung.finished().then(() => { bodyFinished = true; }, () => { bodyFinished = true; });
    const result = await collector.waitFor("222", 2_000);
    expect(result).toMatchObject({ item: current, source: "NETWORK_RESPONSE" });
    expect(bodyFinished).toBe(false);
    expect(collector.mainDocuments).toContainEqual({ url: `${origin}/note/222?valid=1`, status: 200 });
  } finally { collector.dispose(); }
});

test("真实 JSON body 挂起时内部 deadline 返回 null，页面仍可用于 DOM fallback", async ({ page }) => {
  const collector = createDouyinResponseCollector(page, []);
  try {
    const firstResponse = page.waitForResponse((response) => response.url().endsWith("?kind=hung"));
    await page.goto(`${origin}/note/222`, { waitUntil: "domcontentloaded" });
    expect((await firstResponse).status()).toBe(200);
    expect(await collector.waitFor("222", 100)).toBeNull();
    await expect(page.getByText("DOM fallback 可读取", { exact: true })).toBeVisible();
    expect(page.isClosed()).toBe(false);
  } finally { collector.dispose(); }
});

test("Abort 后完成的真实旧 JSON 不进入新 collector，新请求仍可正常采集", async ({ page }) => {
  const controller = new AbortController();
  const collector = createDouyinResponseCollector(page, [], { signal: controller.signal });
  let next: ReturnType<typeof createDouyinResponseCollector> | undefined;
  try {
    const firstResponse = page.waitForResponse((response) => response.url().endsWith("?kind=hung"));
    await page.goto(`${origin}/note/222`, { waitUntil: "domcontentloaded" });
    await firstResponse;
    const waiting = collector.waitFor("222", 5_000);
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AutomaticExtractionHandoffCancelledError" });
    controller.abort();
    await rejected;
    next = createDouyinResponseCollector(page, []);
    for (const response of hungResponses) response.end(JSON.stringify({ ...current, desc: "旧 generation 迟到内容" }) + "}");
    const fresh = next.waitFor("222", 2_000);
    await page.evaluate(async () => { await fetch("/aweme/v1/web/aweme/detail/?kind=valid"); });
    expect(await fresh).toMatchObject({ item: current });
  } finally { collector.dispose(); next?.dispose(); }
});

test("真实 page close 中断 JSON collector 且不等待整个 extraction deadline", async ({ page }) => {
  const collector = createDouyinResponseCollector(page, []);
  try {
    const firstResponse = page.waitForResponse((response) => response.url().endsWith("?kind=hung"));
    await page.goto(`${origin}/note/222`, { waitUntil: "domcontentloaded" });
    await firstResponse;
    const waiting = collector.waitFor("222", 10_000);
    const rejected = expect(waiting).rejects.toMatchObject({ code: "BROWSER_CONTROL_ERROR" });
    await page.close();
    await rejected;
  } finally { collector.dispose(); }
});
