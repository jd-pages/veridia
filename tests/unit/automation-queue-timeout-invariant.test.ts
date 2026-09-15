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
import {
  AutomaticExtractionError,
  type AutomaticFailureCode,
} from "@/lib/automation/failure";

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
    platform: "XIAOHONGSHU" as "XIAOHONGSHU" | "DOUYIN",
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
    platform: isolated.platform,
    sessionId: "queue-timeout-invariant",
    browserSessionType: "XHS_PERSISTENT_CONTEXT",
    browserPlatform: isolated.platform,
    adapterName: "playwright-xiaohongshu",
    adapterPlatform: isolated.platform,
    classifierName: "classifyAutomaticPage",
    classifierPlatform: isolated.platform,
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

beforeEach(async () => {
  vi.stubEnv("AUTOMATION_EXTRACTION_DEADLINE_MS", "100");
  vi.stubEnv("AUTOMATION_BROWSER_CLEANUP_DEADLINE_MS", "100");
  isolated.extractionCalls = 0;
  isolated.platform = "XIAOHONGSHU";
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
  await db.campaign.update({
    where: { id: fixture.campaign.id },
    data: { contentChannel: "XIAOHONGSHU" },
  });
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

  async function expectDouyinTechnicalFailureStops(
    failureCode: AutomaticFailureCode,
  ) {
      isolated.platform = "DOUYIN";
      await db.campaign.update({
        where: { id: fixture.campaign.id },
        data: { contentChannel: "DOUYIN" },
      });
      isolated.extract = async () => {
        isolated.extractionCalls += 1;
        throw new AutomaticExtractionError(failureCode, `测试 ${failureCode}`);
      };
      const suffix = `${failureCode}-${Date.now()}`;
      const batch = await db.auditBatch.create({
        data: {
          name: `Queue timeout invariant DOUYIN ${suffix}`,
          productId: fixture.product.id,
          campaignId: fixture.campaign.id,
          source: "AUTOMATIC",
          channel: "DOUYIN",
          status: "QUEUED",
          totalCount: 3,
          intervalMs: 1,
          tasks: {
            create: [0, 1, 2].map((queueOrder) => {
              const url = `http://localhost/mock/douyin?case=video&fail-stop=${suffix}-${queueOrder}`;
              return {
                url,
                normalizedUrl: url,
                productId: fixture.product.id,
                campaignId: fixture.campaign.id,
                source: "AUTOMATIC",
                platform: "DOUYIN",
                channel: "DOUYIN",
                queueOrder,
                status: "PENDING",
              };
            }),
          },
        },
      });

      kickAutomaticAuditQueue();
      await automaticAuditQueueState.runner;

      const stopped = await db.auditBatch.findUniqueOrThrow({
        where: { id: batch.id },
        include: {
          tasks: {
            orderBy: { queueOrder: "asc" },
            include: { auditResults: true, extractions: true },
          },
        },
      });
      expect(stopped).toMatchObject({ status: "PAUSED", currentTaskId: null });
      expect(stopped.tasks[0]).toMatchObject({
        status: "READ_FAILED",
        failureCode,
        attempts: 1,
        claimEpoch: null,
      });
      expect(stopped.tasks[0].auditResults).toHaveLength(1);
      expect(stopped.tasks[0].extractions).toHaveLength(1);
      for (const task of stopped.tasks.slice(1)) {
        expect(task).toMatchObject({
          status: "PENDING",
          attempts: 0,
          startedAt: null,
          claimEpoch: null,
        });
        expect(task.auditResults).toHaveLength(0);
        expect(task.extractions).toHaveLength(0);
      }
      expect(isolated.extractionCalls).toBe(1);

      kickAutomaticAuditQueue();
      await automaticAuditQueueState.runner;
      const afterWake = await db.auditBatch.findUniqueOrThrow({
        where: { id: batch.id },
        include: { tasks: { orderBy: { queueOrder: "asc" } } },
      });
      expect(afterWake.status).toBe("PAUSED");
      expect(afterWake.tasks.slice(1).map((task) => [task.status, task.attempts]))
        .toEqual([["PENDING", 0], ["PENDING", 0]]);
  }

  it(
    "Protected DOUYIN_TECHNICAL_FAILURE_FAIL_STOP：STRUCTURE_MISMATCH 保存当前失败并暂停后续任务",
    () => expectDouyinTechnicalFailureStops("STRUCTURE_MISMATCH"),
  );

  it.each([
    "REDIRECT_FAILED",
    "LOAD_TIMEOUT",
    "NETWORK_ERROR",
    "PAGE_READ_FAILED",
    "BODY_NOT_RECOGNIZED",
    "TOPICS_NOT_RECOGNIZED",
    "NO_PERMISSION",
  ] as AutomaticFailureCode[])(
    "抖音其他技术失败 %s 同样 fail closed",
    expectDouyinTechnicalFailureStops,
  );

  it("未知抖音 extraction exception 默认 fail closed", async () => {
    isolated.platform = "DOUYIN";
    await db.campaign.update({
      where: { id: fixture.campaign.id },
      data: { contentChannel: "DOUYIN" },
    });
    isolated.extract = async () => {
      isolated.extractionCalls += 1;
      throw new Error("unknown synthetic platform failure");
    };
    const suffix = Date.now();
    const batch = await db.auditBatch.create({
      data: {
        name: `Queue timeout invariant DOUYIN UNKNOWN ${suffix}`,
        productId: fixture.product.id,
        campaignId: fixture.campaign.id,
        source: "AUTOMATIC",
        channel: "DOUYIN",
        status: "QUEUED",
        totalCount: 1,
        intervalMs: 1,
        tasks: { create: {
          url: `http://localhost/mock/douyin?unknown=${suffix}`,
          normalizedUrl: `http://localhost/mock/douyin?unknown=${suffix}`,
          productId: fixture.product.id,
          campaignId: fixture.campaign.id,
          source: "AUTOMATIC",
          platform: "DOUYIN",
          channel: "DOUYIN",
          queueOrder: 0,
          status: "PENDING",
        } },
      },
    });
    kickAutomaticAuditQueue();
    await automaticAuditQueueState.runner;
    expect(await db.auditBatch.findUniqueOrThrow({ where: { id: batch.id } }))
      .toMatchObject({ status: "PAUSED", lastErrorCode: "NETWORK_ERROR" });
    expect(await db.auditTask.findFirstOrThrow({ where: { batchId: batch.id } }))
      .toMatchObject({ status: "READ_FAILED", failureCode: "NETWORK_ERROR" });
  });
});
