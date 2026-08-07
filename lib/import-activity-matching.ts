export type ImportActivityMatchStatus =
  | "MATCHED"
  | "EMPTY"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "INACTIVE"
  | "PRODUCT_NOT_IN_ACTIVITY"
  | "NO_RULES";

export interface ImportActivityCandidate {
  id: string;
  name: string;
  month: string;
  startDate: Date;
  endDate: Date;
  status: string;
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
  candidates: readonly ImportActivityCandidate[];
  allowMissingRules?: boolean;
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
  if (campaign.ruleCount < 1 && !input.allowMissingRules) {
    return fail("NO_RULES", "该活动尚未配置审核规则", campaign);
  }
  return { status: "MATCHED", inputName, campaign, error: "" };
}
