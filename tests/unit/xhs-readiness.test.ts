import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { waitForXhsPageReadiness } from "@/lib/automation/xhs-readiness";

describe("小红书页面 hydration 就绪门禁", () => {
  let browser: Browser | undefined;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    page = await browser.newPage();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
  }, 30_000);

  it("稳定 URL 但尚未 hydration 时继续等待 current-note 证据", async () => {
    await page.setContent(`
      <script>
        setTimeout(() => {
          document.body.innerHTML = '<main id="noteContainer"><h1 id="detail-title">延迟标题</h1><div id="detail-desc">延迟正文</div></main>';
        }, 350);
      </script>
    `);
    const redirects: string[] = [];
    await expect(
      waitForXhsPageReadiness({
        page,
        redirectChain: redirects,
        timeoutMs: 1_500,
        pollMs: 25,
      }),
    ).resolves.toBe(true);
    expect(await page.locator("#detail-title").textContent()).toBe("延迟标题");
  });

  it("空白稳定页面不能被当作已就绪", async () => {
    await page.setContent("<div></div>");
    await expect(
      waitForXhsPageReadiness({
        page,
        redirectChain: [],
        timeoutMs: 300,
        pollMs: 25,
      }),
    ).resolves.toBe(false);
  });
});
