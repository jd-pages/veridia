import type { Page } from "playwright";

export type XhsPageRole =
  | "AUDIT"
  | "LOGIN"
  | "INTERACTIVE"
  | "ANCHOR_BLANK"
  | "UNCLAIMED_RESTORED"
  | "UNKNOWN";

export type XhsPageSource =
  | "AUDIT_CREATE"
  | "CONTEXT_EVENT"
  | "CONTEXT_STARTUP"
  | "INTERACTIVE_CLAIM"
  | "LOGIN_CREATE"
  | "POPUP";

export type XhsPageReconcileReason =
  | "CONTEXT_READY"
  | "AUDIT_PAGE_CREATED"
  | "CONTEXT_PAGE_EVENT"
  | "AUDIT_REQUEST"
  | "POST_NAVIGATION";

export interface XhsArbiterPage {
  close(): Promise<void>;
  isClosed(): boolean;
  opener(): Promise<XhsArbiterPage | null>;
  url(): string;
}

export interface XhsArbiterContext<P extends XhsArbiterPage> {
  on(event: "page", listener: (page: P) => void): unknown;
  pages(): P[];
}

type PageMetadata = {
  createdAt: string;
  generation: number;
  roles: Set<XhsPageRole>;
  source: XhsPageSource;
};

type OwnedPages<P extends XhsArbiterPage> = {
  audit?: P;
  interactive?: P;
  login?: P;
};

type ArbiterLog = Record<string, unknown> & {
  generation: number;
};

type ArbiterOptions<P extends XhsArbiterPage> = {
  classifyOwnedPopup?: (
    page: P,
    opener: P,
  ) => XhsPageRole | undefined;
  closeRetryDelaysMs?: number[];
  context: XhsArbiterContext<P>;
  generation: number;
  getOwnedPages: () => OwnedPages<P>;
  isCurrentGeneration: () => boolean;
  log: (event: string, details: ArbiterLog) => void;
  maxStabilizationMs?: number;
  onAsyncInvariantFailure: (error: Error) => Promise<void> | void;
  quietWindowMs?: number;
  safeUrl: (value: string) => string;
};

export type XhsPageReconcileResult = {
  active: boolean;
  auditPageCount: number;
  closedStalePageCount: number;
  contentPageCount: number;
  interactivePageCount: number;
  loginPageCount: number;
  pageCount: number;
  stalePageCount: number;
};

const DEFAULT_QUIET_WINDOW_MS = 300;
const DEFAULT_MAX_STABILIZATION_MS = 1_500;
const DEFAULT_CLOSE_RETRY_DELAYS_MS = [50, 100, 200];

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function primaryRole(roles: Set<XhsPageRole>): XhsPageRole {
  for (const role of [
    "AUDIT",
    "LOGIN",
    "INTERACTIVE",
    "ANCHOR_BLANK",
    "UNCLAIMED_RESTORED",
    "UNKNOWN",
  ] as const) {
    if (roles.has(role)) return role;
  }
  return "UNKNOWN";
}

export class XhsPageInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XhsPageInvariantError";
  }
}

export class XhsContextPageArbiter<P extends XhsArbiterPage = Page> {
  private readonly metadata = new WeakMap<P, PageMetadata>();
  private readonly closeRetryDelaysMs: number[];
  private readonly maxStabilizationMs: number;
  private readonly quietWindowMs: number;
  private disposed = false;
  private lastPageEventAt = Date.now();
  private pendingClassifications = 0;
  private reconcileTail: Promise<unknown> = Promise.resolve();
  private reconcileTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ArbiterOptions<P>) {
    this.closeRetryDelaysMs =
      options.closeRetryDelaysMs || DEFAULT_CLOSE_RETRY_DELAYS_MS;
    this.maxStabilizationMs =
      options.maxStabilizationMs || DEFAULT_MAX_STABILIZATION_MS;
    this.quietWindowMs = options.quietWindowMs || DEFAULT_QUIET_WINDOW_MS;
  }

  observeContextPages(launchStartedAt: Date) {
    this.options.context.on("page", (page) => {
      if (!this.active()) return;
      this.registerObservedPage(page, "CONTEXT_EVENT", new Date());
      this.pendingClassifications += 1;
      void page
        .opener()
        .catch(() => null)
        .then((opener) => {
          if (!this.active()) return;
          const metadata = this.metadata.get(page);
          if (!metadata) return;
          if (opener) {
            metadata.source = "POPUP";
            const role = this.options.classifyOwnedPopup?.(
              page,
              opener as P,
            );
            if (role) this.claimPage(page, role, "POPUP");
          }
        })
        .finally(() => {
          this.pendingClassifications = Math.max(
            0,
            this.pendingClassifications - 1,
          );
          this.scheduleEventReconciliation();
        });
    });
    for (const page of this.options.context.pages()) {
      this.registerObservedPage(page, "CONTEXT_STARTUP", launchStartedAt);
    }
  }

  claimPage(page: P, role: XhsPageRole, source: XhsPageSource) {
    const metadata = this.ensureMetadata(page, source, new Date());
    metadata.generation = this.options.generation;
    metadata.source = source;
    metadata.roles.delete("UNKNOWN");
    metadata.roles.delete("UNCLAIMED_RESTORED");
    if (role !== "ANCHOR_BLANK") metadata.roles.delete("ANCHOR_BLANK");
    if (role === "AUDIT") metadata.roles.delete("LOGIN");
    if (role === "LOGIN") metadata.roles.delete("AUDIT");
    metadata.roles.add(role);
  }

  releasePageRole(page: P, role: XhsPageRole) {
    const metadata = this.metadata.get(page);
    if (!metadata) return;
    metadata.roles.delete(role);
    if (!metadata.roles.size) metadata.roles.add("UNKNOWN");
  }

  async createClaimedPage(
    role: XhsPageRole,
    source: XhsPageSource,
    create: () => Promise<P>,
  ) {
    this.pendingClassifications += 1;
    try {
      const page = await create();
      this.claimPage(page, role, source);
      return page;
    } finally {
      this.pendingClassifications = Math.max(
        0,
        this.pendingClassifications - 1,
      );
    }
  }

  metadataFor(page: P) {
    const metadata = this.metadata.get(page);
    return metadata
      ? {
          createdAt: metadata.createdAt,
          generation: metadata.generation,
          role: primaryRole(metadata.roles),
          roles: [...metadata.roles],
          source: metadata.source,
        }
      : undefined;
  }

  async settleAndReconcile(reason: XhsPageReconcileReason) {
    const startedAt = Date.now();
    while (this.active()) {
      const now = Date.now();
      const quietFor = now - this.lastPageEventAt;
      if (
        this.pendingClassifications === 0 &&
        quietFor >= this.quietWindowMs
      ) {
        break;
      }
      if (now - startedAt >= this.maxStabilizationMs) {
        throw new XhsPageInvariantError(
          `XHS Page restore burst 未在 ${this.maxStabilizationMs}ms 内稳定`,
        );
      }
      await wait(
        Math.max(
          1,
          Math.min(
            25,
            this.quietWindowMs - Math.min(quietFor, this.quietWindowMs),
          ),
        ),
      );
    }
    return this.reconcile(reason);
  }

  async reconcile(reason: XhsPageReconcileReason) {
    const run = () => this.reconcileNow(reason);
    const result = this.reconcileTail.then(run, run);
    this.reconcileTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  dispose() {
    this.disposed = true;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
  }

  private active() {
    return !this.disposed && this.options.isCurrentGeneration();
  }

  private ensureMetadata(
    page: P,
    source: XhsPageSource,
    createdAt: Date,
  ) {
    let metadata = this.metadata.get(page);
    if (!metadata) {
      metadata = {
        createdAt: createdAt.toISOString(),
        generation: this.options.generation,
        roles: new Set<XhsPageRole>([
          page.url() === "about:blank" ? "ANCHOR_BLANK" : "UNKNOWN",
        ]),
        source,
      };
      this.metadata.set(page, metadata);
    }
    return metadata;
  }

  private registerObservedPage(
    page: P,
    source: XhsPageSource,
    createdAt: Date,
  ) {
    if (this.metadata.has(page)) return;
    const metadata = this.ensureMetadata(page, source, createdAt);
    this.lastPageEventAt = Date.now();
    if (source === "CONTEXT_EVENT") {
      this.options.log("XHS_CONTEXT_PAGE_EVENT", {
        ...this.snapshot(page, metadata),
        generation: this.options.generation,
      });
      this.scheduleEventReconciliation();
    }
  }

  private scheduleEventReconciliation() {
    if (!this.active()) return;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      void this.settleAndReconcile("CONTEXT_PAGE_EVENT").catch((error) =>
        this.options.onAsyncInvariantFailure(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    }, this.quietWindowMs);
  }

  private async reconcileNow(
    reason: XhsPageReconcileReason,
  ): Promise<XhsPageReconcileResult> {
    if (!this.active()) return this.result(false, 0);
    const owned = this.options.getOwnedPages();
    const alivePages = this.options.context
      .pages()
      .filter((page) => !page.isClosed());
    let anchorKept = false;
    const stalePages: P[] = [];

    for (const page of alivePages) {
      if (page === owned.audit) {
        this.claimPage(page, "AUDIT", "AUDIT_CREATE");
        continue;
      }
      if (page === owned.login) {
        this.claimPage(page, "LOGIN", "LOGIN_CREATE");
        continue;
      }
      if (page === owned.interactive) {
        this.claimPage(page, "INTERACTIVE", "INTERACTIVE_CLAIM");
        continue;
      }
      const metadata = this.metadata.get(page);
      if (
        metadata?.generation === this.options.generation &&
        (metadata.roles.has("LOGIN") ||
          metadata.roles.has("INTERACTIVE"))
      ) {
        continue;
      }
      if (page.url() === "about:blank" && !anchorKept) {
        anchorKept = true;
        this.claimPage(page, "ANCHOR_BLANK", metadata?.source || "CONTEXT_STARTUP");
        continue;
      }
      const staleMetadata = this.ensureMetadata(
        page,
        metadata?.source || "CONTEXT_EVENT",
        new Date(),
      );
      staleMetadata.roles.clear();
      staleMetadata.roles.add("UNCLAIMED_RESTORED");
      this.options.log("XHS_RESTORED_PAGE_CLASSIFIED", {
        ...this.snapshot(page, staleMetadata),
        generation: this.options.generation,
        reason,
      });
      stalePages.push(page);
    }

    let closedStalePageCount = 0;
    for (const page of stalePages) {
      if (page.isClosed()) continue;
      await this.closeStalePage(page, reason);
      closedStalePageCount += 1;
    }

    const result = this.result(true, closedStalePageCount);
    if (result.stalePageCount > 0 || result.auditPageCount > 1) {
      const error = new XhsPageInvariantError(
        `XHS Page invariant 失败：audit=${result.auditPageCount}, stale=${result.stalePageCount}`,
      );
      this.options.log("XHS_PAGE_INVARIANT_FAILED", {
        ...result,
        generation: this.options.generation,
        reason,
      });
      throw error;
    }
    this.options.log("XHS_PAGE_RECONCILE_COMPLETE", {
      ...result,
      generation: this.options.generation,
      reason,
    });
    return result;
  }

  private async closeStalePage(page: P, reason: XhsPageReconcileReason) {
    const metadata = this.metadata.get(page);
    this.options.log("XHS_STALE_PAGE_CLOSE_REQUESTED", {
      ...this.snapshot(page, metadata),
      generation: this.options.generation,
      reason,
    });
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.closeRetryDelaysMs.length; attempt += 1) {
      try {
        await page.close();
        if (!page.isClosed()) {
          throw new Error("page.close() 返回后 Page 仍未关闭");
        }
        this.options.log("XHS_STALE_PAGE_CLOSED", {
          ...this.snapshot(page, metadata),
          attempt: attempt + 1,
          generation: this.options.generation,
          reason,
        });
        return;
      } catch (error) {
        lastError = error;
        if (page.isClosed()) return;
        const delay = this.closeRetryDelaysMs[attempt];
        if (delay === undefined) break;
        await wait(delay);
      }
    }
    const error = new XhsPageInvariantError(
      `无法关闭恢复的 XHS Page：${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
    this.options.log("XHS_PAGE_INVARIANT_FAILED", {
      ...this.snapshot(page, metadata),
      generation: this.options.generation,
      reason,
    });
    throw error;
  }

  private result(
    active: boolean,
    closedStalePageCount: number,
  ): XhsPageReconcileResult {
    const pages = this.options.context
      .pages()
      .filter((page) => !page.isClosed());
    const owned = this.options.getOwnedPages();
    const stalePageCount = pages.filter((page) =>
      this.metadata.get(page)?.roles.has("UNCLAIMED_RESTORED"),
    ).length;
    return {
      active,
      auditPageCount:
        owned.audit && !owned.audit.isClosed() && pages.includes(owned.audit)
          ? 1
          : 0,
      closedStalePageCount,
      contentPageCount: pages.filter((page) => page.url() !== "about:blank")
        .length,
      interactivePageCount:
        owned.interactive &&
        !owned.interactive.isClosed() &&
        pages.includes(owned.interactive)
          ? 1
          : 0,
      loginPageCount:
        owned.login && !owned.login.isClosed() && pages.includes(owned.login)
          ? 1
          : 0,
      pageCount: pages.length,
      stalePageCount,
    };
  }

  private snapshot(page?: P, metadata?: PageMetadata) {
    const result = this.result(this.active(), 0);
    return {
      ...result,
      pageClosed: page?.isClosed() ?? null,
      role: metadata ? primaryRole(metadata.roles) : null,
      roles: metadata ? [...metadata.roles] : [],
      safeUrl: page ? this.options.safeUrl(page.url()) : null,
      source: metadata?.source || null,
    };
  }
}
