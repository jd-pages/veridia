import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { auditTask: { findMany: mocks.findMany } },
}));

import {
  auditNoteIdentity,
  auditTaskLinksMatch,
  findBlockingAuditTask,
} from "@/lib/audit-task-deduplication";

function task(input: {
  id?: string;
  status: string;
  url?: string;
  normalizedUrl?: string;
  finalUrl?: string | null;
  result?: boolean;
}) {
  const url =
    input.url || "https://www.xiaohongshu.com/explore/note-1";
  return {
    id: input.id || "task-1",
    status: input.status,
    url,
    normalizedUrl: input.normalizedUrl || url,
    finalUrl: input.finalUrl ?? null,
    auditResults: input.result ? [{ id: "result-1" }] : [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
});

describe("审核任务去重边界", () => {
  it.each(["PENDING", "PROCESSING", "LOGIN_EXPIRED"])(
    "%s 活跃任务仍然阻止重复创建",
    async (status) => {
      mocks.findMany.mockResolvedValueOnce([task({ status })]);
      await expect(
        findBlockingAuditTask({
          url: "https://www.xiaohongshu.com/explore/note-1",
          campaignId: "campaign-1",
        }),
      ).resolves.toMatchObject({ reason: "ACTIVE_TASK" });
    },
  );

  it("未删除的有效审核结果仍然阻止重复创建", async () => {
    mocks.findMany.mockResolvedValueOnce([
      task({ status: "COMPLETED", result: true }),
    ]);
    await expect(
      findBlockingAuditTask({
        url: "https://www.xiaohongshu.com/explore/note-1",
        campaignId: "campaign-1",
      }),
    ).resolves.toMatchObject({ reason: "EXISTING_RESULT" });
  });

  it.each(["COMPLETED", "FAILED", "READ_FAILED", "CANCELLED"])(
    "%s 历史任务在结果删除后不再阻止重新审核",
    async (status) => {
      mocks.findMany.mockResolvedValueOnce([task({ status })]);
      await expect(
        findBlockingAuditTask({
          url: "https://www.xiaohongshu.com/explore/note-1",
          campaignId: "campaign-1",
        }),
      ).resolves.toBeNull();
    },
  );

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
