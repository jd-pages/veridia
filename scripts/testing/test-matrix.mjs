import fs from "node:fs";
import path from "node:path";
import { selectProtectedBehaviors } from "./protected-behaviors.mjs";

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

export const CHANGE_RISK_LEVELS = Object.freeze({
  TEST_ONLY: "TEST_ONLY",
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
});

const TEST_ONLY_PATH = /^tests\//u;
const LOW_RISK_PATH = /^(?:docs\/|README(?:\.|$)|CHANGELOG\.md$)/iu;
const VERIFICATION_INFRASTRUCTURE_PATH = /^(?:\.github\/workflows\/|scripts\/(?:testing\/|release|software-publish|software-binary-publish|fixed-workflow|finalize-release|package-full-gate|run-publish-rules)|package(?:-lock)?\.json$|(?:发布新版|上传发布包|发布规则新版|本地打包验收)\.bat$)/u;
const VERIFICATION_INFRASTRUCTURE_TEST_PATH = /^tests\/unit\/(?:test-gates|test-only-recovery|full-gate-attestation|package-full-gate|local-package-worktree|release-gate)\.test\.ts$/u;
const RULE_CRUD_PRODUCTION_PATH = /(?:^|\/)(?:app\/\(admin\)\/rules(?:\/|$)|app\/api\/rules(?:\/|$)|lib\/topic-rule-management\.ts$|lib\/rules\/package\.ts$)/u;
const RULE_CRUD_PATH = /(?:^|\/)(?:app\/\(admin\)\/rules(?:\/|$)|app\/api\/rules(?:\/|$)|lib\/topic-rule-management\.ts$|lib\/rules\/package\.ts$|tests\/(?:e2e\/rule-brand-navigation\.spec\.ts|unit\/topic-rule-management(?:-routes)?\.test\.ts)$)/u;
const DIRECT_UNIT_TEST_PATH = /^tests\/unit\/.*\.test\.ts$/u;
const BUSINESS_RELATED_SOURCE_PATH = /^(?:app|lib)\/.*\.(?:ts|tsx|js|mjs)$/u;
// Shared RESULTS/DATABASE labels alone do not imply runner control changes.
// Explicit protected selections and conservative/FULL selection still include these suites.
const RUNNER_CONTROL_E2E_FILES = new Set([
  "tests/e2e/audit-page-reuse.spec.ts",
  "tests/e2e/batch-clear.spec.ts",
  "tests/e2e/pause-resume-runner-lifecycle.spec.ts",
]);

export const INFRASTRUCTURE_UNIT_ALLOWLIST = Object.freeze([
  "tests/unit/test-gates.test.ts",
  "tests/unit/test-only-recovery.test.ts",
  "tests/unit/full-gate-attestation.test.ts",
  "tests/unit/package-full-gate.test.ts",
  "tests/unit/local-package-worktree.test.ts",
  "tests/unit/release-gate.test.ts",
]);
export const AFFECTED_INFRASTRUCTURE_UNIT_LIMIT = 30;

export function assertAffectedInfrastructureUnitSelection(
  unitFiles,
  changedFiles,
  limit = AFFECTED_INFRASTRUCTURE_UNIT_LIMIT,
) {
  const selected = [...new Set(unitFiles)].sort();
  if (selected.length > limit) {
    throw new Error([
      `AFFECTED_UNIT_SELECTION_TOO_BROAD: ${selected.length} infrastructure Unit files selected`,
      `causing changed files: ${changedFiles.join(", ")}`,
    ].join("; "));
  }
  return selected;
}

const EXPLICIT_UNIT_RULES = Object.freeze([
  {
    match: RULE_CRUD_PRODUCTION_PATH,
    unitFiles: [
      "tests/unit/topic-rule-management.test.ts",
      "tests/unit/topic-rule-management-routes.test.ts",
    ],
    reason: "话题规则 CRUD 使用显式 Unit 映射，不扩散 vitest related",
  },
]);
const HIGH_RISK_RULES = Object.freeze([
  {
    match: /^prisma\/(?:migrations\/|schema(?:\.[^/]+)?\.prisma$)/u,
    kind: "database",
    reason: "Prisma schema / migration 变化",
  },
  {
    match: /^(?:desktop\/|scripts\/(?:desktop-|prepare-desktop|build-desktop|after-pack))/u,
    kind: "desktopRuntime",
    reason: "Desktop runtime / package 变化",
  },
  {
    match: /^(?:\.github\/workflows\/|scripts\/(?:release|software-publish|software-binary-publish|fixed-workflow|finalize-release|package-full-gate|run-publish-rules)|(?:发布新版|上传发布包|发布规则新版|本地打包验收)\.bat$)/u,
    kind: "releaseInfrastructure",
    reason: "Release / GitHub Actions 基础设施变化",
  },
  {
    match: /^(?:scripts\/testing\/(?:verify|test-matrix|protected-|full-gate-attestation|test-only-recovery|ci-plan|run-e2e)|playwright\.config\.ts$|vitest\.config\.ts$)/u,
    kind: "testInfrastructure",
    reason: "测试选择器、门禁或 attestation 基础设施变化",
  },
  {
    match: /^package(?:-lock)?\.json$/u,
    kind: "packageRuntime",
    reason: "package runtime semantics 变化",
  },
  {
    match: /^(?:lib\/automation\/(?:queue|runtime-state|extraction-deadline|generation-lifecycle|runner-handoff|browser|douyin-browser|task-lifecycle|batch-service|batch-runtime-reconcile|batch-execution-reconcile)|tests\/e2e\/pause-resume-runner-lifecycle\.spec\.ts$)/u,
    kind: "automationLifecycle",
    reason: "Automation runner / browser lifecycle 变化",
  },
  {
    match: /^(?:lib\/(?:audit-engine|audit-service|audit-result-lifecycle|audit-result-deletion|audit-task-deduplication|import-record-deletion)|app\/api\/(?:audit-tasks|results|imports)(?:\/|$))/u,
    kind: "coreAuditLifecycle",
    reason: "核心审核、结果、重复或删除生命周期变化",
  },
]);

export function isTestOnlyChangePath(file) {
  return TEST_ONLY_PATH.test(file.replaceAll("\\", "/"));
}

export function classifyChangeRisk(changedFiles) {
  const normalized = [...new Set((changedFiles || []).map((file) => file.replaceAll("\\", "/")))].sort();
  if (normalized.length > 0 && normalized.every(isTestOnlyChangePath)) {
    return {
      level: CHANGE_RISK_LEVELS.TEST_ONLY,
      changedFiles: normalized,
      highRiskKinds: [],
      reasons: ["全部变化均位于 tests/**"],
      productionChanged: false,
    };
  }
  const highRiskKinds = new Set();
  const reasons = [];
  for (const file of normalized) {
    for (const rule of HIGH_RISK_RULES.filter((candidate) => candidate.match.test(file))) {
      highRiskKinds.add(rule.kind);
      reasons.push(`${file}: ${rule.reason}`);
    }
  }
  if (highRiskKinds.size > 0 || normalized.length === 0) {
    return {
      level: CHANGE_RISK_LEVELS.HIGH,
      changedFiles: normalized,
      highRiskKinds: [...highRiskKinds].sort(),
      reasons: normalized.length ? [...new Set(reasons)] : ["未取得可靠 diff，按 HIGH fail-closed"],
      productionChanged: true,
    };
  }
  const low = normalized.every((file) => LOW_RISK_PATH.test(file));
  return {
    level: low ? CHANGE_RISK_LEVELS.LOW : CHANGE_RISK_LEVELS.MEDIUM,
    changedFiles: normalized,
    highRiskKinds: [],
    reasons: [low ? "仅文档或说明文件变化" : "普通业务代码或配置变化"],
    productionChanged: true,
  };
}

const entry = (categories, isolationGroup, parallelSafe = false) => ({
  categories,
  isolationGroup,
  parallelSafe,
});

export const E2E_MANIFEST = Object.freeze({
  "tests/e2e/account-auth.spec.ts": entry(["AUTH", "ADMIN"], "AUTH_ADMIN"),
  "tests/e2e/auth-request-bound-session.spec.ts": entry(["AUTH", "ADMIN"], "AUTH_ADMIN"),
  "tests/e2e/admin-layout.spec.ts": entry(["AUTH", "ADMIN", "UI_LAYOUT"], "AUTH_ADMIN"),
  "tests/e2e/audit-flow.spec.ts": entry(["XHS", "AUTOMATION", "RESULTS", "MIXED_PLATFORM"], "AUTOMATION"),
  "tests/e2e/audit-ingest-boundary.spec.ts": entry(["AUTH", "AUTOMATION", "RESULTS"], "AUTOMATION"),
  "tests/e2e/audit-page-reuse.spec.ts": entry(["XHS", "AUTOMATION"], "AUTOMATION"),
  "tests/e2e/audit-topic-boundaries.spec.ts": entry(["XHS", "DOUYIN", "RULES", "CAMPAIGN", "RESULTS"], "DATA_RULES"),
  "tests/e2e/batch-clear.spec.ts": entry(["AUTOMATION", "RESULTS"], "AUTOMATION"),
  "tests/e2e/current-task-content.spec.ts": entry(["XHS", "AUTOMATION", "RESULTS"], "AUTOMATION"),
  "tests/e2e/dashboard-risk-summary.spec.ts": entry(["RESULTS", "UI_LAYOUT"], "RESULTS_UI", true),
  "tests/e2e/douyin-automation.spec.ts": entry(["DOUYIN", "AUTOMATION", "MIXED_PLATFORM", "RESULTS"], "AUTOMATION"),
  "tests/e2e/douyin-response-collector.spec.ts": entry(["DOUYIN", "AUTOMATION"], "AUTOMATION"),
  "tests/e2e/historical-extraction-immutable.spec.ts": entry(["RESULTS", "RECHECK", "DATABASE", "UI_LAYOUT"], "RESULTS_UI"),
  "tests/e2e/import-record-deletion.spec.ts": entry(["IMPORT", "RESULTS", "AUTOMATION", "MIXED_PLATFORM", "DATABASE", "ADMIN", "UI_LAYOUT"], "AUTOMATION"),
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

const RULES = [
  { match: /^lib\/(?:audit-engine|audit-service|types|interaction-reward)\.ts$/u, categories: ["RESULTS", "RULES", "CAMPAIGN"], exclusive: true, reason: "审核判断、持久化与共享审核类型影响结果和活动规则；Runner/Browser 生命周期由独立映射保护" },
  { match: VERIFICATION_INFRASTRUCTURE_PATH, categories: [], exclusive: true, reason: "CI、测试、Release 或 package 门禁基础设施变化，使用对应 Unit/静态/构建专项" },
  { match: VERIFICATION_INFRASTRUCTURE_TEST_PATH, categories: [], exclusive: true, reason: "CI/Release gate 防回归 Unit 变化，保持门禁基础设施专项范围" },
  { match: /(?:^|\/)(?:playwright\.config\.ts|vitest\.config\.ts|tests\/e2e\/setup-)/u, categories: TEST_CATEGORIES, infrastructure: true, reason: "Playwright/Vitest 执行基础设施变化，覆盖全部受影响测试域" },
  { match: /(?:^|\/)scripts\/testing\//u, categories: [], reason: "测试选择器或门禁脚本变化，仅运行直接关联 Unit 与静态验证" },
  { match: /(?:^|\/)package(?:-lock)?\.json$/u, categories: [], reason: "package runtime 变化，执行构建专项而非无条件全 E2E" },
  {
    match: RULE_CRUD_PATH,
    categories: ["CAMPAIGN", "RULES"],
    exclusive: true,
    reason: "话题规则 CRUD、规则包或对应测试发生变化，仅选择 DATA_RULES 业务分组",
  },
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
  const risk = classifyChangeRisk(normalized);
  const categories = new Set();
  const reasons = [];
  let infrastructureChanged = false;
  let conservativeFallback = normalized.length === 0;

  for (const file of normalized) {
    if (isTestOnlyChangePath(file) && !/^tests\/e2e\/setup-/u.test(file)) {
      reasons.push(`${file}: 测试文件只选择自身及其直接受保护行为`);
      continue;
    }
    const matches = RULES.filter((rule) => rule.match.test(file));
    if (matches.length === 0) {
      if (risk.level === CHANGE_RISK_LEVELS.TEST_ONLY || risk.level === CHANGE_RISK_LEVELS.LOW) {
        reasons.push(`${file}: ${risk.level} 仅运行直接关联测试`);
      } else {
        conservativeFallback = true;
        reasons.push(`${file}: 无精确映射，使用保守全量回退`);
      }
      continue;
    }
    const exclusiveMatches = matches.filter((rule) => rule.exclusive);
    for (const rule of exclusiveMatches.length ? exclusiveMatches : matches) {
      rule.categories.forEach((category) => categories.add(category));
      infrastructureChanged ||= Boolean(rule.infrastructure);
      reasons.push(`${file}: ${rule.reason}`);
    }
  }

  if (risk.level === CHANGE_RISK_LEVELS.TEST_ONLY) {
    conservativeFallback = false;
    infrastructureChanged = false;
  }

  if (risk.level !== CHANGE_RISK_LEVELS.TEST_ONLY && (conservativeFallback || infrastructureChanged)) {
    TEST_CATEGORIES.forEach((category) => categories.add(category));
  }
  const protectedImpactFiles = normalized.filter((file) =>
    !VERIFICATION_INFRASTRUCTURE_PATH.test(file) &&
    !VERIFICATION_INFRASTRUCTURE_TEST_PATH.test(file)
  );
  const verificationInfrastructureOnly = risk.level === CHANGE_RISK_LEVELS.HIGH && protectedImpactFiles.length === 0;
  const protectedSelection = selectProtectedBehaviors(
    protectedImpactFiles,
    {
      noFallback: verificationInfrastructureOnly || risk.level === CHANGE_RISK_LEVELS.TEST_ONLY,
      directOnly: risk.level === CHANGE_RISK_LEVELS.TEST_ONLY,
    conservative:
      risk.level !== CHANGE_RISK_LEVELS.TEST_ONLY &&
      (conservativeFallback || infrastructureChanged),
    },
  );
  const directlyChangedUnit = normalized.filter((file) => DIRECT_UNIT_TEST_PATH.test(file));
  const infrastructureChangedFiles = normalized.filter((file) => VERIFICATION_INFRASTRUCTURE_PATH.test(file));
  const infrastructureUnitFiles = assertAffectedInfrastructureUnitSelection(
    infrastructureChangedFiles.length ? [...INFRASTRUCTURE_UNIT_ALLOWLIST] : [],
    infrastructureChangedFiles,
  );
  const explicitUnitFiles = new Set();
  const explicitlyMappedSources = new Set();
  const unitSelectionReasons = [];
  for (const file of normalized) {
    const rule = EXPLICIT_UNIT_RULES.find((candidate) => candidate.match.test(file));
    if (!rule) continue;
    rule.unitFiles.forEach((unitFile) => explicitUnitFiles.add(unitFile));
    explicitlyMappedSources.add(file);
    unitSelectionReasons.push(`${file}: ${rule.reason}`);
  }
  const unitFiles = [...new Set([
    ...directlyChangedUnit,
    ...infrastructureUnitFiles,
    ...explicitUnitFiles,
    ...protectedSelection.unitTests,
  ])].sort();
  const unitRelatedFiles = normalized.filter((file) =>
    BUSINESS_RELATED_SOURCE_PATH.test(file) &&
    !VERIFICATION_INFRASTRUCTURE_PATH.test(file) &&
    !explicitlyMappedSources.has(file)
  );
  if (directlyChangedUnit.length) {
    unitSelectionReasons.push(`直接 Unit：${directlyChangedUnit.join(", ")}`);
  }
  if (infrastructureUnitFiles.length) {
    unitSelectionReasons.push(`CI/test/release/package 基础设施仅运行 ${infrastructureUnitFiles.length} 个 gate Unit`);
  }
  if (unitRelatedFiles.length) {
    unitSelectionReasons.push(`仅生产业务源进入 vitest related：${unitRelatedFiles.join(", ")}`);
  }
  if (mode === "regression") {
    reasons.push("REGRESSION 仅执行受影响业务分组与受保护行为，不无条件扩张跨模块测试");
  }
  const directlyChangedE2e = normalized.filter((file) => E2E_MANIFEST[file]);
  const e2eFiles = [...new Set(
    risk.level === CHANGE_RISK_LEVELS.TEST_ONLY
      ? [...directlyChangedE2e, ...protectedSelection.e2eTests]
      : [
          ...directlyChangedE2e,
          ...Object.entries(E2E_MANIFEST)
            .filter(([file, metadata]) =>
              (!RUNNER_CONTROL_E2E_FILES.has(file) || categories.has("AUTOMATION")) &&
              metadata.categories.some((category) => categories.has(category)))
            .map(([file]) => file),
          ...protectedSelection.e2eTests,
        ],
  )].sort();
  const parallelSafe = e2eFiles.length > 0 && e2eFiles.every((file) => E2E_MANIFEST[file].parallelSafe);
  return {
    changedFiles: normalized,
    categories: [...categories].sort(),
    e2eFiles,
    unitFiles,
    unitRelatedFiles,
    infrastructureUnitFiles,
    unitSelectionReasons: [...new Set(unitSelectionReasons)],
    reasons: [...new Set(reasons)],
    infrastructureChanged,
    minimumMode: infrastructureChanged ? "regression" : mode,
    conservativeFallback,
    workers: parallelSafe ? 2 : 1,
    protectedBehaviorKeys: protectedSelection.behaviorKeys,
    protectedGroups: protectedSelection.groups,
    protectedUnitTests: protectedSelection.unitTests,
    protectedReasons: protectedSelection.reasons,
    risk,
  };
}

export function e2eFilesForGroup(groupName) {
  return Object.entries(E2E_MANIFEST)
    .filter(([, metadata]) => metadata.isolationGroup === groupName)
    .map(([file]) => file)
    .sort();
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
