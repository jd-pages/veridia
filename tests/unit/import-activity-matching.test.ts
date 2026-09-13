import { describe, expect, it } from "vitest";
import {
  normalizeImportedActivityMonth,
  resolveImplicitImportedActivity,
  resolveImportedActivity,
  resolveImportedActivityMonth,
} from "@/lib/import-activity-matching";

const campaign = {
  id: "campaign-aug-danone",
  name: "达能2026年8月小红书种草审核",
  month: "2026-08",
  startDate: new Date("2026-08-01T00:00:00.000Z"),
  endDate: new Date("2026-08-31T23:59:59.999Z"),
  status: "ACTIVE",
  deletedAt: null,
  productId: null,
  productIds: ["product-danone"],
  ruleCount: 10,
  contentChannel: "XIAOHONGSHU",
};

describe("导入活动精确匹配", () => {
  it("无活动列时按产品、渠道与发帖日期唯一解析，拒绝猜测", () => {
    expect(resolveImplicitImportedActivity({
      productId: "product-danone",
      contentChannel: "XIAOHONGSHU",
      publishTime: "2026-08-12 10:00:00",
      candidates: [campaign],
    })).toMatchObject({ status: "MATCHED", campaign: { id: campaign.id } });
    expect(resolveImplicitImportedActivity({
      productId: "product-danone",
      contentChannel: "XIAOHONGSHU",
      publishTime: "2026-08-12 10:00:00",
      candidates: [campaign, { ...campaign, id: "another" }],
    })).toMatchObject({
      status: "NOT_UNIQUE",
      error: "无法唯一确定所属活动，请检查产品、内容渠道和活动配置。",
    });
  });
  it("只去除首尾空格并返回唯一活动ID", () => {
    const result = resolveImportedActivity({
      activityName: `  ${campaign.name}  `,
      productId: "product-danone",
      candidates: [campaign],
    });
    expect(result).toMatchObject({
      status: "MATCHED",
      inputName: campaign.name,
      campaign: { id: campaign.id },
    });
  });

  it("不使用简称、月份、最新活动或产品进行兜底", () => {
    expect(resolveImportedActivity({
      activityName: "达能8月活动",
      productId: "product-danone",
      candidates: [campaign],
    })).toMatchObject({ status: "NOT_FOUND" });
    expect(resolveImportedActivity({
      activityName: "",
      productId: "product-danone",
      candidates: [campaign],
    })).toMatchObject({ status: "EMPTY", error: "活动名称不能为空" });
  });

  it("阻止同名、停用、产品不属于活动和未配置规则", () => {
    const duplicate = { ...campaign, id: "campaign-duplicate", month: "2026-09" };
    expect(resolveImportedActivity({
      activityName: campaign.name,
      productId: "product-danone",
      candidates: [campaign, duplicate],
    }).status).toBe("DUPLICATE");
    expect(resolveImportedActivity({
      activityName: campaign.name,
      productId: "product-danone",
      candidates: [{ ...campaign, status: "INACTIVE" }],
    }).status).toBe("INACTIVE");
    expect(resolveImportedActivity({
      activityName: campaign.name,
      productId: "another-product",
      candidates: [campaign],
    }).status).toBe("PRODUCT_NOT_IN_ACTIVITY");
    expect(resolveImportedActivity({
      activityName: campaign.name,
      productId: "product-danone",
      candidates: [{ ...campaign, ruleCount: 0 }],
    }).status).toBe("NO_RULES");
  });

  it("内容渠道必须与活动渠道一致，抖音活动也必须配置独立规则", () => {
    expect(resolveImportedActivity({
      activityName: campaign.name,
      productId: "product-danone",
      contentChannel: "DOUYIN",
      candidates: [campaign],
    })).toMatchObject({
      status: "CHANNEL_MISMATCH",
      error: "内容渠道与活动渠道不一致：当前渠道为抖音，请选择对应的抖音审核活动。",
    });
    const douyinCampaign = {
      ...campaign,
      id: "campaign-aug-douyin",
      name: "达能2026年8月抖音种草审核",
      contentChannel: "DOUYIN",
    };
    expect(resolveImportedActivity({
      activityName: douyinCampaign.name,
      productId: "product-danone",
      contentChannel: "DOUYIN",
      candidates: [douyinCampaign],
    })).toMatchObject({ status: "MATCHED", campaign: { id: douyinCampaign.id } });
    expect(resolveImportedActivity({
      activityName: douyinCampaign.name,
      productId: "product-danone",
      contentChannel: "DOUYIN",
      candidates: [{ ...douyinCampaign, ruleCount: 0 }],
    }).status).toBe("NO_RULES");
  });

  it("显式或继承活动必须覆盖发帖日期，不能回退到自动活动", () => {
    expect(resolveImportedActivity({
      activityName: campaign.name,
      productId: "product-danone",
      contentChannel: "XIAOHONGSHU",
      publishTime: "2026-09-01 10:00:00",
      candidates: [campaign],
    })).toMatchObject({
      status: "OUTSIDE_PERIOD",
      error: "发布时间不在所选活动适用范围内",
      campaign: { id: campaign.id },
    });
    expect(resolveImportedActivity({
      activityName: campaign.name,
      productId: "product-danone",
      contentChannel: "XIAOHONGSHU",
      publishTime: "2026-08-31 23:59:59",
      candidates: [campaign],
    })).toMatchObject({ status: "MATCHED", campaign: { id: campaign.id } });
  });
});

describe("活动月份解析与自动匹配", () => {
  it.each([
    ["1月", 1, null, "1月"],
    ["09月", 9, null, "9月"],
    ["9", 9, null, "9月"],
    ["09", 9, null, "9月"],
    ["2026-09", 9, 2026, "2026-09"],
    ["2026/9", 9, 2026, "2026-09"],
  ])("标准化 %s", (value, month, year, display) => {
    expect(normalizeImportedActivityMonth(value)).toMatchObject({ month, year, display });
  });

  it("按产品、品牌、月份和内容渠道分别解析小红书与抖音活动", () => {
    const xhs = { ...campaign, year: 2026, brandNames: ["达能"] };
    const douyin = {
      ...xhs,
      id: "campaign-aug-douyin",
      name: "达能2026年8月抖音种草审核",
      contentChannel: "DOUYIN",
    };
    expect(resolveImportedActivityMonth({
      activityMonth: "08月",
      expectedBrand: "达能",
      productId: "product-danone",
      contentChannel: "XIAOHONGSHU",
      publishTime: "2026-08-12",
      candidates: [xhs, douyin],
    })).toMatchObject({ status: "MATCHED", campaign: { id: xhs.id } });
    expect(resolveImportedActivityMonth({
      activityMonth: "8",
      expectedBrand: "达能",
      productId: "product-danone",
      contentChannel: "DOUYIN",
      publishTime: "2026-08-12",
      candidates: [xhs, douyin],
    })).toMatchObject({ status: "MATCHED", campaign: { id: douyin.id } });
  });

  it("区分未找到、同年重复与跨年歧义", () => {
    const current = { ...campaign, year: 2026, brandNames: ["达能"] };
    expect(resolveImportedActivityMonth({
      activityMonth: "9月",
      expectedBrand: "达能",
      productId: "product-danone",
      candidates: [current],
    }).status).toBe("ACTIVITY_NOT_FOUND");
    expect(resolveImportedActivityMonth({
      activityMonth: "8月",
      expectedBrand: "达能",
      productId: "product-danone",
      candidates: [current, { ...current, id: "same-year" }],
    }).status).toBe("ACTIVITY_AMBIGUOUS");
    const nextYear = {
      ...current,
      id: "campaign-2027",
      year: 2027,
      month: "2027-08",
      startDate: new Date("2027-08-01T00:00:00.000Z"),
      endDate: new Date("2027-08-31T23:59:59.999Z"),
    };
    expect(resolveImportedActivityMonth({
      activityMonth: "8月",
      expectedBrand: "达能",
      productId: "product-danone",
      candidates: [current, nextYear],
    }).status).toBe("ACTIVITY_YEAR_AMBIGUOUS");
    expect(resolveImportedActivityMonth({
      activityMonth: "2027-08",
      expectedBrand: "达能",
      productId: "product-danone",
      candidates: [current, nextYear],
    })).toMatchObject({ status: "MATCHED", campaign: { id: nextYear.id } });
  });
});
