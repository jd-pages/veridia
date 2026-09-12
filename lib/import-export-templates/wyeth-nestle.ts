import type {
  ImportExportTemplates,
  StandardField,
} from "./types";
import { normalizeTemplateHeader } from "./validation";

export const WYETH_BRAND_NAME = "惠氏" as const;
export const NESTLE_BRAND_NAME = "雀巢" as const;
export const WYETH_NESTLE_BRANDS = [
  WYETH_BRAND_NAME,
  NESTLE_BRAND_NAME,
] as const;

export const WYETH_NESTLE_FIELDS = [
  "registrant",
  "wechatNickname",
  "commercePlatform",
  "shopName",
  "productName",
  "orderNumber",
  "contentChannel",
  "noteUrl",
  "publishTime",
  "customerServiceComment",
  "selfReview",
  "interactionAtLeastTen",
] as const satisfies readonly StandardField[];

export const WYETH_NESTLE_REQUIRED_FIELDS = WYETH_NESTLE_FIELDS.slice(
  0,
  9,
) as readonly StandardField[];

export const WYETH_NESTLE_FIELD_DEFINITIONS: Record<
  (typeof WYETH_NESTLE_FIELDS)[number],
  ImportExportTemplates["fieldDefinitions"][string]
> = {
  registrant: { displayName: "登记人（必填）", type: "string", description: "业务登记人" },
  wechatNickname: { displayName: "微信昵称（必填）", type: "string", description: "客户微信昵称" },
  commercePlatform: { displayName: "下单平台（必填）", type: "string", description: "订单所在成交平台" },
  shopName: { displayName: "店铺名称（必填）", type: "string", description: "与下单平台对应的正式店铺名称" },
  productName: { displayName: "产品系列（必填）", type: "string", description: "惠氏或雀巢正式产品名称" },
  orderNumber: { displayName: "订单编号（必填）", type: "string", description: "业务订单编号" },
  contentChannel: { displayName: "内容渠道（必填）", type: "string", description: "小红书或抖音" },
  noteUrl: { displayName: "链接（必填）纯链接", type: "url", description: "作品纯链接；超链接单元格读取实际目标地址" },
  publishTime: { displayName: "发帖时间（必填）", type: "datetime", description: "用于确定当前适用活动" },
  customerServiceComment: { displayName: "客服修改留言", type: "string", description: "格式：日期-已留言/已修改" },
  selfReview: { displayName: "内部自审", type: "string", description: "由 VERIDIA 审核后重新生成" },
  interactionAtLeastTen: { displayName: "互动量≥10", type: "string", description: "由 VERIDIA 根据正式互动合计重新生成" },
};

export function wyethNestleDisplayName(field: StandardField) {
  return WYETH_NESTLE_FIELD_DEFINITIONS[
    field as (typeof WYETH_NESTLE_FIELDS)[number]
  ]?.displayName || field;
}

export function isWyethNestleTemplateHeader(headers: readonly string[]) {
  const normalized = new Set(headers.map(normalizeTemplateHeader));
  return ["登记人（必填）", "微信昵称（必填）", "互动量≥10"]
    .map(normalizeTemplateHeader)
    .every((header) => normalized.has(header));
}

type ProductOptionSource = {
  id: string;
  name: string;
  code?: string | null;
  brandName: string;
};

export function buildWyethNestleProductOptions<T extends ProductOptionSource>(
  products: readonly T[],
) {
  const supported = products.filter((product) =>
    (WYETH_NESTLE_BRANDS as readonly string[]).includes(product.brandName.trim()),
  );
  const counts = new Map<string, number>();
  for (const product of supported) {
    const key = product.name.normalize("NFKC").trim().toLocaleLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return supported.map((product) => {
    const key = product.name.normalize("NFKC").trim().toLocaleLowerCase();
    const discriminator = product.code?.trim() || product.id;
    return {
      product,
      value: counts.get(key) === 1
        ? product.name
        : `${product.name}【${product.brandName.trim()}·${discriminator}】`,
    };
  });
}
