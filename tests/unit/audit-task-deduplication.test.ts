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
  findBlockingAuditTask,
  localNaturalDayRange,
} from "@/lib/audit-task-deduplication";

function task(input?: {
  id?: string;
  url?: string;
  normalizedUrl?: string;
  finalUrl?: string | null;
  platformNoteId?: string | null;
  noteUrl?: string;
}) {
  const url =
    input?.url || "https://www.xiaohongshu.com/explore/note-1";
  return {
    id: input?.id || "task-1",
    url,
    normalizedUrl: input?.normalizedUrl || url,
    finalUrl: input?.finalUrl ?? null,
    auditResults: input?.platformNoteId
      ? [
          {
            note: {
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
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            expect.objectContaining({ OR: expect.any(Array) }),
            {
              OR: [
                { createdAt: { gte: start, lt: end } },
                {
                  auditResults: {
                    some: { auditedAt: { gte: start, lt: end } },
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(JSON.stringify(mocks.findMany.mock.calls[0][0].where)).not.toContain(
      "campaignId",
    );
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
});
