import "server-only";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AuditTask } from "@prisma/client";
import type { Frame, Page } from "playwright";
import { prisma } from "@/lib/db";
import type { ExtractedNote } from "@/lib/types";
import { getAutomationSession, getWorkerBrowserContext } from "./browser";
import {
  AutomaticExtractionError,
  type AutomaticFailureCode,
} from "./failure";
import {
  detectContentWarnings,
  failureCodeForPageStatus,
} from "./classification";
import {
  classifyAutomaticPage,
  detectUnavailableXhsPage,
  isShortXiaohongshuUrl,
  isXiaohongshuNoteDetailUrl,
  safePageLogUrl,
  unavailablePageFailureMessage,
  type AutomaticPageType,
} from "./page-classification";
import { playwrightAdapters } from "./adapters";
import {
  collectDomPageSnapshot,
  createEmptyCandidates,
  createXhsResponseCollector,
  mergeCandidates,
  noteIdCandidatesFromUrls,
  safeEvidenceUrl,
  type XhsPageCandidates,
} from "./xhs-page-evidence";

export interface AutomaticExtractionOutcome {
  note: ExtractedNote;
  warnings: AutomaticFailureCode[];
}

interface PageIdentity {
  finalUrl: string;
  pageTitle: string;
  pageType: AutomaticPageType;
  visibleText: string;
  httpStatus: number | null;
  notFoundDomMarker: string | null;
}

const KEY_ELEMENT_SELECTOR = [
  "#detail-title",
  "#detail-desc",
  "[data-testid='note-title']",
  "[data-testid='note-content']",
  "[data-testid='note-desc']",
  ".note-content",
  "[class*='note-content']",
  "[class*='note-detail']",
  "[class*='note-slider']",
  "[class*='swiper']",
  "[class*='carousel']",
  "a#hash-tag",
  "a[href*='/search_result']",
  "a[href*='/topic']",
  "script[type='application/ld+json']",
].join(",");

function isMockUrl(value: string) {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

function effectiveMockUrl(task: AuditTask) {
  const url = new URL(task.url);
  const retryCase = url.searchParams.get("retryCase");
  if (retryCase && task.attempts > 1) {
    url.searchParams.set("case", retryCase);
  }
  return url.toString();
}

function uniqueUrls(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function throwForPageStatus(status: ExtractedNote["pageStatus"]) {
  const code = failureCodeForPageStatus(status);
  if (code) throw new AutomaticExtractionError(code);
}

async function readPageIdentity(
  page: Page,
  httpStatus: number | null = null,
): Promise<PageIdentity> {
  const finalUrl = page.url();
  const [pageTitle, visibleText, notFoundDomMarker] = await Promise.all([
    page.title().catch(() => ""),
    page
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => ""),
    page
      .locator(
        "[data-xhs-page-status='NOTE_NOT_FOUND'], [data-xhs-page-status='NOT_FOUND'], [data-page-status='404'], [data-testid*='not-found'], [class*='not-found']",
      )
      .first()
      .innerText({ timeout: 500 })
      .catch(() => ""),
  ]);
  return {
    finalUrl,
    pageTitle,
    pageType: classifyAutomaticPage({
      url: finalUrl,
      title: pageTitle,
      visibleText,
      httpStatus,
      notFoundDomMarker,
    }),
    visibleText,
    httpStatus,
    notFoundDomMarker: notFoundDomMarker || null,
  };
}

async function waitForPageReadiness(
  page: Page,
  originalUrl: string,
  redirectChain: string[],
) {
  const timeout = Number(
    process.env.AUTOMATION_REDIRECT_TIMEOUT_MS ||
      process.env.AUTOMATION_KEY_ELEMENT_TIMEOUT_MS ||
      15_000,
  );
  const startedAt = Date.now();
  const deadline = Date.now() + timeout;
  let previousUrl = "";
  let stableChecks = 0;
  let observedNoteDetail = isXiaohongshuNoteDetailUrl(originalUrl);
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    redirectChain.push(currentUrl);
    observedNoteDetail ||= isXiaohongshuNoteDetailUrl(currentUrl);
    if (currentUrl === previousUrl) stableChecks += 1;
    else {
      previousUrl = currentUrl;
      stableChecks = 0;
    }

    const identity = await readPageIdentity(page);
    if (
      ["LOGIN", "SECURITY_CHECK", "APP_LAUNCH", "ERROR_PAGE"].includes(
        identity.pageType,
      )
    ) {
      return;
    }
    const keyElementCount = await page
      .locator(KEY_ELEMENT_SELECTOR)
      .count()
      .catch(() => 0);
    if (keyElementCount > 0) {
      await page
        .waitForLoadState("networkidle", { timeout: 2_500 })
        .catch(() => undefined);
      await page.waitForTimeout(600);
      return;
    }
    if (
      observedNoteDetail &&
      stableChecks >= 6 &&
      Date.now() - startedAt >= 3_000
    ) {
      return;
    }
    await page.waitForTimeout(250);
  }
}

async function waitForExtractionKeyElements(page: Page) {
  await page
    .locator(KEY_ELEMENT_SELECTOR)
    .first()
    .waitFor({ state: "attached", timeout: 2_000 })
    .catch(() => undefined);
}

async function captureFailureEvidence(
  page: Page,
  task: AuditTask,
  identity: PageIdentity,
  redirectChain: string[],
  responseCandidates: XhsPageCandidates = createEmptyCandidates(),
  extractionEvidence?: Record<string, unknown> | null,
) {
  const evidenceDirectory = process.env.AUTOMATION_EVIDENCE_PATH
    ? path.resolve(process.env.AUTOMATION_EVIDENCE_PATH)
    : path.join(
        /* turbopackIgnore: true */ process.cwd(),
        ".playwright",
        "evidence",
      );
  await mkdir(evidenceDirectory, { recursive: true });
  const fileName = `${task.id}-attempt-${task.attempts}-${Date.now()}.png`;
  const screenshotPath = path.join(evidenceDirectory, fileName);
  const screenshotSaved = await page
    .screenshot({ path: screenshotPath, fullPage: false })
    .then(() => true)
    .catch(() => false);
  const domSnapshot = await collectDomPageSnapshot(page).catch(() => null);
  const urlCandidates = createEmptyCandidates();
  urlCandidates.noteIdCandidates = noteIdCandidatesFromUrls([
    task.url,
    identity.finalUrl,
    ...redirectChain,
  ]);
  const candidates = mergeCandidates(
    urlCandidates,
    domSnapshot || createEmptyCandidates(),
    responseCandidates,
  );

  return {
    ...(extractionEvidence || {}),
    originalUrl: safeEvidenceUrl(task.url),
    finalUrl: safeEvidenceUrl(identity.finalUrl),
    pageTitle: identity.pageTitle,
    pageType: identity.pageType,
    redirectChain: uniqueUrls(redirectChain).map(safeEvidenceUrl),
    screenshotPath: screenshotSaved
      ? path.relative(process.cwd(), screenshotPath)
      : null,
    screenshotSaved,
    visibleTextPreview: domSnapshot?.visibleTextPreview || "",
    visibleTextLength: domSnapshot?.visibleTextLength || 0,
    htmlLength: domSnapshot?.htmlLength || 0,
    noteIdCandidates: candidates.noteIdCandidates.slice(0, 20),
    titleCandidates: candidates.titleCandidates.slice(0, 20),
    bodyCandidates: candidates.bodyCandidates.slice(0, 20).map((item) => ({
      ...item,
      value: item.value.slice(0, 2_000),
    })),
    topicCandidates: candidates.topicCandidates.slice(0, 100),
    imageCandidates: candidates.imageCandidates.slice(0, 100),
    loginEvidence: candidates.loginEvidence,
    responseSummaries: candidates.responseSummaries,
    htmlSummary: domSnapshot
      ? {
          keyElementCount: domSnapshot.keyElementCount,
          domSummary: domSnapshot.domSummary,
        }
      : { unavailable: true },
  };
}

async function savePageMetadata(
  taskId: string,
  identity: PageIdentity,
  redirectChain: string[],
  failureEvidence?: Record<string, unknown> | null,
) {
  await prisma.auditTask.update({
    where: { id: taskId },
    data: {
      finalUrl: identity.finalUrl || null,
      pageTitle: identity.pageTitle || null,
      pageType: identity.pageType,
      redirectChain: JSON.stringify(uniqueUrls(redirectChain)),
      failureEvidence:
        failureEvidence === undefined
          ? undefined
          : failureEvidence
            ? JSON.stringify(failureEvidence)
            : null,
    },
  });
}

function logPageIdentity(task: AuditTask, identity: PageIdentity) {
  console.info(
    "[自动提取页面]",
    JSON.stringify({
      taskId: task.id,
      currentUrl: safePageLogUrl(identity.finalUrl),
      pageTitle: identity.pageTitle,
      pageType: identity.pageType,
    }),
  );
}

export async function extractAuditTaskAutomatically(
  task: AuditTask,
): Promise<AutomaticExtractionOutcome> {
  const mock = isMockUrl(task.url);
  if (!mock) {
    const session = await getAutomationSession();
    if (session.status === "LOGIN_REQUIRED") {
      throw new AutomaticExtractionError(
        "LOGIN_REQUIRED",
        "请先在专用浏览器中登录小红书",
      );
    }
    if (session.status === "SECURITY_CHECK") {
      throw new AutomaticExtractionError(
        "SECURITY_CHECK",
        "请先在专用浏览器中完成人工安全验证",
      );
    }
  }

  const context = await getWorkerBrowserContext();
  const page = await context.newPage();
  const responseCollector = createXhsResponseCollector(page);
  const pageUrl = mock ? effectiveMockUrl(task) : task.url;
  const redirectChain = [task.url];
  let responseCandidates = createEmptyCandidates();
  let extractionEvidence: Record<string, unknown> | null = null;
  let identity: PageIdentity = {
    finalUrl: pageUrl,
    pageTitle: "",
    pageType: isShortXiaohongshuUrl(pageUrl) ? "SHORT_LINK" : "UNKNOWN",
    visibleText: "",
    httpStatus: null,
    notFoundDomMarker: null,
  };

  const recordNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) redirectChain.push(frame.url());
  };
  page.on("framenavigated", recordNavigation);

  try {
    const url = new URL(pageUrl);
    const simulatedFailure = url.searchParams.get("simulate");
    if (simulatedFailure === "network-error") {
      throw new AutomaticExtractionError("NETWORK_ERROR");
    }
    if (simulatedFailure === "load-timeout") {
      throw new AutomaticExtractionError("LOAD_TIMEOUT");
    }

    let responseUrl = "";
    let navigationHttpStatus: number | null = null;
    try {
      const response = await page.goto(pageUrl, {
        waitUntil: "domcontentloaded",
        timeout: Number(process.env.AUTOMATION_PAGE_TIMEOUT_MS || 30_000),
      });
      navigationHttpStatus = response?.status() ?? null;
      responseUrl = response?.url() || "";
      if (responseUrl) redirectChain.push(responseUrl);
      if (!mock) {
        await waitForPageReadiness(page, task.url, redirectChain);
      }
    } catch (error) {
      if (error instanceof AutomaticExtractionError) throw error;
      if (error instanceof Error && /Timeout/i.test(error.message)) {
        throw new AutomaticExtractionError("LOAD_TIMEOUT");
      }
      throw new AutomaticExtractionError(
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "页面网络请求失败",
      );
    }

    const delay = Number(url.searchParams.get("autoDelay") || 0);
    if (delay > 0) await page.waitForTimeout(Math.min(delay, 10_000));

    responseCandidates = await responseCollector.snapshot();
    identity = await readPageIdentity(page, navigationHttpStatus);
    if (
      responseCandidates.loginEvidence.some((item) =>
        /安全|风险|验证|限制/u.test(item),
      )
    ) {
      identity.pageType = "SECURITY_CHECK";
    } else if (
      responseCandidates.loginEvidence.length > 0 &&
      identity.pageType === "UNKNOWN"
    ) {
      identity.pageType = "LOGIN";
    }
    redirectChain.push(identity.finalUrl);
    logPageIdentity(task, identity);

    if (identity.pageType === "LOGIN") {
      throw new AutomaticExtractionError(
        "LOGIN_REQUIRED",
        `页面需要登录：${identity.pageTitle || "无标题"}`,
      );
    }
    if (identity.pageType === "SECURITY_CHECK") {
      throw new AutomaticExtractionError(
        "SECURITY_CHECK",
        `页面要求安全验证：${identity.pageTitle || "无标题"}`,
      );
    }
    const unavailablePage = detectUnavailableXhsPage({
      url: identity.finalUrl,
      title: identity.pageTitle,
      visibleText: identity.visibleText,
      httpStatus: identity.httpStatus,
      notFoundDomMarker: identity.notFoundDomMarker,
    });
    if (unavailablePage) {
      console.info(
        "[自动审核] 笔记不存在",
        JSON.stringify({
          taskId: task.id,
          originalUrl: safePageLogUrl(task.url),
          finalUrl: safePageLogUrl(identity.finalUrl),
          pageTitle: identity.pageTitle,
          matchedCondition: unavailablePage.source,
          matchedText: unavailablePage.matchedText,
          errorCode: unavailablePage.errorCode || null,
          detectedAt: new Date().toISOString(),
          status: "NOTE_NOT_FOUND",
        }),
      );
      throw new AutomaticExtractionError(
        "NOTE_NOT_FOUND",
        unavailablePageFailureMessage(unavailablePage),
        {
          unavailablePage: {
            status: unavailablePage.status,
            matchedText: unavailablePage.matchedText,
            source: unavailablePage.source,
          },
        },
      );
    }
    const reachedNoteDetail = [task.url, identity.finalUrl, ...redirectChain].some(
      isXiaohongshuNoteDetailUrl,
    );
    if (isShortXiaohongshuUrl(task.url) && !reachedNoteDetail) {
      const reason =
        identity.pageType === "APP_LAUNCH"
          ? "短链接进入 App 唤起页"
          : "短链接未跳转到小红书笔记详情页";
      throw new AutomaticExtractionError(
        "REDIRECT_FAILED",
        `${reason}，请人工复核。最终页面：${identity.pageTitle || "无标题"}`,
      );
    }
    if (identity.pageType === "APP_LAUNCH") {
      throw new AutomaticExtractionError(
        "PAGE_READ_FAILED",
        `进入 App 唤起页，无法在网页中提取：${identity.pageTitle || "无标题"}`,
      );
    }

    if (!mock && isXiaohongshuNoteDetailUrl(identity.finalUrl)) {
      try {
        await waitForExtractionKeyElements(page);
      } catch {
        throw new AutomaticExtractionError(
          "STRUCTURE_MISMATCH",
          "笔记详情页未出现正文或话题区域",
        );
      }
    }

    const adapter = playwrightAdapters.find((item) =>
      item.canHandle(identity.finalUrl),
    );
    if (!adapter) {
      throw new AutomaticExtractionError(
        "STRUCTURE_MISMATCH",
        `最终页面没有可用 Adapter：${identity.pageType}`,
      );
    }
    const note = await adapter.extract(page, task.url, {
      redirectChain: uniqueUrls(redirectChain),
      responseCandidates,
    });
    note.finalUrl = identity.finalUrl;
    note.pageTitle = identity.pageTitle;
    note.pageType = identity.pageType;
    note.redirectChain = uniqueUrls(redirectChain);
    extractionEvidence = {
      ...(note.pageEvidence || {}),
      originalUrl: safeEvidenceUrl(task.url),
      finalUrl: safeEvidenceUrl(identity.finalUrl),
      pageTitle: identity.pageTitle,
      pageType: identity.pageType,
      redirectChain: uniqueUrls(redirectChain).map(safeEvidenceUrl),
    };
    note.pageEvidence = extractionEvidence;
    throwForPageStatus(note.pageStatus);

    if (!note.title?.trim() && !note.body?.trim()) {
      throw new AutomaticExtractionError(
        "STRUCTURE_MISMATCH",
        "页面结构已匹配，但没有提取到标题或正文",
      );
    }
    const warnings = detectContentWarnings(note);
    note.technicalWarnings = warnings;
    await savePageMetadata(
      task.id,
      identity,
      redirectChain,
      extractionEvidence,
    );
    return { note, warnings };
  } catch (error) {
    responseCandidates = await responseCollector
      .snapshot()
      .catch(() => responseCandidates);
    identity = await readPageIdentity(page).catch(() => identity);
    redirectChain.push(identity.finalUrl);
    logPageIdentity(task, identity);
    const extractionError =
      error instanceof AutomaticExtractionError
        ? error
        : new AutomaticExtractionError(
            "PAGE_READ_FAILED",
            error instanceof Error ? error.message : "页面读取失败",
          );
    const capturedEvidence = await captureFailureEvidence(
      page,
      task,
      identity,
      redirectChain,
      responseCandidates,
      extractionEvidence,
    );
    const evidence = {
      ...(extractionError.details || {}),
      ...capturedEvidence,
    };
    extractionError.attachDetails(evidence);
    await savePageMetadata(task.id, identity, redirectChain, evidence);
    throw extractionError;
  } finally {
    responseCollector.dispose();
    page.off("framenavigated", recordNavigation);
    await page.close().catch(() => undefined);
  }
}
