export class AuditConfigurationError extends Error {
  readonly code = "CONFIG_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "AuditConfigurationError";
  }
}

export function missingProductStageRuleMessage(input: {
  productName: string;
  productStage: string;
}) {
  return `当前活动要求阶段话题，但产品‘${input.productName}’的 ${input.productStage} 阶段未配置可用话题规则。`;
}
