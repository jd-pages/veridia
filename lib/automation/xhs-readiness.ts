import type { Page } from "playwright";
import {
  classifyAutomaticPage,
  detectUnavailableXhsPage,
  type AutomaticPageType,
  type UnavailablePageEvidence,
} from "./page-classification";

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
].join(",");

const TERMINAL_PAGE_SELECTOR = [
  "[data-xhs-page-status='NOTE_NOT_FOUND']",
  "[data-xhs-page-status='NOT_FOUND']",
  "[data-xhs-page-status='LOGIN_EXPIRED']",
  "[data-xhs-page-status='SECURITY_VERIFICATION']",
  "[data-page-status='404']",
  "[data-testid*='not-found']",
  "[class*='not-found']",
  "[data-testid*='login']",
  "[class*='login-container']",
  "[class*='security-check']",
].join(",");

interface XhsReadinessPageEvidence {
  finalUrl: string;
  pageTitle: string;
  visibleText: string;
  notFoundDomMarker: string | null;
  pageType: AutomaticPageType;
  unavailablePage: UnavailablePageEvidence | null;
}

/**
 * Read terminal evidence from the whole rendered page. This deliberately does
 * not use a current-note scope: a redirect/error shell can replace that scope
 * while an earlier hydration snapshot is still in flight.
 */
export async function readXhsReadinessPageEvidence(
  page: Page,
  httpStatus: number | null = null,
): Promise<XhsReadinessPageEvidence> {
  const snapshot = await page.evaluate(() => {
    const marker = document.querySelector(
      "[data-xhs-page-status='NOTE_NOT_FOUND'],[data-xhs-page-status='NOT_FOUND'],[data-page-status='404'],[data-testid*='not-found'],[class*='not-found']",
    );
    return {
      finalUrl: location.href,
      pageTitle: document.title || "",
      visibleText: (document.body?.innerText || document.body?.textContent || "")
        .slice(0, 50_000),
      notFoundDomMarker: (marker?.textContent || "").trim() || null,
    };
  });
  const unavailablePage = detectUnavailableXhsPage({
    url: snapshot.finalUrl,
    title: snapshot.pageTitle,
    visibleText: snapshot.visibleText,
    httpStatus,
    notFoundDomMarker: snapshot.notFoundDomMarker,
  });
  return {
    ...snapshot,
    pageType: classifyAutomaticPage({
      url: snapshot.finalUrl,
      title: snapshot.pageTitle,
      visibleText: snapshot.visibleText,
      httpStatus,
      notFoundDomMarker: snapshot.notFoundDomMarker,
    }),
    unavailablePage,
  };
}

function isTerminalEvidence(evidence: XhsReadinessPageEvidence) {
  return Boolean(evidence.unavailablePage) ||
    ["LOGIN", "SECURITY_CHECK", "APP_LAUNCH", "ERROR_PAGE"].includes(
      evidence.pageType,
    );
}

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
  httpStatus?: number | null;
}) {
  const { page, redirectChain } = input;
  const deadline = Date.now() + Math.max(250, input.timeoutMs);
  const pollMs = Math.max(25, input.pollMs || 250);
  let reloadedEmptyShell = false;

  while (Date.now() < deadline) {
    redirectChain.push(page.url());
    // Terminal URL/title/body/DOM evidence always wins over an earlier shell
    // or hydration signal from the same polling turn.
    const terminalEvidence = await readXhsReadinessPageEvidence(
      page,
      input.httpStatus ?? null,
    ).catch(() => null);
    if (terminalEvidence && isTerminalEvidence(terminalEvidence)) {
      return true;
    }
    const [keyElementCount, terminalElementCount] = await Promise.all([
      page.locator(XHS_EXTRACTION_KEY_SELECTOR).count().catch(() => 0),
      page.locator(TERMINAL_PAGE_SELECTOR).count().catch(() => 0),
    ]);
    if (terminalElementCount > 0) return true;
    if (keyElementCount > 0) {
      await page
        .waitForLoadState("networkidle", { timeout: 2_500 })
        .catch(() => undefined);
      await page.waitForTimeout(600);
      const stabilizedEvidence = await readXhsReadinessPageEvidence(
        page,
      ).catch(() => null);
      if (stabilizedEvidence && isTerminalEvidence(stabilizedEvidence)) {
        redirectChain.push(stabilizedEvidence.finalUrl);
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
