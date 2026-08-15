import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { auditTask: { findMany: mocks.findMany } },
}));

import {
  auditNoteIdentity,
  auditTaskDuplicateMessages,
  auditTaskLinksMatch,
  findAuditTaskDuplicateHistories,
  findBlockingAuditTask,
  localNaturalDayRange,
} from "@/lib/audit-task-deduplication";
import { automaticAuditQueueState } from "@/lib/automation/runtime-state";

function task(input?: {
  id?: string;
  url?: string;
  normalizedUrl?: string;
  finalUrl?: string | null;
  platformNoteId?: string | null;
  noteUrl?: string;
  status?: string;
  batchId?: string | null;
}) {
  const url =
    input?.url || "https://www.xiaohongshu.com/explore/note-1";
  return {
    id: input?.id || "task-1",
    status: input?.status || "PENDING",
    batchId: input?.batchId ?? null,
    url,
    normalizedUrl: input?.normalizedUrl || url,
    finalUrl: input?.finalUrl ?? null,
    auditResults: input?.platformNoteId
      ? [
          {
            note: {
              contentChannel: "XIAOHONGSHU",
              platformNoteId: input.platformNoteId,
              url: input.noteUrl || url,
              finalUrl: null,
            },
          },
        ]
      : [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
  automaticAuditQueueState.runner = undefined;
  automaticAuditQueueState.activeBatchId = undefined;
});

describe("历史重复检测稳定性", () => {
  const historyTask = {
    id: "history-task",
    status: "COMPLETED",
    batchId: "history-batch",
    url: "https://www.xiaohongshu.com/explore/66abc?source=old",
    normalizedUrl: "https://www.xiaohongshu.com/explore/66abc?source=old",
    finalUrl: null,
    notes: null,
    storeName: "示例店铺",
    productStage: "IFFO_2",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    product: { name: "示例产品", brandName: "示例品牌" },
    campaign: { name: "历史活动" },
    batch: { name: "历史批次" },
    auditResults: [
      {
        id: "result-old",
        auditedAt: new Date("2026-08-01T01:00:00.000Z"),
        autoStatus: "PASSED",
        note: {
          contentChannel: "XIAOHONGSHU",
          platformNoteId: "66abc",
          url: "https://www.xiaohongshu.com/explore/66abc",
          finalUrl: null,
        },
        manualReviews: [],
      },
      {
        id: "result-new",
        auditedAt: new Date("2026-08-02T01:00:00.000Z"),
        autoStatus: "FAILED",
        note: {
          contentChannel: "XIAOHONGSHU",
          platformNoteId: "66abc",
          url: "https://www.xiaohongshu.com/explore/66abc",
          finalUrl: null,
        },
        manualReviews: [
          { result: "PASSED", createdAt: new Date("2026-08-02T02:00:00.000Z") },
        ],
      },
    ],
  };

  it("同一输入规范化 100 次 identity 完全一致", () => {
    const input =
      "https://www.xiaohongshu.com/discovery/item/66ABC?xsec_token=a&source=share";
    expect(new Set(Array.from({ length: 100 }, () => auditNoteIdentity(input))))
      .toEqual(new Set(["xhs-note:66abc"]));
  });

  it("完成任务和全部历史结果始终进入历史重复集合", async () => {
    mocks.findMany.mockResolvedValueOnce([historyTask]);
    const input = "https://www.xiaohongshu.com/explore/66abc?source=new";
    const histories = await findAuditTaskDuplicateHistories({ urls: [input] });
    expect(histories.get(input)).toMatchObject({
      identity: "xhs-note:66abc",
      historicalCount: 2,
      sourceTaskIds: ["history-task"],
      latest: {
        autoStatus: "FAILED",
        manualResult: "PASSED",
      },
    });
    expect(histories.get(input)?.histories).toHaveLength(2);
    const where = JSON.stringify(mocks.findMany.mock.calls[0][0].where);
    expect(where).not.toContain("createdAt");
    expect(where).not.toContain("supersededAt");
    expect(where).not.toContain('"status":"PENDING"');
  });

  it("连续查询十次均返回同一重复身份且每次仅执行一次批量查询", async () => {
    mocks.findMany.mockResolvedValue(historyTask ? [historyTask] : []);
    const input = "https://www.xiaohongshu.com/explore/66abc";
    const results = [];
    for (let index = 0; index < 10; index += 1) {
      results.push(await findAuditTaskDuplicateHistories({ urls: [input] }));
    }
    expect(
      results.map((result) => ({
        identity: result.get(input)?.identity,
        count: result.get(input)?.historicalCount,
        latest: result.get(input)?.latest.autoStatus,
      })),
    ).toEqual(
      Array.from({ length: 10 }, () => ({
        identity: "xhs-note:66abc",
        count: 2,
        latest: "FAILED",
      })),
    );
    expect(mocks.findMany).toHaveBeenCalledTimes(10);
  });

  it("一千行只发起一次批量历史查询且不存在逐行 await", async () => {
    mocks.findMany.mockResolvedValueOnce([]);
    await findAuditTaskDuplicateHistories({
      urls: Array.from(
        { length: 1000 },
        (_, index) => `https://www.xiaohongshu.com/explore/perf-${index}`,
      ),
    });
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("审核任务按本地自然日去重", () => {
  const now = new Date(2026, 7, 3, 15, 30, 0);

  it("同一天同一链接重复创建会被拦截", async () => {
    mocks.findMany.mockResolvedValueOnce([task()]);
    await expect(
      findBlockingAuditTask({
        url: "https://www.xiaohongshu.com/explore/note-1",
        now,
      }),
    ).resolves.toEqual({
      taskId: "task-1",
      reason: "TODAY_DUPLICATE",
      message: auditTaskDuplicateMessages.TODAY_DUPLICATE,
    });
  });

  it("同一 canonicalUrl 的不同分享参数仍识别为当天重复", async () => {
    mocks.findMany.mockResolvedValueOnce([
      task({
        url: "https://www.xiaohongshu.com/explore/66abc?source=share-one",
      }),
    ]);
    await expect(
      findBlockingAuditTask({
        url: "https://www.xiaohongshu.com/discovery/item/66abc?xsec_token=two",
        now,
      }),
    ).resolves.toMatchObject({ reason: "TODAY_DUPLICATE" });
  });

  it("历史任务仅保存短链时仍可通过审核结果 noteId 识别当天重复", async () => {
    mocks.findMany.mockResolvedValueOnce([
      task({
        url: "https://xhslink.com/o/old-short-link",
        platformNoteId: "66abc",
        noteUrl: "https://xhslink.com/o/old-short-link",
      }),
    ]);
    await expect(
      findBlockingAuditTask({
        url: "https://www.xiaohongshu.com/explore/66abc?source=share",
        now,
      }),
    ).resolves.toMatchObject({ reason: "TODAY_DUPLICATE" });
    expect(JSON.stringify(mocks.findMany.mock.calls[0][0].where)).toContain(
      '"platformNoteId":"66abc"',
    );
  });

  it("查询只覆盖当天创建或当天审核的任务，不按活动限制历史", async () => {
    await findBlockingAuditTask({
      url: "https://www.xiaohongshu.com/explore/note-1",
      now,
    });
    const { start, end } = localNaturalDayRange(now);
    expect(start).toEqual(new Date(2026, 7, 3, 0, 0, 0, 0));
    expect(end).toEqual(new Date(2026, 7, 4, 0, 0, 0, 0));
    const where = JSON.stringify(mocks.findMany.mock.calls[0][0].where);
    expect(where).toContain('"status":"PENDING"');
    expect(where).toContain('"status":"PROCESSING"');
    expect(where).toContain('"supersededAt":null');
    expect(where).toContain(JSON.stringify(start));
    expect(where).toContain(JSON.stringify(end));
    expect(where).not.toContain("campaignId");
  });

  it.each([
    ["昨天", new Date(2026, 7, 2, 12, 0, 0)],
    ["上个月", new Date(2026, 6, 3, 12, 0, 0)],
  ])("%s 的历史任务不会进入当天查询，可重新创建", async (_label, history) => {
    const { start, end } = localNaturalDayRange(now);
    expect(history.getTime()).toBeLessThan(start.getTime());
    expect(history.getTime()).toBeLessThan(end.getTime());
    await expect(
      findBlockingAuditTask({
        url: "https://www.xiaohongshu.com/explore/note-1",
        now,
      }),
    ).resolves.toBeNull();
  });

  it("短链任务保存最终长链后，两种链接使用同一笔记身份", () => {
    const shortUrl = "https://xhslink.com/o/abc123";
    const finalUrl =
      "https://www.xiaohongshu.com/explore/66abc?xsec_token=token";
    const existing = {
      url: shortUrl,
      normalizedUrl: shortUrl,
      finalUrl,
    };
    expect(auditTaskLinksMatch(shortUrl, existing)).toBe(true);
    expect(
      auditTaskLinksMatch(
        "https://www.xiaohongshu.com/discovery/item/66abc?source=share",
        existing,
      ),
    ).toBe(true);
    expect(auditNoteIdentity(finalUrl)).toBe("xhs-note:66abc");
  });

  it("非小红书普通文本链接不会被无脑视为同一笔记", () => {
    expect(
      auditTaskLinksMatch("https://example.com/a", {
        url: "https://example.com/b",
        normalizedUrl: "https://example.com/b",
        finalUrl: null,
      }),
    ).toBe(false);
  });

  it("已取消且没有当前结果的任务立即释放当天占用", async () => {
    mocks.findMany.mockResolvedValueOnce([task({ status: "CANCELLED" })]);
    await expect(findBlockingAuditTask({
      url: "https://www.xiaohongshu.com/explore/note-1",
      now,
    })).resolves.toBeNull();
  });

  it("已完成任务删除当前结果后立即释放当天占用", async () => {
    mocks.findMany.mockResolvedValueOnce([task({ status: "COMPLETED" })]);
    await expect(findBlockingAuditTask({
      url: "https://www.xiaohongshu.com/explore/note-1",
      now,
    })).resolves.toBeNull();
  });

  it("当前有效结果仍然保持当天防重", async () => {
    mocks.findMany.mockResolvedValueOnce([
      task({ status: "COMPLETED", platformNoteId: "note-1" }),
    ]);
    await expect(findBlockingAuditTask({
      url: "https://www.xiaohongshu.com/explore/note-1",
      now,
    })).resolves.toMatchObject({ reason: "TODAY_DUPLICATE" });
  });

  it("PROCESSING 只有存在当前真实 runner 时才占用当天防重", async () => {
    const processing = task({ status: "PROCESSING", batchId: "batch-1" });
    mocks.findMany.mockResolvedValueOnce([processing]);
    await expect(findBlockingAuditTask({
      url: "https://www.xiaohongshu.com/explore/note-1",
      now,
    })).resolves.toBeNull();

    automaticAuditQueueState.activeBatchId = "batch-1";
    automaticAuditQueueState.runner = Promise.resolve();
    mocks.findMany.mockResolvedValueOnce([processing]);
    await expect(findBlockingAuditTask({
      url: "https://www.xiaohongshu.com/explore/note-1",
      now,
    })).resolves.toMatchObject({ reason: "TODAY_DUPLICATE" });
  });
});
