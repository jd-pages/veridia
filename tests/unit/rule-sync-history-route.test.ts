import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db", () => ({
  prisma: { ruleSyncHistory: { findMany: mocks.findMany } },
}));

import { GET } from "@/app/api/rule-sync/history/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({
    id: "admin-1",
    accountId: "account-admin",
    username: "admin",
    displayName: "管理员",
    role: "ADMIN",
    expiresAt: null,
  });
});

describe("规则同步记录接口", () => {
  it("向普通客户端返回真实错误码和技术原因", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "history-1",
        ruleVersion: "rules-2026.08.01.2",
        schemaVersion: 1,
        source: "GITHUB",
        status: "FAILED",
        errorCode: "ETIMEDOUT",
        message: "暂时无法获取最新规则，已继续使用本地规则。",
        detailsJson: JSON.stringify({
          technicalMessage: "fetch failed；连接超时",
        }),
        startedAt: new Date("2026-08-04T00:00:00.000Z"),
        completedAt: new Date("2026-08-04T00:00:20.000Z"),
      },
    ]);

    const response = await GET();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data[0]).toMatchObject({
      errorCode: "ETIMEDOUT",
      technicalMessage: "fetch failed；连接超时",
      startedAt: "2026-08-04T00:00:00.000Z",
    });
    expect(payload.data[0]).not.toHaveProperty("detailsJson");
  });

  it("损坏的历史详情不会影响同步记录列表", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "history-2",
        ruleVersion: null,
        schemaVersion: 1,
        source: "GITHUB",
        status: "FAILED",
        errorCode: "RULE_SYNC_FAILED",
        message: null,
        detailsJson: "invalid-json",
        startedAt: new Date("2026-08-04T00:00:00.000Z"),
        completedAt: null,
      },
    ]);

    const payload = await (await GET()).json();
    expect(payload.data[0].technicalMessage).toBeNull();
  });
});
