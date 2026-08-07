import { describe, expect, it } from "vitest";
import { resolveImportedActivity } from "@/lib/import-activity-matching";

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
};

describe("导入活动精确匹配", () => {
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

  it("抖音首阶段允许精确关联活动但不借用小红书规则", () => {
    const result = resolveImportedActivity({
      activityName: campaign.name,
      productId: "product-danone",
      candidates: [{ ...campaign, ruleCount: 0 }],
      allowMissingRules: true,
    });
    expect(result).toMatchObject({
      status: "MATCHED",
      campaign: { id: campaign.id, ruleCount: 0 },
    });
  });
});
