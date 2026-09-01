import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateTopicRule: vi.fn(),
  deleteTopicRule: vi.fn(),
  deleteMonthlyTopicRules: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/topic-rule-management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/topic-rule-management")>()),
  updateTopicRule: mocks.updateTopicRule,
  deleteTopicRule: mocks.deleteTopicRule,
  deleteMonthlyTopicRules: mocks.deleteMonthlyTopicRules,
}));

import {
  DELETE as deleteRule,
  PUT as updateRule,
} from "@/app/api/rules/[id]/route";
import { DELETE as deleteMonth } from "@/app/api/rules/month/route";

const users = {
  ADMIN: {
    id: "admin-1",
    accountId: "account-admin",
    username: "admin",
    displayName: "管理员",
    role: "ADMIN",
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

function putStatus(status: string) {
  return updateRule(
    new Request("http://localhost/api/rules/rule-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, brandName: "佳贝艾特" }),
    }),
    { params: Promise.resolve({ id: "rule-1" }) },
  );
}

function permanentDelete(mode = "permanent") {
  return deleteRule(
    new Request(
      `http://localhost/api/rules/rule-1?mode=${mode}&brandName=${encodeURIComponent("佳贝艾特")}`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ id: "rule-1" }) },
  );
}

function monthlyDelete(body: unknown) {
  return deleteMonth(
    new Request("http://localhost/api/rules/month", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(users.ADMIN);
  mocks.updateTopicRule.mockResolvedValue({ id: "rule-1", status: "ACTIVE" });
  mocks.deleteTopicRule.mockResolvedValue({ deletedCount: 1, ruleId: "rule-1" });
  mocks.deleteMonthlyTopicRules.mockResolvedValue({
    deletedCount: 7,
    campaignIds: ["campaign-1"],
  });
});

describe("话题规则管理 API", () => {
  it("PUT 明确承载启用和停用且不更换 Rule ID", async () => {
    expect((await putStatus("INACTIVE")).status).toBe(200);
    expect(mocks.updateTopicRule).toHaveBeenCalledWith({
      id: "rule-1",
      userId: "admin-1",
      expectedBrandName: "佳贝艾特",
      body: { status: "INACTIVE", brandName: "佳贝艾特" },
    });
    expect((await putStatus("ACTIVE")).status).toBe(200);
    expect(mocks.updateTopicRule).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "rule-1", body: expect.objectContaining({ status: "ACTIVE" }) }),
    );
  });

  it("DELETE 必须明确 permanent，随后调用物理删除服务", async () => {
    expect((await permanentDelete("legacy-disable")).status).toBe(400);
    expect(mocks.deleteTopicRule).not.toHaveBeenCalled();
    const response = await permanentDelete();
    expect(response.status).toBe(200);
    expect(mocks.deleteTopicRule).toHaveBeenCalledWith({
      id: "rule-1",
      userId: "admin-1",
      expectedBrandName: "佳贝艾特",
    });
  });

  it("批量删除只接受服务端可重建的品牌、月份和渠道范围", async () => {
    const response = await monthlyDelete({
      brandName: "佳贝艾特",
      month: "2026-09",
      contentChannel: "XIAOHONGSHU",
      ruleIds: ["不作为权限范围"],
    });
    expect(response.status).toBe(200);
    expect(mocks.deleteMonthlyTopicRules).toHaveBeenCalledWith({
      userId: "admin-1",
      brandName: "佳贝艾特",
      month: "2026-09",
      contentChannel: "XIAOHONGSHU",
    });
  });

  it("拒绝空品牌、自然月猜测、非法月份和非法渠道", async () => {
    for (const body of [
      { brandName: "", month: "2026-09", contentChannel: "XIAOHONGSHU" },
      { brandName: "佳贝艾特", contentChannel: "XIAOHONGSHU" },
      { brandName: "佳贝艾特", month: "2026-13", contentChannel: "XIAOHONGSHU" },
      { brandName: "佳贝艾特", month: "2026-09", contentChannel: "WECHAT" },
    ]) {
      expect((await monthlyDelete(body)).status).toBe(400);
    }
    expect(mocks.deleteMonthlyTopicRules).not.toHaveBeenCalled();
  });

  it("VIEWER 调用启停、单条删除和批量删除均返回 403", async () => {
    mocks.getSession.mockResolvedValue(users.VIEWER);
    expect((await putStatus("INACTIVE")).status).toBe(403);
    expect((await permanentDelete()).status).toBe(403);
    expect(
      (
        await monthlyDelete({
          brandName: "佳贝艾特",
          month: "2026-09",
          contentChannel: "XIAOHONGSHU",
        })
      ).status,
    ).toBe(403);
    expect(mocks.updateTopicRule).not.toHaveBeenCalled();
    expect(mocks.deleteTopicRule).not.toHaveBeenCalled();
    expect(mocks.deleteMonthlyTopicRules).not.toHaveBeenCalled();
  });
});
