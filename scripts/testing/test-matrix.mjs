import fs from "node:fs";
import path from "node:path";

export const TEST_CATEGORIES = Object.freeze([
  "AUTH",
  "ADMIN",
  "XHS",
  "DOUYIN",
  "AUTOMATION",
  "IMPORT",
  "RESULTS",
  "RECHECK",
  "STORE_TOPIC",
  "RULES",
  "CAMPAIGN",
  "MIXED_PLATFORM",
  "UPDATE",
  "RELEASE",
  "DATABASE",
  "UI_LAYOUT",
]);

const entry = (categories, isolationGroup, parallelSafe = false) => ({
  categories,
  isolationGroup,
  parallelSafe,
});

export const E2E_MANIFEST = Object.freeze({
  "tests/e2e/account-auth.spec.ts": entry(["AUTH", "ADMIN"], "AUTH_ADMIN"),
  "tests/e2e/admin-layout.spec.ts": entry(["AUTH", "ADMIN", "UI_LAYOUT"], "AUTH_ADMIN"),
  "tests/e2e/audit-flow.spec.ts": entry(["XHS", "AUTOMATION", "RESULTS", "MIXED_PLATFORM"], "AUTOMATION"),
  "tests/e2e/audit-page-reuse.spec.ts": entry(["XHS", "AUTOMATION"], "AUTOMATION"),
  "tests/e2e/batch-clear.spec.ts": entry(["AUTOMATION", "RESULTS"], "AUTOMATION"),
  "tests/e2e/current-task-content.spec.ts": entry(["XHS", "AUTOMATION", "RESULTS"], "AUTOMATION"),
  "tests/e2e/dashboard-risk-summary.spec.ts": entry(["RESULTS", "UI_LAYOUT"], "RESULTS_UI", true),
  "tests/e2e/douyin-automation.spec.ts": entry(["DOUYIN", "AUTOMATION", "MIXED_PLATFORM", "RESULTS"], "AUTOMATION"),
  "tests/e2e/kabrita-excel-template.spec.ts": entry(["IMPORT", "CAMPAIGN"], "DATA_RULES"),
  "tests/e2e/local-fonts.spec.ts": entry(["UI_LAYOUT", "UPDATE"], "RESULTS_UI", true),
  "tests/e2e/localization.spec.ts": entry(["UI_LAYOUT"], "RESULTS_UI", true),
  "tests/e2e/platform-published-at.spec.ts": entry(["XHS", "DOUYIN", "RESULTS", "MIXED_PLATFORM"], "RESULTS_UI", true),
  "tests/e2e/pause-resume-runner-lifecycle.spec.ts": entry(["XHS", "AUTOMATION", "RESULTS", "DATABASE"], "AUTOMATION"),
  "tests/e2e/product-stage-topic.spec.ts": entry(["CAMPAIGN", "RULES", "XHS"], "DATA_RULES"),
  "tests/e2e/result-lifecycle.spec.ts": entry(["RESULTS", "RECHECK", "MIXED_PLATFORM", "XHS", "DOUYIN"], "RESULTS_UI"),
  "tests/e2e/results-horizontal-scroll.spec.ts": entry(["RESULTS", "UI_LAYOUT"], "RESULTS_UI", true),
  "tests/e2e/results-workbench.spec.ts": entry(["RESULTS", "RECHECK", "UI_LAYOUT"], "RESULTS_UI"),
  "tests/e2e/rule-brand-navigation.spec.ts": entry(["RULES", "CAMPAIGN", "ADMIN"], "DATA_RULES"),
  "tests/e2e/setup-health.spec.ts": entry(["DATABASE", "UPDATE", "AUTH"], "AUTH_ADMIN", true),
  "tests/e2e/stage-import.spec.ts": entry(["IMPORT", "CAMPAIGN", "XHS"], "DATA_RULES"),
  "tests/e2e/store-topic-audit.spec.ts": entry(["STORE_TOPIC", "XHS", "AUTOMATION", "RESULTS"], "AUTOMATION"),
  "tests/e2e/store-topic-rule-management.spec.ts": entry(["STORE_TOPIC", "RULES", "CAMPAIGN"], "DATA_RULES"),
});

export const CROSS_MODULE_E2E = Object.freeze([
  "tests/e2e/audit-flow.spec.ts",
  "tests/e2e/douyin-automation.spec.ts",
  "tests/e2e/result-lifecycle.spec.ts",
  "tests/e2e/stage-import.spec.ts",
]);

const RULES = [
  { match: /(?:^|\/)(?:playwright\.config\.ts|package(?:-lock)?\.json|scripts\/testing\/|tests\/e2e\/setup-|tests\/unit\/test-gates)/u, categories: TEST_CATEGORIES, infrastructure: true, reason: "测试基础设施发生变化，至少执行 REGRESSION" },
  { match: /(?:douyin|抖音)/iu, categories: ["DOUYIN"], reason: "抖音导航、平台路由与对应结果路径发生变化" },
  { match: /(?:xiaohongshu|\bxhs\b|小红书)/iu, categories: ["XHS", "AUTOMATION", "RESULTS"], reason: "小红书自动化路径发生变化" },
  { match: /(?:store-topic|storeTopic)/u, categories: ["STORE_TOPIC", "RULES", "RESULTS", "XHS", "DOUYIN"], reason: "店铺话题规则或审核发生变化" },
  { match: /(?:result|re-audit|reaudit|recheck)/iu, categories: ["RESULTS", "RECHECK", "UI_LAYOUT", "MIXED_PLATFORM"], reason: "结果或重新审核路径发生变化" },
  { match: /(?:import|excel|template)/iu, categories: ["IMPORT", "CAMPAIGN", "RULES"], reason: "导入或模板路径发生变化" },
  { match: /(?:campaign|rule|topic)/iu, categories: ["CAMPAIGN", "RULES", "STORE_TOPIC"], reason: "活动或规则路径发生变化" },
  { match: /(?:account|auth|login|middleware)/iu, categories: ["AUTH", "ADMIN"], reason: "认证或权限路径发生变化" },
  { match: /(?:prisma\/|database|sqlite|postgres)/iu, categories: ["DATABASE", "IMPORT", "RESULTS", "AUTH"], reason: "数据库结构或兼容路径发生变化" },
  { match: /(?:release|update|electron|desktop|\.github\/workflows)/iu, categories: ["RELEASE", "UPDATE", "DATABASE", "AUTH"], reason: "发布或桌面更新路径发生变化" },
  { match: /(?:components\/|app\/)/u, categories: ["UI_LAYOUT", "ADMIN"], reason: "页面或组件发生变化" },
];

export function listFormalE2eFiles(root = process.cwd()) {
  return fs
    .readdirSync(path.join(root, "tests", "e2e"), { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.endsWith(".spec.ts") && !item.name.endsWith(".stress.spec.ts"))
    .map((item) => `tests/e2e/${item.name}`)
    .sort();
}

export function validateManifest(root = process.cwd()) {
  const formal = listFormalE2eFiles(root);
  const declared = Object.keys(E2E_MANIFEST).sort();
  const missing = formal.filter((file) => !declared.includes(file));
  const stale = declared.filter((file) => !formal.includes(file));
  if (missing.length || stale.length) {
    throw new Error(`E2E 清单与正式测试集不一致。缺失: ${missing.join(", ") || "无"}; 多余: ${stale.join(", ") || "无"}`);
  }
  return formal;
}

export function selectTestScope(changedFiles, mode = "fast") {
  const normalized = [...new Set(changedFiles.map((file) => file.replaceAll("\\", "/")))].sort();
  const categories = new Set();
  const reasons = [];
  let infrastructureChanged = false;
  let conservativeFallback = normalized.length === 0;

  for (const file of normalized) {
    const matches = RULES.filter((rule) => rule.match.test(file));
    if (matches.length === 0) {
      conservativeFallback = true;
      reasons.push(`${file}: 无精确映射，使用保守全量回退`);
      continue;
    }
    for (const rule of matches) {
      rule.categories.forEach((category) => categories.add(category));
      infrastructureChanged ||= Boolean(rule.infrastructure);
      reasons.push(`${file}: ${rule.reason}`);
    }
  }

  if (conservativeFallback || infrastructureChanged) {
    TEST_CATEGORIES.forEach((category) => categories.add(category));
  }
  if (mode === "regression") {
    for (const file of CROSS_MODULE_E2E) {
      E2E_MANIFEST[file].categories.forEach((category) => categories.add(category));
    }
    reasons.push("REGRESSION 固定加入跨模块回归样本");
  }
  const e2eFiles = Object.entries(E2E_MANIFEST)
    .filter(([, metadata]) => metadata.categories.some((category) => categories.has(category)))
    .map(([file]) => file)
    .sort();
  const parallelSafe = e2eFiles.length > 0 && e2eFiles.every((file) => E2E_MANIFEST[file].parallelSafe);
  return {
    changedFiles: normalized,
    categories: [...categories].sort(),
    e2eFiles,
    reasons: [...new Set(reasons)],
    infrastructureChanged,
    minimumMode: infrastructureChanged ? "regression" : mode,
    conservativeFallback,
    workers: parallelSafe ? 2 : 1,
  };
}

export function groupE2eFiles(files) {
  const groups = new Map();
  for (const file of files) {
    const metadata = E2E_MANIFEST[file];
    if (!metadata) throw new Error(`未登记的 E2E 文件: ${file}`);
    const list = groups.get(metadata.isolationGroup) || [];
    list.push(file);
    groups.set(metadata.isolationGroup, list);
  }
  return [...groups.entries()].map(([name, groupFiles]) => ({
    name,
    files: groupFiles.sort(),
    workers: groupFiles.every((file) => E2E_MANIFEST[file].parallelSafe) ? 2 : 1,
  }));
}
