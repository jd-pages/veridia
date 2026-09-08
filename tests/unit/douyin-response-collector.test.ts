import { EventEmitter } from "node:events";
import type { Page, Request, Response } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDouyinResponseCollector,
  DOUYIN_RESPONSE_CACHE_LIMIT,
} from "@/lib/automation/douyin-response-collector";
import { AutomaticExtractionHandoffCancelledError } from "@/lib/automation/extraction-deadline";
import {
  acquireBrowserOwner, isCurrentBrowserOwner, isStaleExtractionCompletion,
  requestOwnedExtractionCancellation, resetGenerationLifecycleForTesting,
  startOwnedExtraction, trackOwnedExtraction,
} from "@/lib/automation/generation-lifecycle";

class FakePage extends EventEmitter {
  closed = false;
  frame = {};
  isClosed() { return this.closed; }
  mainFrame() { return this.frame; }
  closePage() { this.closed = true; this.emit("close"); }
  asPage() { return this as unknown as Page; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const item = (id = "222", desc = "当前作品") => ({ aweme_detail: { aweme_id: id, desc, images: [] } });

function responseFor(page: FakePage, json: () => Promise<unknown>, url = "https://www.douyin.com/aweme/v1/web/aweme/detail/", document = false) {
  const request = { resourceType: () => document ? "document" : "fetch", url: () => url, redirectedFrom: () => null } as unknown as Request;
  const response = { request: () => request, frame: () => page.frame, url: () => url, status: () => 200, json } as unknown as Response;
  return { request, response };
}

function emitResponse(page: FakePage, json: () => Promise<unknown>, url?: string, document = false) {
  const pair = responseFor(page, json, url, document);
  page.emit("request", pair.request);
  page.emit("response", pair.response);
  return pair;
}

function expectReleased(page: FakePage) {
  for (const event of ["request", "response", "close"]) expect(page.listenerCount(event)).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { resetGenerationLifecycleForTesting(); vi.useRealTimers(); });

describe("DOUYIN_RESPONSE_COLLECTION_DEADLINE", () => {
  it("永不完成的 JSON 在整体等待 deadline 返回 unavailable 并释放资源", async () => {
    const page = new FakePage();
    const collector = createDouyinResponseCollector(page.asPage(), [], { lifetimeMs: 2_000 });
    emitResponse(page, () => new Promise(() => undefined));
    const waiting = collector.waitFor("222", 150);
    await vi.advanceTimersByTimeAsync(150);
    expect(await waiting).toBeNull();
    expectReleased(page);
    expect(await collector.waitFor("222", 150)).toBeNull();
  });

  it("Protected DOUYIN_RESPONSE_COLLECTION_DEADLINE：hung A 不阻塞 100ms 后合法 B", async () => {
    const page = new FakePage();
    const collector = createDouyinResponseCollector(page.asPage(), []);
    const valid = deferred<unknown>();
    emitResponse(page, () => new Promise(() => undefined));
    emitResponse(page, () => valid.promise);
    const waiting = collector.waitFor("222", 1_000);
    setTimeout(() => valid.resolve(item()), 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toMatchObject({ item: { aweme_id: "222", desc: "当前作品" }, source: "NETWORK_RESPONSE" });
    expectReleased(page);
  });

  it("单响应超时丢弃迟到 A，整体 deadline 内仍能接收 B", async () => {
    const page = new FakePage();
    const collector = createDouyinResponseCollector(page.asPage(), [], { responseTimeoutMs: 50 });
    const late = deferred<unknown>();
    emitResponse(page, () => late.promise);
    const waiting = collector.waitFor("222", 500);
    const settled = vi.fn();
    void waiting.then(settled);
    await vi.advanceTimersByTimeAsync(60);
    late.resolve(item("222", "过期内容"));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    emitResponse(page, async () => item("222", "新证据"));
    expect(await waiting).toMatchObject({ item: { desc: "新证据" } });
    expectReleased(page);
  });

  it("identity-only A 不终结采集，仍等待后到的当前作品合法 B", async () => {
    const page = new FakePage();
    const collector = createDouyinResponseCollector(page.asPage(), []);
    emitResponse(page, async () => ({ aweme_detail: { aweme_id: "222" } }));
    await vi.advanceTimersByTimeAsync(0);
    const waiting = collector.waitFor("222", 500);
    const settled = vi.fn();
    void waiting.then(settled);
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).not.toHaveBeenCalled();
    emitResponse(page, async () => item("222", "有效作品内容"));
    expect(await waiting).toMatchObject({ item: { aweme_id: "222", desc: "有效作品内容" } });
    expectReleased(page);
  });

  it("即使 timer 尚未调度，超过 parseDeadline 的 Promise 结果仍拒绝", async () => {
    const page = new FakePage();
    const collector = createDouyinResponseCollector(page.asPage(), [], { responseTimeoutMs: 50 });
    const late = deferred<unknown>();
    emitResponse(page, () => late.promise);
    const waiting = collector.waitFor("222", 500);
    const settled = vi.fn();
    void waiting.then(settled);
    vi.setSystemTime(Date.now() + 60);
    late.resolve(item("222", "超期但timer未运行"));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    emitResponse(page, async () => item("222", "期限内响应"));
    expect(await waiting).toMatchObject({ item: { desc: "期限内响应" } });
    expectReleased(page);
  });

  it("导航前启动的 collector 即使未调用 waitFor 也受绝对 lifetime 限制", async () => {
    const page = new FakePage();
    const collector = createDouyinResponseCollector(page.asPage(), [], { lifetimeMs: 100, responseTimeoutMs: 1_000 });
    const late = deferred<unknown>();
    emitResponse(page, () => late.promise);
    await vi.advanceTimersByTimeAsync(100);
    late.resolve(item());
    expect(await collector.waitFor("222", 10_000)).toBeNull();
    expectReleased(page);
  });

  it("导航期间已完成的 current JSON 可使用，错误 ID 与 JSON failure 不阻塞", async () => {
    const page = new FakePage();
    const chain: string[] = [];
    const collector = createDouyinResponseCollector(page.asPage(), chain);
    emitResponse(page, async () => null, "https://www.douyin.com/note/222", true);
    emitResponse(page, async () => { throw new Error("invalid JSON"); });
    emitResponse(page, async () => item("111"));
    emitResponse(page, async () => item());
    await vi.advanceTimersByTimeAsync(0);
    expect(await collector.waitFor("222", 500)).toMatchObject({ item: { aweme_id: "222" } });
    expect(collector.mainDocuments).toEqual([{ url: "https://www.douyin.com/note/222", status: 200 }]);
    expect(chain).toContain("https://www.douyin.com/note/222");
    expectReleased(page);
  });

  it("hung burst 的 pending 资源有界，并优先接收后来的合法响应", async () => {
    const page = new FakePage();
    const collector = createDouyinResponseCollector(page.asPage(), []);
    for (let index = 0; index < DOUYIN_RESPONSE_CACHE_LIMIT * 3; index += 1) emitResponse(page, () => new Promise(() => undefined));
    expect(vi.getTimerCount()).toBeLessThanOrEqual(DOUYIN_RESPONSE_CACHE_LIMIT + 1);
    const waiting = collector.waitFor("222", 500);
    emitResponse(page, async () => item());
    expect(await waiting).toMatchObject({ item: { aweme_id: "222" } });
    expectReleased(page);
  });

  it("导航期间 completed cache 有界且最近 current 证据仍可使用", async () => {
    const page = new FakePage();
    const collector = createDouyinResponseCollector(page.asPage(), []);
    for (let index = 0; index < DOUYIN_RESPONSE_CACHE_LIMIT + 2; index += 1) {
      emitResponse(page, async () => item(String(index)));
      await Promise.resolve();
    }
    expect(await collector.waitFor(String(DOUYIN_RESPONSE_CACHE_LIMIT + 1), 500)).toMatchObject({ item: { aweme_id: String(DOUYIN_RESPONSE_CACHE_LIMIT + 1) } });
    expectReleased(page);
  });

  it.each(["PAUSE", "CANCEL"])("%s 通过 AbortSignal 终结等待并允许 generation cleanup 完成", async () => {
    const page = new FakePage();
    const handle = startOwnedExtraction({ platform: "DOUYIN", batchId: "batch", taskId: "task", runEpoch: 1, claimEpoch: 1 });
    acquireBrowserOwner(handle);
    const collector = createDouyinResponseCollector(page.asPage(), [], {
      signal: handle.signal, isCurrentGeneration: () => isCurrentBrowserOwner(handle) && !isStaleExtractionCompletion(handle),
    });
    const late = deferred<unknown>();
    emitResponse(page, () => late.promise);
    const waiting = trackOwnedExtraction(handle, collector.waitFor("222", 10_000));
    const rejected = expect(waiting).rejects.toBeInstanceOf(AutomaticExtractionHandoffCancelledError);
    await requestOwnedExtractionCancellation(handle, async () => undefined);
    await rejected;
    late.resolve(item());
    await Promise.resolve();
    expect(handle.state).toBe("SETTLED");
    expectReleased(page);
  });

  it("stale generation 自动退出，旧 JSON 不能影响新的 owner", async () => {
    const page = new FakePage();
    const old = startOwnedExtraction({ platform: "DOUYIN", batchId: "batch", taskId: "old", runEpoch: 1, claimEpoch: 1 });
    acquireBrowserOwner(old);
    const collector = createDouyinResponseCollector(page.asPage(), [], {
      signal: old.signal, isCurrentGeneration: () => isCurrentBrowserOwner(old) && !isStaleExtractionCompletion(old),
    });
    const late = deferred<unknown>();
    emitResponse(page, () => late.promise);
    const waiting = trackOwnedExtraction(old, collector.waitFor("222", 10_000));
    const rejected = expect(waiting).rejects.toBeInstanceOf(AutomaticExtractionHandoffCancelledError);
    const current = startOwnedExtraction({ platform: "DOUYIN", batchId: "batch", taskId: "new", runEpoch: 2, claimEpoch: 2 });
    acquireBrowserOwner(current);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    const next = createDouyinResponseCollector(page.asPage(), [], { signal: current.signal });
    late.resolve(item("222", "旧 generation"));
    const nextWait = next.waitFor("222", 500);
    emitResponse(page, async () => item("222", "新 generation"));
    expect(await nextWait).toMatchObject({ item: { desc: "新 generation" } });
    expect(isCurrentBrowserOwner(current)).toBe(true);
    expectReleased(page);
  });

  it("新 collector 不读取启动前请求的迟到 response", async () => {
    const page = new FakePage();
    const oldJson = vi.fn(async () => item("222", "旧请求"));
    const old = responseFor(page, oldJson);
    page.emit("request", old.request);
    const collector = createDouyinResponseCollector(page.asPage(), []);
    const waiting = collector.waitFor("222", 50);
    page.emit("response", old.response);
    await vi.advanceTimersByTimeAsync(50);
    expect(await waiting).toBeNull();
    expect(oldJson).not.toHaveBeenCalled();
    expectReleased(page);
  });

  it("page close 结束等待并忽略迟到 JSON，不主动关闭其他 owner 页面", async () => {
    const page = new FakePage();
    const collector = createDouyinResponseCollector(page.asPage(), []);
    const late = deferred<unknown>();
    emitResponse(page, () => late.promise);
    const waiting = collector.waitFor("222", 10_000);
    const rejected = expect(waiting).rejects.toMatchObject({ code: "BROWSER_CONTROL_ERROR" });
    page.closePage();
    await rejected;
    late.resolve(item());
    await Promise.resolve();
    expectReleased(page);
  });

  it("dispose 释放 listener、timer 和 pending callback，重复调用幂等", async () => {
    const page = new FakePage();
    const collector = createDouyinResponseCollector(page.asPage(), []);
    const late = deferred<unknown>();
    emitResponse(page, () => late.promise);
    const waiting = collector.waitFor("222", 10_000);
    collector.dispose();
    collector.dispose();
    late.reject(new Error("迟到网络失败"));
    expect(await waiting).toBeNull();
    expectReleased(page);
  });
});
