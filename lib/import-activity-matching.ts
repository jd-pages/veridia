export type ImportActivityMatchStatus =
  | "MATCHED"
  | "EMPTY"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "INACTIVE"
  | "CHANNEL_MISMATCH"
  | "PRODUCT_NOT_IN_ACTIVITY"
  | "NO_RULES"
  | "NOT_UNIQUE";

export interface ImportActivityCandidate {
  id: string;
  name: string;
  month: string;
  startDate: Date;
  endDate: Date;
  status: string;
  contentChannel?: string;
  deletedAt: Date | null;
  productId: string | null;
  productIds: string[];
  ruleCount: number;
}

export interface ImportActivityResolution {
  status: ImportActivityMatchStatus;
  inputName: string;
  campaign: ImportActivityCandidate | null;
  error: string;
}

export function resolveImportedActivity(input: {
  activityName: unknown;
  productId: string | null | undefined;
  contentChannel?: "XIAOHONGSHU" | "DOUYIN";
  candidates: readonly ImportActivityCandidate[];
}): ImportActivityResolution {
  const inputName = String(input.activityName ?? "").trim();
  const fail = (
    status: Exclude<ImportActivityMatchStatus, "MATCHED">,
    error: string,
    campaign: ImportActivityCandidate | null = null,
  ): ImportActivityResolution => ({ status, inputName, campaign, error });
  if (!inputName) return fail("EMPTY", "活动名称不能为空");

  const exact = input.candidates.filter(
    (candidate) => candidate.name === inputName && !candidate.deletedAt,
  );
  if (!exact.length) {
    return fail(
      "NOT_FOUND",
      "未找到对应活动，请确认活动名称与“活动管理”中的名称完全一致",
    );
  }
  if (exact.length > 1) {
    return fail(
      "DUPLICATE",
      "存在多个同名活动，无法唯一匹配，请先在活动管理中调整活动名称",
    );
  }
  const campaign = exact[0];
  if (campaign.status !== "ACTIVE") {
    return fail("INACTIVE", "该活动当前未启用，无法导入", campaign);
  }
  const requestedChannel = input.contentChannel || "XIAOHONGSHU";
  if ((campaign.contentChannel || "XIAOHONGSHU") !== requestedChannel) {
    const currentChannel = requestedChannel === "DOUYIN" ? "抖音" : "小红书";
    return fail(
      "CHANNEL_MISMATCH",
      `内容渠道与活动渠道不一致：当前渠道为${currentChannel}，请选择对应的${currentChannel}审核活动。`,
      campaign,
    );
  }
  const productIds = new Set([
    ...(campaign.productId ? [campaign.productId] : []),
    ...campaign.productIds,
  ]);
  if (!input.productId || !productIds.has(input.productId)) {
    return fail(
      "PRODUCT_NOT_IN_ACTIVITY",
      "当前产品系列不属于所选活动",
      campaign,
    );
  }
  if (campaign.ruleCount < 1) {
    return fail("NO_RULES", "该活动尚未配置审核规则", campaign);
  }
  return { status: "MATCHED", inputName, campaign, error: "" };
}

function importedCampaignDate(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/u);
  const parsed = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function resolveImplicitImportedActivity(input: {
  productId: string | null | undefined;
  contentChannel?: "XIAOHONGSHU" | "DOUYIN";
  publishTime?: unknown;
  candidates: readonly ImportActivityCandidate[];
}): ImportActivityResolution {
  const requestedChannel = input.contentChannel || "XIAOHONGSHU";
  const publishedAt = importedCampaignDate(input.publishTime);
  const eligible = input.candidates.filter((campaign) => {
    if (campaign.deletedAt || campaign.status !== "ACTIVE") return false;
    if ((campaign.contentChannel || "XIAOHONGSHU") !== requestedChannel) return false;
    if (campaign.ruleCount < 1) return false;
    const productIds = new Set([
      ...(campaign.productId ? [campaign.productId] : []),
      ...campaign.productIds,
    ]);
    if (!input.productId || !productIds.has(input.productId)) return false;
    if (!publishedAt) return true;
    const day = Date.UTC(
      publishedAt.getUTCFullYear(),
      publishedAt.getUTCMonth(),
      publishedAt.getUTCDate(),
    );
    const start = Date.UTC(
      campaign.startDate.getUTCFullYear(),
      campaign.startDate.getUTCMonth(),
      campaign.startDate.getUTCDate(),
    );
    const end = Date.UTC(
      campaign.endDate.getUTCFullYear(),
      campaign.endDate.getUTCMonth(),
      campaign.endDate.getUTCDate(),
    );
    return day >= start && day <= end;
  });
  if (eligible.length !== 1) {
    return {
      status: "NOT_UNIQUE",
      inputName: "",
      campaign: null,
      error: "无法唯一确定所属活动，请检查产品、内容渠道和活动配置。",
    };
  }
  return {
    status: "MATCHED",
    inputName: "",
    campaign: eligible[0],
    error: "",
  };
}
