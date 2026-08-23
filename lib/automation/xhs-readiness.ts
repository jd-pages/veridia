import type { Page } from "playwright";

export const XHS_EXTRACTION_KEY_SELECTOR = [
  "#detail-title",
  "#detail-desc",
  "[data-testid='note-title']",
  "[data-testid='note-content']",
  "[data-testid='note-desc']",
  "#noteContainer [data-testid='note-media']",
  "#noteContainer [class*='swiper']",
  "#noteContainer [class*='carousel']",
  "#noteContainer a#hash-tag",
  "#noteContainer a[href*='/search_result']",
  "script[type='application/ld+json']",
].join(",");

const TERMINAL_PAGE_SELECTOR = [
  "[data-xhs-page-status]",
  "[data-page-status]",
  "[data-testid*='not-found']",
  "[class*='not-found']",
  "[data-testid*='login']",
  "[class*='login-container']",
  "[class*='security-check']",
].join(",");

async function isEmptyDocumentShell(page: Page) {
  return page.evaluate(() => {
    const htmlLength = document.documentElement?.outerHTML.length || 0;
    const bodyText = (document.body?.textContent || "").trim();
    const bodyElementCount = document.body?.querySelectorAll("*").length || 0;
    return !bodyText && bodyElementCount === 0 && htmlLength < 5_000;
  });
}

/**
 * A stable note URL is not readiness evidence. Wait for current-note evidence
 * (or an explicit terminal page), with at most one bounded reload for a truly
 * empty browser shell.
 */
export async function waitForXhsPageReadiness(input: {
  page: Page;
  redirectChain: string[];
  timeoutMs: number;
  pollMs?: number;
}) {
  const { page, redirectChain } = input;
  const deadline = Date.now() + Math.max(250, input.timeoutMs);
  const pollMs = Math.max(25, input.pollMs || 250);
  let reloadedEmptyShell = false;

  while (Date.now() < deadline) {
    redirectChain.push(page.url());
    const [keyElementCount, terminalElementCount] = await Promise.all([
      page.locator(XHS_EXTRACTION_KEY_SELECTOR).count().catch(() => 0),
      page.locator(TERMINAL_PAGE_SELECTOR).count().catch(() => 0),
    ]);
    if (keyElementCount > 0 || terminalElementCount > 0) {
      if (keyElementCount > 0) {
        await page
          .waitForLoadState("networkidle", { timeout: 2_500 })
          .catch(() => undefined);
        await page.waitForTimeout(600);
      }
      return true;
    }

    const remaining = deadline - Date.now();
    if (
      !reloadedEmptyShell &&
      remaining <= input.timeoutMs / 2 &&
      (await isEmptyDocumentShell(page).catch(() => false))
    ) {
      reloadedEmptyShell = true;
      await page
        .reload({ waitUntil: "domcontentloaded", timeout: Math.max(1_000, remaining) })
        .catch(() => undefined);
      continue;
    }
    await page.waitForTimeout(Math.min(pollMs, Math.max(1, remaining)));
  }
  return false;
}

export async function waitForXhsExtractionKeyElements(
  page: Page,
  timeoutMs = 2_000,
) {
  return page
    .locator(XHS_EXTRACTION_KEY_SELECTOR)
    .first()
    .waitFor({ state: "attached", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}
