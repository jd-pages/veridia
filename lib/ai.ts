export interface AiSemanticResult {
  status: "DISABLED";
  relevance: "RELATED" | "POSSIBLY_RELATED" | "UNRELATED" | "UNKNOWN";
  reason: string;
}

export async function evaluateSemanticRelevance(input: {
  body: string;
  topics: string[];
  enabled: boolean;
}): Promise<AiSemanticResult> {
  void input;
  return {
    status: "DISABLED",
    relevance: "UNKNOWN",
    reason: "桌面版仅执行本地固定规则审核",
  };
}
