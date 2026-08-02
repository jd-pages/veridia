import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  deleteAuditResults: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/audit-result-deletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit-result-deletion")>()),
  deleteAuditResults: mocks.deleteAuditResults,
}));

import { POST } from "@/app/api/results/batch-delete/route";
import { DELETE } from "@/app/api/results/[id]/route";

const users = {
  ADMIN: {
    id: "admin-1",
    accountId: "account-admin",
    username: "admin",
    displayName: "管理员",
    role: "ADMIN",
    expiresAt: null,
  },
  OPERATOR: {
    id: "operator-1",
    accountId: "account-operator",
    username: "operator",
    displayName: "编辑员",
    role: "OPERATOR",
    expiresAt: null,
  },
  VIEWER: {
    id: "viewer-1",
    accountId: "account-viewer",
    username: "viewer",
    displayName: "查看员",
    role: "VIEWER",
    expiresAt: null,
  },
} as const;

function singleDelete(id = "result-1") {
  return DELETE(new Request(`http://localhost/api/results/${id}`), {
    params: Promise.resolve({ id }),
  });
}

function batchDelete(ids: unknown) {
  return POST(
    new Request("http://localhost/api/results/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(users.ADMIN);
  mocks.deleteAuditResults.mockResolvedValue({
    deletedCount: 1,
    deletedIds: ["result-1"],
  });
});

describe("审核结果删除接口权限与输入", () => {
  it("ADMIN 可以单条删除", async () => {
    const response = await singleDelete();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { deletedCount: 1 },
    });
    expect(mocks.deleteAuditResults).toHaveBeenCalledWith({
      ids: ["result-1"],
      userId: "admin-1",
      mode: "SINGLE",
    });
  });

  it("ADMIN 可以批量删除且 ID 会去重", async () => {
    mocks.deleteAuditResults.mockResolvedValueOnce({
      deletedCount: 2,
      deletedIds: ["result-1", "result-2"],
    });
    const response = await batchDelete(["result-1", "result-1", "result-2"]);
    expect(response.status).toBe(200);
    expect(mocks.deleteAuditResults).toHaveBeenCalledWith({
      ids: ["result-1", "result-2"],
      userId: "admin-1",
      mode: "BULK",
    });
  });

  it.each([users.OPERATOR, users.VIEWER])(
    "$role 直接调用单条和批量接口均返回 403",
    async (user) => {
      mocks.getSession.mockResolvedValue(user);
      expect((await singleDelete()).status).toBe(403);
      expect((await batchDelete(["result-1"])).status).toBe(403);
      expect(mocks.deleteAuditResults).not.toHaveBeenCalled();
    },
  );

  it("拒绝空数组和超过 200 个唯一 ID", async () => {
    expect((await batchDelete([])).status).toBe(400);
    expect(
      (
        await batchDelete(
          Array.from({ length: 201 }, (_, index) => `result-${index}`),
        )
      ).status,
    ).toBe(400);
    expect(mocks.deleteAuditResults).not.toHaveBeenCalled();
  });

  it("不存在的 ID 可安全返回零", async () => {
    mocks.deleteAuditResults.mockResolvedValueOnce({
      deletedCount: 0,
      deletedIds: [],
    });
    const response = await singleDelete("missing-result");
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { deletedCount: 0, deletedIds: [] },
    });
  });
});
