import type { Page, Request, Response } from "playwright";
import { findDouyinAwemeItem, hasDouyinContentPayload, type DouyinStructuredEvidence } from "./douyin-adapter";
import {
  AutomaticExtractionHandoffCancelledError,
  automationExtractionDeadlineMs,
} from "./extraction-deadline";
import { AutomaticExtractionError } from "./failure";

export const DOUYIN_RESPONSE_PARSE_TIMEOUT_MS = 10_000;
export const DOUYIN_RESPONSE_CACHE_LIMIT = 32;
const OWNER_CHECK_INTERVAL_MS = 50;
const MAIN_DOCUMENT_LIMIT = 64;

interface JsonObserver {
  deliver: ((payload: { value: unknown } | null) => void) | null;
}

// Playwright cannot abort response.json(). These handlers capture only a small
// observer. Releasing its delivery callback severs access to the whole collector.
function observeJson(operation: Promise<unknown>, observer: JsonObserver) {
  void operation.then(
    (value) => { observer.deliver?.({ value }); },
    () => { observer.deliver?.(null); },
  );
}

export function appendDouyinRequestChain(request: Request, redirectChain: string[]) {
  const chain: string[] = [];
  let current: Request | null = request;
  while (current) {
    chain.unshift(current.url());
    current = current.redirectedFrom();
  }
  redirectChain.push(...chain);
}

export function createDouyinResponseCollector(
  page: Page,
  redirectChain: string[],
  options: {
    signal?: AbortSignal;
    isCurrentGeneration?: () => boolean;
    responseTimeoutMs?: number;
    /** Lifetime starts before navigation; waitFor has its own shorter deadline. */
    lifetimeMs?: number;
  } = {},
) {
  const duration = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;
  const responseTimeoutMs = duration(options.responseTimeoutMs, DOUYIN_RESPONSE_PARSE_TIMEOUT_MS);
  const lifetimeMs = duration(options.lifetimeMs, automationExtractionDeadlineMs());
  const lifetimeDeadline = Date.now() + lifetimeMs;
  const mainDocuments: Array<{ url: string; status: number }> = [];
  const resolved: Array<{ payload: unknown; responseUrl: string }> = [];
  const requests = new WeakSet<Request>();
  const pending = new Map<JsonObserver, ReturnType<typeof setTimeout>>();
  let stopped = false;
  let terminalError: Error | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let ownerTimer: ReturnType<typeof setInterval> | undefined;
  let waiter: {
    contentId: string;
    deadline: number;
    resolve: (value: DouyinStructuredEvidence | null) => void;
    reject: (reason: Error) => void;
  } | null = null;

  function release(observer: JsonObserver) {
    observer.deliver = null;
    clearTimeout(pending.get(observer));
    pending.delete(observer);
  }

  function finish(value: DouyinStructuredEvidence | null = null, error: Error | null = null) {
    if (stopped) return;
    stopped = true;
    terminalError = error;
    page.off("response", onResponse);
    page.off("request", onRequest);
    page.off("close", onClose);
    options.signal?.removeEventListener("abort", onAbort);
    clearTimeout(lifetimeTimer);
    clearTimeout(waitTimer);
    clearInterval(ownerTimer);
    for (const observer of pending.keys()) release(observer);
    resolved.length = 0;
    const waiting = waiter;
    waiter = null;
    if (error) waiting?.reject(error);
    else waiting?.resolve(value);
  }

  function onAbort() {
    finish(null, new AutomaticExtractionHandoffCancelledError());
  }

  function onClose() {
    finish(null, new AutomaticExtractionError("BROWSER_CONTROL_ERROR", "抖音审核页面已关闭，当前采集已停止"));
  }

  function isActive() {
    if (stopped) return false;
    if (options.signal?.aborted || (options.isCurrentGeneration && !options.isCurrentGeneration())) onAbort();
    else if (page.isClosed()) onClose();
    else if (Date.now() >= lifetimeDeadline || (waiter && Date.now() >= waiter.deadline)) finish();
    return !stopped;
  }

  function accept(candidate: { payload: unknown; responseUrl: string }) {
    if (!isActive()) return;
    if (!waiter) {
      resolved.push(candidate);
      if (resolved.length > DOUYIN_RESPONSE_CACHE_LIMIT) resolved.shift();
      return;
    }
    const item = findDouyinAwemeItem(candidate.payload, waiter.contentId);
    // A synchronous search can consume the last deadline slice. Never publish
    // that result after cancellation or the collection deadline.
    if (item && hasDouyinContentPayload(item) && isActive()) {
      finish({ item, responseUrl: candidate.responseUrl, source: "NETWORK_RESPONSE" });
    }
  }

  function onResponse(response: Response) {
    if (!isActive()) return;
    try {
      // A response whose request began before this collector belongs to an old
      // extraction, even if it arrives after a page was handed to a new owner.
      if (!requests.has(response.request())) return;
      if (response.request().resourceType() === "document" && response.frame() === page.mainFrame()) {
        appendDouyinRequestChain(response.request(), redirectChain);
        redirectChain.push(response.url());
        mainDocuments.push({ url: response.url(), status: response.status() });
        if (mainDocuments.length > MAIN_DOCUMENT_LIMIT) mainDocuments.shift();
      }
      if (!/(?:\/aweme\/v1\/web\/aweme\/(?:post|detail)\/?|aweme_detail)/iu.test(response.url())) return;
      // A burst of hung responses must not grow memory or exclude a newer response.
      if (pending.size >= DOUYIN_RESPONSE_CACHE_LIMIT) release(pending.keys().next().value!);
      const responseUrl = response.url();
      const parseDeadline = Math.min(Date.now() + responseTimeoutMs, lifetimeDeadline);
      const observer: JsonObserver = { deliver: null };
      observer.deliver = (payload) => {
        release(observer);
        if (payload && Date.now() < parseDeadline && isActive()) accept({ payload: payload.value, responseUrl });
      };
      pending.set(observer, setTimeout(() => release(observer), Math.max(0, parseDeadline - Date.now())));
      try { observeJson(response.json(), observer); } catch { release(observer); }
    } catch {
      // A response destroyed with its page is not new evidence.
      if (page.isClosed()) onClose();
    }
  }

  function onRequest(request: Request) {
    if (isActive()) requests.add(request);
  }

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("close", onClose);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const lifetimeTimer = setTimeout(() => finish(), lifetimeMs);
  if (options.isCurrentGeneration) ownerTimer = setInterval(() => { isActive(); }, OWNER_CHECK_INTERVAL_MS);
  isActive();

  return {
    mainDocuments,
    waitFor(contentId: string, timeoutMs: number): Promise<DouyinStructuredEvidence | null> {
      if (!isActive()) return terminalError ? Promise.reject(terminalError) : Promise.resolve(null);
      if (waiter) return Promise.reject(new Error("抖音证据收集器仅允许一次等待"));
      return new Promise((resolve, reject) => {
        const waitMs = duration(timeoutMs, DOUYIN_RESPONSE_PARSE_TIMEOUT_MS);
        waiter = { contentId, deadline: Math.min(Date.now() + waitMs, lifetimeDeadline), resolve, reject };
        waitTimer = setTimeout(() => finish(), Math.min(waitMs, Math.max(0, lifetimeDeadline - Date.now())));
        const candidates = resolved.splice(0);
        for (const candidate of candidates) {
          accept(candidate);
          if (stopped) break;
        }
        isActive();
      });
    },
    dispose() { finish(); },
  };
}
