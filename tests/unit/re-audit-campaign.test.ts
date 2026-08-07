import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    campaign: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
    },
  },
}));

import { resolveReauditCampaignId } from "@/lib/re-audit-campaign";

const task = {
  campaignId: "xhs-campaign",
  productId: "product-1",
  channel: "DOUYIN",
  platform: "DOUYIN",
  url: "https://www.douyin.com/video/1234567890123456789",
};

describe("重新审核活动渠道解析", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset();
    mocks.findMany.mockReset();
  });

  it("旧抖音任务关联小红书活动时切换到唯一抖音副本", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "xhs-campaign",
      publishedKey: "activity_danone_2026_08",
      name: "达能2026年8月小红书种草审核",
      month: "2026-08",
      contentChannel: "XIAOHONGSHU",
    });
    mocks.findMany.mockResolvedValue([{ id: "douyin-campaign" }]);

    await expect(resolveReauditCampaignId(task)).resolves.toBe(
      "douyin-campaign",
    );
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contentChannel: "DOUYIN",
          month: "2026-08",
          OR: expect.arrayContaining([
            { publishedKey: "douyin_activity_danone_2026_08" },
            { name: "达能2026年8月抖音种草审核" },
          ]),
        }),
      }),
    );
  });

  it("活动已经属于任务渠道时保持原关联", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "douyin-campaign",
      publishedKey: "douyin_activity_danone_2026_08",
      name: "达能2026年8月抖音种草审核",
      month: "2026-08",
      contentChannel: "DOUYIN",
    });

    await expect(
      resolveReauditCampaignId({ ...task, campaignId: "douyin-campaign" }),
    ).resolves.toBe("douyin-campaign");
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("不存在或存在多个同渠道活动时拒绝猜测", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "xhs-campaign",
      publishedKey: null,
      name: "达能2026年8月小红书种草审核",
      month: "2026-08",
      contentChannel: "XIAOHONGSHU",
    });
    mocks.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "douyin-1" },
      { id: "douyin-2" },
    ]);

    await expect(resolveReauditCampaignId(task)).rejects.toThrow(
      "未找到可用于重新审核的同渠道活动",
    );
    await expect(resolveReauditCampaignId(task)).rejects.toThrow(
      "存在多个可用于重新审核的同渠道活动",
    );
  });
});
