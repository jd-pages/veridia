import { PrismaClient, type AuditTask } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  auditIngestExtraction,
  createAuditIngestFixture,
} from "../helpers/audit-ingest-fixture";
import { removeTemporaryDirectoryWithRetry } from "../helpers/remove-temporary-directory";
import type { OwnedExtractionHandle } from "@/lib/automation/generation-lifecycle";
import type { PlatformAutomationRuntime } from "@/lib/automation/platform-runtime";

const isolated = vi.hoisted(() => {
  const extract: PlatformAutomationRuntime["extract"] = (task, lifecycle) => {
    void task;
    void lifecycle;
    return new Promise<never>(() => undefined);
  };
  return {
    db: undefined as PrismaClient | undefined,
    extract,
    extractionCalls: 0,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  get prisma() {
    return isolated.db;
  },
}));
vi.mock("@/lib/automation/platform-runtime", () => ({
  automationRuntime: () => ({
    platform: "XIAOHONGSHU",
    sessionId: "queue-timeout-invariant",
    browserSessionType: "XHS_PERSISTENT_CONTEXT",
    browserPlatform: "XIAOHONGSHU",
    adapterName: "playwright-xiaohongshu",
    adapterPlatform: "XIAOHONGSHU",
    classifierName: "classifyAutomaticPage",
    classifierPlatform: "XIAOHONGSHU",
    profilePath: () => "isolated-test-profile",
    extract: (task: AuditTask, lifecycle: OwnedExtractionHandle) =>
      isolated.extract(task, lifecycle),
    pacing: async () => ({
      concurrency: 1,
      waitMinMs: 1,
      waitMaxMs: 1,
      maxNetworkRetries: 0,
      firstRetryMs: 1,
      secondRetryMs: 1,
      cooldownTaskCount: 25,
      cooldownMs: 1,
    }),
    ensureBrowserReady: async () => undefined,
    cancelActiveExtraction: async () => undefined,
    updateLock: () => undefined,
    heartbeatLock: () => undefined,
    clearLock: () => false,
    markSessionIssue: async () => undefined,
  }),
}));

import {
  getGenerationLifecycleDiagnostics,
  resetGenerationLifecycleForTesting,
} from "@/lib/automation/generation-lifecycle";
import { kickAutomaticAuditQueue } from "@/lib/automation/queue";
import { automaticAuditQueueState } from "@/lib/automation/runtime-state";

let temporaryRoot: string;
let db: PrismaClient;
let fixture: Awaited<ReturnType<typeof createAuditIngestFixture>>;

beforeAll(async () => {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "veridia-queue-timeout-invariant-"),
  );
  const databasePath = path.join(temporaryRoot, "isolated.db");
  fs.writeFileSync(databasePath, "");
  const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
  execFileSync(
    process.execPath,
    [
      path.resolve("node_modules/prisma/build/index.js"),
      "migrate",
      "deploy",
      "--schema",
      path.resolve("prisma/schema.prisma"),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
      windowsHide: true,
      timeout: 120_000,
    },
  );
  db = new PrismaClient({ datasourceUrl: databaseUrl });
  isolated.db = db;
  fixture = await createAuditIngestFixture(db);
}, 120_000);

beforeEach(() => {
  vi.stubEnv("AUTOMATION_EXTRACTION_DEADLINE_MS", "100");
  vi.stubEnv("AUTOMATION_BROWSER_CLEANUP_DEADLINE_MS", "100");
  isolated.extractionCalls = 0;
  isolated.extract = (task, lifecycle) => {
    void lifecycle;
    isolated.extractionCalls += 1;
    return isolated.extractionCalls === 1
      ? new Promise<never>(() => undefined)
      : Promise.resolve({ note: auditIngestExtraction(task), warnings: [] });
  };
  Object.assign(automaticAuditQueueState, {
    runner: undefined,
    recovery: undefined,
    activeBatchId: undefined,
    activePlatform: undefined,
    wakeGeneration: undefined,
    runnerGeneration: undefined,
    activeExtraction: undefined,
  });
  resetGenerationLifecycleForTesting();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetGenerationLifecycleForTesting();
});

afterAll(async () => {
  await db?.auditBatch.deleteMany({
    where: { name: { startsWith: "Queue timeout invariant" } },
  });
  await fixture?.cleanup();
  await db?.$disconnect();
  isolated.db = undefined;
  if (temporaryRoot) {
    const resolved = path.resolve(temporaryRoot);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("veridia-queue-timeout-invariant-")
    ) {
      throw new Error("拒绝清理非测试临时目录");
    }
    await removeTemporaryDirectoryWithRetry(resolved);
  }
});

describe("automatic queue extraction deadline invariant", () => {
  it("hung extraction 超时后写入 LOAD_TIMEOUT 并继续后续 Task，不遗留 PROCESSING orphan", async () => {
    const suffix = Date.now();
    const batch = await db.auditBatch.create({
      data: {
        name: `Queue timeout invariant ${suffix}`,
        productId: fixture.product.id,
        campaignId: fixture.campaign.id,
        source: "AUTOMATIC",
        channel: "XIAOHONGSHU",
        status: "QUEUED",
        totalCount: 2,
        intervalMs: 1,
        tasks: {
          create: [0, 1].map((queueOrder) => {
            const url = `http://localhost/mock/xhs?queue-timeout-invariant=${suffix}-${queueOrder}`;
            return {
              url,
              normalizedUrl: url,
              productId: fixture.product.id,
              campaignId: fixture.campaign.id,
              productStage: "IFFO_2",
              source: "AUTOMATIC",
              platform: "XIAOHONGSHU",
              channel: "XIAOHONGSHU",
              queueOrder,
              status: "PENDING",
            };
          }),
        },
      },
    });

    kickAutomaticAuditQueue();
    await automaticAuditQueueState.runner;

    const finalBatch = await db.auditBatch.findUniqueOrThrow({
      where: { id: batch.id },
      include: {
        tasks: {
          orderBy: { queueOrder: "asc" },
          include: { auditResults: true },
        },
      },
    });
    expect(finalBatch).toMatchObject({
      status: "COMPLETED_WITH_ERRORS",
      currentTaskId: null,
    });
    expect(finalBatch.tasks[0]).toMatchObject({
      status: "READ_FAILED",
      claimEpoch: null,
      failureCode: "LOAD_TIMEOUT",
    });
    expect(finalBatch.tasks[0].auditResults).toHaveLength(1);
    expect(finalBatch.tasks[1]).toMatchObject({
      claimEpoch: null,
      attempts: 1,
    });
    expect(finalBatch.tasks[1].status).toMatch(
      /^(?:COMPLETED|FAILED|READ_FAILED|NEEDS_REVIEW)$/u,
    );
    expect(finalBatch.tasks[1].failureCode).not.toBe("LOAD_TIMEOUT");
    expect(finalBatch.tasks[1].auditResults).toHaveLength(1);
    expect(isolated.extractionCalls).toBe(2);
    expect(finalBatch.tasks.some((task) => task.status === "PROCESSING")).toBe(
      false,
    );
    expect(getGenerationLifecycleDiagnostics()).toMatchObject({
      activeExtractionCount: 0,
      pendingCleanupBarrierCount: 0,
      activeBrowserOwnerGenerations: [],
    });
  });
});
