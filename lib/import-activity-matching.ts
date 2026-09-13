export type ImportActivityMatchStatus =
  | "MATCHED"
  | "EMPTY"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "INACTIVE"
  | "CHANNEL_MISMATCH"
  | "PRODUCT_NOT_IN_ACTIVITY"
  | "OUTSIDE_PERIOD"
  | "NO_RULES"
  | "NOT_UNIQUE"
  | "ACTIVITY_NOT_FOUND"
  | "ACTIVITY_AMBIGUOUS"
  | "ACTIVITY_YEAR_AMBIGUOUS";

export interface ImportActivityCandidate {
  id: string;
  name: string;
  month: string;
  year?: number | null;
  startDate: Date;
  endDate: Date;
  status: string;
  contentChannel?: string;
  deletedAt: Date | null;
  productId: string | null;
  productIds: string[];
  brandNames?: string[];
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
  publishTime?: unknown;
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
  const publishedAt = importedCampaignDate(input.publishTime);
  if (publishedAt) {
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
    if (day < start || day > end) {
      return fail(
        "OUTSIDE_PERIOD",
        "发布时间不在所选活动适用范围内",
        campaign,
      );
    }
  }
  if (campaign.ruleCount < 1) {
    return fail("NO_RULES", "该活动尚未配置审核规则", campaign);
  }
  return { status: "MATCHED", inputName, campaign, error: "" };
}

export interface NormalizedImportActivityMonth {
  month: number;
  year: number | null;
  key: string;
  display: string;
}

export function normalizeImportedActivityMonth(
  value: unknown,
): NormalizedImportActivityMonth | null {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (!text) return null;
  const yearMonth = /^(\d{4})[-/](\d{1,2})(?:月)?$/u.exec(text);
  const monthOnly = /^(\d{1,2})(?:月)?$/u.exec(text);
  const year = yearMonth ? Number(yearMonth[1]) : null;
  const month = Number(yearMonth?.[2] || monthOnly?.[1]);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return {
    month,
    year,
    key: year ? `${year}-${String(month).padStart(2, "0")}` : String(month),
    display: year ? `${year}-${String(month).padStart(2, "0")}` : `${month}月`,
  };
}

export function activityMonthDisplay(
  month: unknown,
  year?: number | null,
) {
  const parsed = normalizeImportedActivityMonth(month);
  const resolvedYear = year || parsed?.year || null;
  const resolvedMonth = parsed?.month;
  if (!resolvedMonth) return String(month ?? "").trim();
  return resolvedYear && parsed?.year
    ? `${resolvedYear}-${String(resolvedMonth).padStart(2, "0")}`
    : `${resolvedMonth}月`;
}

function candidateMonth(candidate: ImportActivityCandidate) {
  const parsed = normalizeImportedActivityMonth(candidate.month);
  return parsed
    ? { month: parsed.month, year: candidate.year || parsed.year || null }
    : {
        month: candidate.startDate.getUTCMonth() + 1,
        year: candidate.year || candidate.startDate.getUTCFullYear(),
      };
}

export function resolveImportedActivityMonth(input: {
  activityMonth: unknown;
  expectedBrand?: string | null;
  productId: string | null | undefined;
  contentChannel?: "XIAOHONGSHU" | "DOUYIN";
  publishTime?: unknown;
  candidates: readonly ImportActivityCandidate[];
}): ImportActivityResolution {
  const normalized = normalizeImportedActivityMonth(input.activityMonth);
  const inputName = String(input.activityMonth ?? "").trim();
  const fail = (
    status: Exclude<ImportActivityMatchStatus, "MATCHED">,
    error: string,
    campaign: ImportActivityCandidate | null = null,
  ): ImportActivityResolution => ({ status, inputName, campaign, error });
  if (!normalized) {
    return fail("EMPTY", "活动月份格式无效，请填写 9月 或 YYYY-MM");
  }
  const requestedChannel = input.contentChannel || "XIAOHONGSHU";
  const scoped = input.candidates.filter((candidate) => {
    if (candidate.deletedAt || candidate.status !== "ACTIVE") return false;
    if ((candidate.contentChannel || "XIAOHONGSHU") !== requestedChannel) return false;
    const products = new Set([
      ...(candidate.productId ? [candidate.productId] : []),
      ...candidate.productIds,
    ]);
    if (!input.productId || !products.has(input.productId)) return false;
    if (
      input.expectedBrand &&
      candidate.brandNames?.length &&
      !candidate.brandNames.includes(input.expectedBrand)
    ) return false;
    const candidatePeriod = candidateMonth(candidate);
    if (candidatePeriod.month !== normalized.month) return false;
    return normalized.year == null || candidatePeriod.year === normalized.year;
  });
  if (!scoped.length) {
    return fail(
      "ACTIVITY_NOT_FOUND",
      `未找到${normalized.display}对应的当前产品与内容渠道活动`,
    );
  }
  if (normalized.year == null) {
    const years = new Set(
      scoped.map((candidate) => candidateMonth(candidate).year).filter(Boolean),
    );
    if (years.size > 1) {
      return fail(
        "ACTIVITY_YEAR_AMBIGUOUS",
        `${normalized.display}对应多个活动年份，请填写 YYYY-MM，例如 2026-09`,
      );
    }
  }
  if (scoped.length > 1) {
    return fail(
      "ACTIVITY_AMBIGUOUS",
      `${normalized.display}对应多个活动，无法唯一匹配`,
    );
  }
  const campaign = scoped[0];
  if (campaign.ruleCount < 1) {
    return fail("NO_RULES", "该活动尚未配置审核规则", campaign);
  }
  const publishedAt = importedCampaignDate(input.publishTime);
  if (publishedAt) {
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
    if (day < start || day > end) {
      return fail("OUTSIDE_PERIOD", "发布时间不在所匹配活动适用范围内", campaign);
    }
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
