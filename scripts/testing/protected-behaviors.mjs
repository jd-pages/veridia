import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PROTECTED_EXPECTATION_CHANGE_POLICY =
  "USER_APPROVED_BUSINESS_CHANGE_ONLY";

const behavior = (definition) => Object.freeze({
  ...definition,
  protectedExpectation: true,
  expectationChangePolicy: PROTECTED_EXPECTATION_CHANGE_POLICY,
});

export const PROTECTED_BEHAVIORS = Object.freeze([
  behavior({ key: "XHS_NOTE_NOT_FOUND", module: "XHS page classification", invariant: "404、-510001、明确不存在文案或 HTTP 404 必须终态为 NOTE_NOT_FOUND，且不得进入普通内容审核。", unitTests: ["tests/unit/automation.test.ts", "tests/unit/audit-engine.test.ts", "tests/unit/processing-failure.test.ts", "tests/unit/protected-behavior-invariants.test.ts"], e2eTests: ["tests/e2e/audit-flow.spec.ts"], fixtures: ["tests/regression/fixtures/xhs/note-not-found.html"], triggerFiles: ["lib/automation/xhs-readiness.ts", "lib/automation/xhs-page-evidence.ts", "lib/automation/page-classification.ts", "lib/audit-engine.ts"] }),
  behavior({ key: "XHS_GENERIC_SHELL_DELAYED_404", module: "XHS readiness", invariant: "generic shell/JSON-LD 出现后 750ms 跳转 404 时不得提前抽取，最终必须 NOTE_NOT_FOUND。", unitTests: ["tests/unit/xhs-readiness.test.ts", "tests/unit/xhs-page-evidence.test.ts"], e2eTests: ["tests/e2e/audit-flow.spec.ts"], fixtures: ["tests/regression/fixtures/xhs/generic-shell-delayed-404.html"], triggerFiles: ["lib/automation/xhs-readiness.ts", "lib/automation/xhs-page-evidence.ts"] }),
  behavior({ key: "XHS_NORMAL_NOTE", module: "XHS extraction", invariant: "普通图文的标题、正文、图片、话题、平台时间及公开状态均从 current-note scope 正常提取。", unitTests: ["tests/unit/xhs-page-evidence.test.ts", "tests/unit/xhs-topic-evidence-dom.test.ts", "tests/unit/xhs-published-at-dom.test.ts"], e2eTests: ["tests/e2e/audit-flow.spec.ts", "tests/e2e/platform-published-at.spec.ts"], fixtures: ["tests/unit/xhs-page-evidence.test.ts"], triggerFiles: ["lib/automation/xhs-page-evidence.ts", "lib/automation/xhs-readiness.ts", "lib/automation/xhs-adapter.ts"] }),
  behavior({ key: "XHS_LIVE_PHOTO", module: "XHS media extraction", invariant: "Live Photo 保持 IMAGE_TEXT、图片数量正确且不误判为视频，同时标题正文正常。", unitTests: ["tests/unit/xhs-live-photo-current-note.test.ts", "tests/unit/image-count-extractor.test.ts"], e2eTests: ["tests/e2e/audit-flow.spec.ts"], fixtures: ["tests/unit/xhs-live-photo-current-note.test.ts"], triggerFiles: ["lib/automation/xhs-page-evidence.ts", "lib/automation/xhs-adapter.ts"] }),
  behavior({ key: "XHS_PLATFORM_TIME", module: "XHS published time", invariant: "平台发布时间只取当前作品可靠证据，不被编辑时间或邻近作品污染。", unitTests: ["tests/unit/xhs-published-at-dom.test.ts", "tests/unit/xhs-original-published-at.test.ts", "tests/unit/platform-published-at.test.ts"], e2eTests: ["tests/e2e/platform-published-at.spec.ts"], fixtures: ["tests/unit/xhs-published-at-dom.test.ts"], triggerFiles: ["lib/automation/xhs-page-evidence.ts", "lib/platform-published-at.ts"] }),
  behavior({ key: "XHS_INTERACTION_ZERO", module: "XHS interaction evidence", invariant: "0/0/0 与 1/0/0 均为可靠值并计算 total；wrapper 缺失为 UNAVAILABLE，冲突为 CONFLICT。", unitTests: ["tests/unit/xhs-interaction-dom.test.ts", "tests/unit/interaction-metrics.test.ts"], e2eTests: ["tests/e2e/audit-flow.spec.ts"], fixtures: ["tests/unit/xhs-interaction-dom.test.ts"], triggerFiles: ["lib/automation/xhs-page-evidence.ts", "lib/interaction-metrics.ts"] }),
  behavior({ key: "XHS_INTERACTION_NORMAL", module: "XHS interaction evidence", invariant: "8/4/10 必须可靠计算 total=22，且评论区与推荐作品数字不得污染当前作品。", unitTests: ["tests/unit/xhs-live-photo-current-note.test.ts", "tests/unit/xhs-interaction-dom.test.ts", "tests/unit/interaction-metrics.test.ts"], e2eTests: ["tests/e2e/audit-flow.spec.ts"], fixtures: ["tests/unit/xhs-live-photo-current-note.test.ts"], triggerFiles: ["lib/automation/xhs-page-evidence.ts", "lib/interaction-metrics.ts"] }),
  behavior({ key: "KABRITA_STORE_NOT_REQUIRED", module: "Store topic audit", invariant: "Kabrita 店铺映射可为 MATCHED，但店铺话题保持 NOT_REQUIRED，页面异常不得制造 STORE_TOPIC_MISSING。", unitTests: ["tests/unit/store-topic-config.test.ts", "tests/unit/store-topic-channel-policy.test.ts", "tests/unit/protected-behavior-invariants.test.ts"], e2eTests: ["tests/e2e/store-topic-audit.spec.ts"], fixtures: ["rules/default-rules.json"], triggerFiles: ["lib/store-topic-config.ts", "lib/store-topic-audit.ts", "rules/default-rules.json"] }),
  behavior({ key: "KABRITA_NO_PRODUCT_STAGE_TOPIC", module: "Campaign stage requirements", invariant: "Kabrita 可保留 productStage 数据，但 PRODUCT_STAGE topic requirement 永远为 NONE。", unitTests: ["tests/unit/campaign-stage-requirement.test.ts", "tests/unit/protected-behavior-invariants.test.ts"], e2eTests: ["tests/e2e/product-stage-topic.spec.ts", "tests/e2e/rule-brand-navigation.spec.ts"], fixtures: ["rules/default-rules.json"], triggerFiles: ["lib/campaign-stage-requirement.ts", "lib/product-stage.ts", "rules/default-rules.json"] }),
  behavior({ key: "STORE_ALIAS_IDENTITY_ONLY", module: "Store mapping", invariant: "STORE_ALIAS 只做导入身份映射，绝不能自动成为页面 ACCEPTED/REQUIRED 话题。", unitTests: ["tests/unit/store-topic-config.test.ts", "tests/unit/store-accepted-topics.test.ts", "tests/unit/protected-behavior-invariants.test.ts"], e2eTests: ["tests/e2e/store-topic-rule-management.spec.ts", "tests/e2e/store-topic-audit.spec.ts"], fixtures: ["rules/default-rules.json"], triggerFiles: ["lib/store-topic-config.ts", "lib/store-accepted-topics.ts"] }),
  behavior({ key: "DELETED_RESULT_DUPLICATE_RELEASE", module: "Duplicate lifecycle", invariant: "已删除正式 Result 永不进入 effective history；有效历史为 0 时不得标记 duplicate。", unitTests: ["tests/unit/audit-task-deduplication.test.ts", "tests/unit/audit-result-deletion.test.ts", "tests/unit/duplicate-reaudit.test.ts", "tests/unit/protected-behavior-invariants.test.ts"], e2eTests: ["tests/e2e/result-lifecycle.spec.ts"], fixtures: ["tests/unit/audit-result-deletion.test.ts"], triggerFiles: ["lib/audit-task-deduplication.ts", "lib/import-task-metadata.ts", "app/api/results"] }),
  behavior({ key: "BULK_DUPLICATE_CONFIRM", module: "Bulk duplicate confirmation", invariant: "真实重复支持单条、多选和全部确认；批量确认不能绕过任何其他预检错误。", unitTests: ["tests/unit/bulk-duplicate-reaudit.test.ts", "tests/unit/duplicate-reaudit.test.ts"], e2eTests: ["tests/e2e/audit-flow.spec.ts"], fixtures: ["tests/unit/bulk-duplicate-reaudit.test.ts"], triggerFiles: ["app/api/audit-tasks", "lib/import-task-metadata.ts"] }),
  behavior({ key: "IMPORT_CASCADE_DELETE", module: "Import deletion", invariant: "删除 Import 仅级联其 Batch/Task/Result、释放 duplicate occupancy，且不影响同名文件的其他 Import。", unitTests: ["tests/unit/import-record-deletion.test.ts"], e2eTests: ["tests/e2e/import-record-deletion.spec.ts"], fixtures: ["tests/unit/import-record-deletion.test.ts"], triggerFiles: ["app/api/imports", "lib/import-record-deletion.ts", "app/(admin)/imports"] }),
  behavior({ key: "DANONE_STAGE_SEGMENT_SEMANTICS", module: "Danone import template", invariant: "仅 Danone 模板使用阶段 IFFO/GUM 与段位 P/1/2/3/4/1+/2+；反向输入必须失败。", unitTests: ["tests/unit/danone-import-templates.test.ts", "tests/unit/product-stage.test.ts", "tests/unit/protected-behavior-invariants.test.ts"], e2eTests: ["tests/e2e/stage-import.spec.ts"], fixtures: ["tests/unit/danone-import-templates.test.ts"], triggerFiles: ["lib/import-export.ts", "lib/product-stage.ts", "app/api/imports"] }),
  behavior({ key: "KABRITA_TEMPLATE_ISOLATION", module: "Kabrita import template", invariant: "Kabrita 模板保持独立解析，不得继承 Danone 阶段/段位语义。", unitTests: ["tests/unit/import-export-templates.test.ts", "tests/unit/danone-import-templates.test.ts"], e2eTests: ["tests/e2e/kabrita-excel-template.spec.ts", "tests/e2e/stage-import.spec.ts"], fixtures: ["tests/unit/import-export-templates.test.ts"], triggerFiles: ["lib/import-export.ts", "lib/product-stage.ts", "app/api/imports"] }),
]);

export const PROTECTED_BEHAVIOR_GROUPS = Object.freeze({
  XHS_REGRESSION_ALL: Object.freeze(["XHS_NOTE_NOT_FOUND", "XHS_GENERIC_SHELL_DELAYED_404", "XHS_NORMAL_NOTE", "XHS_LIVE_PHOTO", "XHS_PLATFORM_TIME", "XHS_INTERACTION_ZERO", "XHS_INTERACTION_NORMAL"]),
  DUPLICATE_REGRESSION_ALL: Object.freeze(["DELETED_RESULT_DUPLICATE_RELEASE", "BULK_DUPLICATE_CONFIRM"]),
  STORE_MAPPING_AND_TOPIC_ALL: Object.freeze(["KABRITA_STORE_NOT_REQUIRED", "KABRITA_NO_PRODUCT_STAGE_TOPIC", "STORE_ALIAS_IDENTITY_ONLY"]),
  IMPORT_DELETE_AND_DUPLICATE_ALL: Object.freeze(["DELETED_RESULT_DUPLICATE_RELEASE", "BULK_DUPLICATE_CONFIRM", "IMPORT_CASCADE_DELETE"]),
  TEMPLATE_ISOLATION_ALL: Object.freeze(["DANONE_STAGE_SEGMENT_SEMANTICS", "KABRITA_TEMPLATE_ISOLATION"]),
});

export const CHANGE_IMPACT_MAP = Object.freeze([
  { match: /(?:^|\/)(?:scripts\/testing\/|playwright\.config\.ts|vitest\.config\.ts|tests\/unit\/test-gates\.test\.ts)/u, groups: Object.keys(PROTECTED_BEHAVIOR_GROUPS), reason: "测试基础设施变化，保守执行全部受保护行为" },
  { match: /(?:xhs-readiness|xhs-page-evidence|page-classification|xhs-adapter|current-note|xhs-interaction|interaction-metrics|automation\/browser)/iu, groups: ["XHS_REGRESSION_ALL"], reason: "XHS 共享取证/分类模块变化" },
  { match: /(?:audit-task-deduplication|duplicate-reaudit|bulk-duplicate|import-task-metadata)/iu, groups: ["DUPLICATE_REGRESSION_ALL"], reason: "重复识别或确认生命周期变化" },
  { match: /(?:store-topic|storeTopic|store-accepted-topics)/u, groups: ["STORE_MAPPING_AND_TOPIC_ALL"], reason: "店铺映射与页面话题边界变化" },
  { match: /(?:import-record-deletion|api\/imports\/[^/]+|app\/\(admin\)\/imports)/iu, groups: ["IMPORT_DELETE_AND_DUPLICATE_ALL"], reason: "Import 删除会影响级联数据与重复占用" },
  { match: /(?:danone|kabrita-excel-template|import-export|product-stage|stage-import)/iu, groups: ["TEMPLATE_ISOLATION_ALL"], reason: "Danone/Kabrita 模板或阶段解析变化" },
  { match: /(?:campaign-stage-requirement|default-rules\.json)/iu, groups: ["STORE_MAPPING_AND_TOPIC_ALL", "TEMPLATE_ISOLATION_ALL"], reason: "正式规则或阶段需求变化" },
]);

const unique = (values) => [...new Set(values)].sort();
const behaviorByKey = new Map(PROTECTED_BEHAVIORS.map((item) => [item.key, item]));

export function selectProtectedBehaviors(changedFiles, options = {}) {
  const normalized = unique((changedFiles || []).map((file) => file.replaceAll("\\", "/")));
  const groups = new Set();
  const directKeys = new Set();
  const reasons = [];
  if (options.full || options.conservative || normalized.length === 0) {
    Object.keys(PROTECTED_BEHAVIOR_GROUPS).forEach((group) => groups.add(group));
    reasons.push(options.full ? "FULL 固定执行全部受保护行为" : "无法精确限定影响范围，保守执行全部受保护行为");
  } else {
    for (const file of normalized) {
      for (const rule of CHANGE_IMPACT_MAP.filter((candidate) => candidate.match.test(file))) {
        rule.groups.forEach((group) => groups.add(group));
        reasons.push(`${file}: ${rule.reason}`);
      }
      for (const item of PROTECTED_BEHAVIORS) {
        if (
          item.unitTests.includes(file) ||
          item.e2eTests.includes(file) ||
          item.fixtures.includes(file) ||
          item.triggerFiles.some((trigger) =>
            file === trigger || file.startsWith(`${trigger}/`)
          )
        ) directKeys.add(item.key);
      }
    }
  }
  const behaviorKeys = new Set(directKeys);
  for (const group of groups) PROTECTED_BEHAVIOR_GROUPS[group].forEach((key) => behaviorKeys.add(key));
  const selected = [...behaviorKeys].map((key) => behaviorByKey.get(key)).filter(Boolean);
  return {
    behaviorKeys: unique(selected.map((item) => item.key)),
    groups: unique([...groups]),
    unitTests: unique(selected.flatMap((item) => item.unitTests)),
    e2eTests: unique(selected.flatMap((item) => item.e2eTests)),
    reasons: unique(reasons),
  };
}

export function validateProtectedBehaviorRegistry(root = process.cwd()) {
  const errors = [];
  const keys = PROTECTED_BEHAVIORS.map((item) => item.key);
  if (new Set(keys).size !== keys.length) errors.push("behavior key 必须唯一");
  for (const item of PROTECTED_BEHAVIORS) {
    if (!item.invariant?.trim()) errors.push(`${item.key}: 缺少业务不变量`);
    if (!item.unitTests.length) errors.push(`${item.key}: 缺少 Unit`);
    if (!item.e2eTests.length) errors.push(`${item.key}: 缺少 E2E`);
    if (!item.fixtures.length) errors.push(`${item.key}: 缺少 fixture`);
    if (!item.triggerFiles.length) errors.push(`${item.key}: 缺少触发文件范围`);
    if (!item.protectedExpectation || item.expectationChangePolicy !== PROTECTED_EXPECTATION_CHANGE_POLICY) errors.push(`${item.key}: protected expectation 策略无效`);
    for (const file of [...item.unitTests, ...item.e2eTests, ...item.fixtures]) {
      if (!fs.existsSync(path.join(root, file))) errors.push(`${item.key}: 引用文件不存在 ${file}`);
    }
  }
  for (const [group, members] of Object.entries(PROTECTED_BEHAVIOR_GROUPS)) {
    if (!members.length) errors.push(`${group}: 空组`);
    for (const key of members) if (!behaviorByKey.has(key)) errors.push(`${group}: 未知 behavior ${key}`);
  }
  if (errors.length) throw new Error(`Protected Behavior Registry 无效：\n- ${errors.join("\n- ")}`);
  return { behaviorCount: PROTECTED_BEHAVIORS.length, groupCount: Object.keys(PROTECTED_BEHAVIOR_GROUPS).length, keys: [...keys].sort() };
}

function printRegistry() {
  const validation = validateProtectedBehaviorRegistry();
  process.stdout.write(`PROTECTED_BEHAVIOR_REGISTRY=PASSED behaviors=${validation.behaviorCount} groups=${validation.groupCount}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) printRegistry();
