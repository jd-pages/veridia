import type { Page } from "playwright";
import {
  throwIfAutomaticExtractionAborted,
  waitForAutomaticExtractionDelay,
  waitForAutomaticExtractionOperation,
} from "./extraction-deadline";
import {
  classifyAutomaticPage,
  detectUnavailableXhsPage,
  isXiaohongshuNoteDetailUrl,
  type AutomaticPageType,
  type PageClassificationInput,
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

export type XhsReadinessCurrentNoteEvidence = NonNullable<
  PageClassificationInput["currentNoteEvidence"]
>;

interface XhsReadinessPageEvidence {
  finalUrl: string;
  pageTitle: string;
  visibleText: string;
  notFoundDomMarker: string | null;
  currentNoteEvidence: XhsReadinessCurrentNoteEvidence;
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
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const rootSignals = (root: Element) => {
      const explicitIdentity =
        root.id === "noteContainer" ||
        root.hasAttribute("data-xhs-note-id") ||
        root.matches(
          "[data-testid='note-detail'],.note-detail-mask,[class^='note-detail-'],[class*=' note-detail-']",
        );
      const hasTitle = Boolean(
        root.querySelector(
          "#detail-title,[data-testid='note-title'],[data-xhs-note-title],[data-xhs-title],[class~='note-title'],[class^='note-title-'],[class*=' note-title-']",
        ),
      );
      const hasDescription = Boolean(
        root.querySelector(
          "#detail-desc,[data-testid='note-content'],[data-testid='note-desc'],[data-xhs-note-desc],[data-xhs-body],[class~='note-desc'],[class^='note-desc-'],[class*=' note-desc-']",
        ),
      );
      const hasActionBar = Boolean(
        root.querySelector(
          "[data-testid='note-action-bar'],.interactions.engage-bar,.engage-bar-container",
        ),
      );
      const hasMedia = Boolean(
        root.querySelector(
          "[data-testid='note-media'],[class*='swiper'],[class*='carousel'],[class*='media-container'],video",
        ),
      );
      const corroboratingSignalCount = [
        hasTitle,
        hasDescription,
        hasActionBar,
        hasMedia,
      ].filter(Boolean).length;
      return {
        explicitIdentity,
        hasTitle,
        hasDescription,
        hasActionBar,
        hasMedia,
        corroboratingSignalCount,
      };
    };
    const rootScore = (root: Element) => {
      const signals = rootSignals(root);
      return (
        (root.id === "noteContainer" ? 100 : 0) +
        (signals.explicitIdentity ? 50 : 0) +
        (signals.hasTitle ? 20 : 0) +
        (signals.hasDescription ? 20 : 0) +
        (signals.hasActionBar ? 10 : 0) +
        (signals.hasMedia ? 10 : 0)
      );
    };
    const roots = [
      ...new Set(
        [
          "#noteContainer",
          "[data-xhs-note-id]",
          "[data-testid='note-detail']",
          ".note-detail-mask",
          "[class*='note-detail']",
          "main",
          "article",
          ".note-content",
          "[class*='note-content']",
        ].flatMap((selector) => [...document.querySelectorAll(selector)]),
      ),
    ];
    const currentNoteRoot = roots
      .filter(visible)
      .sort((left, right) => rootScore(right) - rootScore(left))[0] || null;
    const signals = currentNoteRoot
      ? rootSignals(currentNoteRoot)
      : {
          explicitIdentity: false,
          hasTitle: false,
          hasDescription: false,
          hasActionBar: false,
          hasMedia: false,
          corroboratingSignalCount: 0,
        };
    const rootPath = currentNoteRoot
      ? currentNoteRoot.id
        ? `#${CSS.escape(currentNoteRoot.id)}`
        : `${currentNoteRoot.tagName.toLowerCase()}${[
            ...currentNoteRoot.classList,
          ]
            .slice(0, 3)
            .map((item) => `.${CSS.escape(item)}`)
            .join("")}`
      : null;
    return {
      finalUrl: location.href,
      pageTitle: document.title || "",
      visibleText: (document.body?.innerText || document.body?.textContent || "")
        .slice(0, 50_000),
      notFoundDomMarker: (marker?.textContent || "").trim() || null,
      currentNoteEvidence: {
        rootLocated: Boolean(currentNoteRoot),
        ...signals,
        isReadable:
          Boolean(currentNoteRoot) &&
          signals.explicitIdentity &&
          (signals.hasTitle || signals.hasDescription) &&
          signals.corroboratingSignalCount >= 2,
        rootPath,
      },
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
      currentNoteEvidence: snapshot.currentNoteEvidence,
    }),
    unavailablePage,
  };
}

function isTerminalEvidence(evidence: XhsReadinessPageEvidence) {
  if (evidence.unavailablePage) return true;
  if (["SECURITY_CHECK", "ERROR_PAGE"].includes(evidence.pageType)) {
    return true;
  }
  if (
    ["LOGIN", "APP_LAUNCH"].includes(evidence.pageType) &&
    !isXiaohongshuNoteDetailUrl(evidence.finalUrl)
  ) {
    return true;
  }
  return false;
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
  signal?: AbortSignal;
}) {
  const { page, redirectChain } = input;
  const deadline = Date.now() + Math.max(250, input.timeoutMs);
  const pollMs = Math.max(25, input.pollMs || 250);
  let reloadedEmptyShell = false;

  while (Date.now() < deadline) {
    throwIfAutomaticExtractionAborted(input.signal);
    redirectChain.push(page.url());
    // Terminal URL/title/body/DOM evidence always wins over an earlier shell
    // or hydration signal from the same polling turn.
    const terminalEvidence = await waitForAutomaticExtractionOperation(
      readXhsReadinessPageEvidence(page, input.httpStatus ?? null),
      input.signal,
    ).catch(() => {
      throwIfAutomaticExtractionAborted(input.signal);
      return null;
    });
    if (terminalEvidence && isTerminalEvidence(terminalEvidence)) {
      return true;
    }
    const [keyElementCount, terminalElementCount] =
      await waitForAutomaticExtractionOperation(
        Promise.all([
          page.locator(XHS_EXTRACTION_KEY_SELECTOR).count().catch(() => 0),
          page.locator(TERMINAL_PAGE_SELECTOR).count().catch(() => 0),
        ]),
        input.signal,
      );
    if (
      terminalElementCount > 0 &&
      !isXiaohongshuNoteDetailUrl(page.url())
    ) {
      return true;
    }
    if (keyElementCount > 0) {
      await waitForAutomaticExtractionOperation(
        page.waitForLoadState("networkidle", { timeout: 2_500 }),
        input.signal,
      ).catch(() => {
        throwIfAutomaticExtractionAborted(input.signal);
      });
      await waitForAutomaticExtractionDelay(600, input.signal);
      const stabilizedEvidence = await waitForAutomaticExtractionOperation(
        readXhsReadinessPageEvidence(page),
        input.signal,
      ).catch(() => {
        throwIfAutomaticExtractionAborted(input.signal);
        return null;
      });
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
      await waitForAutomaticExtractionOperation(
        page.reload({
          waitUntil: "domcontentloaded",
          timeout: Math.max(1_000, remaining),
        }),
        input.signal,
      ).catch(() => {
        throwIfAutomaticExtractionAborted(input.signal);
      });
      continue;
    }
    await waitForAutomaticExtractionDelay(
      Math.min(pollMs, Math.max(1, remaining)),
      input.signal,
    );
  }
  return false;
}

export async function waitForXhsExtractionKeyElements(
  page: Page,
  timeoutMs = 2_000,
  signal?: AbortSignal,
) {
  try {
    await waitForAutomaticExtractionOperation(
      page
        .locator(XHS_EXTRACTION_KEY_SELECTOR)
        .first()
        .waitFor({ state: "attached", timeout: timeoutMs }),
      signal,
    );
    return true;
  } catch {
    throwIfAutomaticExtractionAborted(signal);
    return false;
  }
}
