import packageJson from "@/package.json";
import {
  ensureRuleDatabaseReady,
  formatRulePublishError,
} from "@/lib/rules/database-preflight";
import { exportCurrentRulePayload } from "@/lib/rules/package";

try {
  await ensureRuleDatabaseReady();
  const payload = await exportCurrentRulePayload({
    ruleVersion: "rules-local-preflight",
    minimumAppVersion: packageJson.version,
  });
  console.log(
    `本地规则读取检查通过：产品 ${payload.products.length}，活动 ${payload.campaigns.length}，阶段组 ${payload.stageGroups.length}，话题规则 ${payload.topicRules.length}，店铺规则 ${payload.storeTopicRules?.length ?? 0}，导入别名 ${payload.storeTopicRules?.reduce((total, rule) => total + rule.storeAliases.length, 0) ?? 0}。`,
  );
} catch (error) {
  console.error(
    formatRulePublishError(
      error,
      "本地规则读取检查失败，规则发布已停止。请检查数据库结构和规则数据后重试。",
    ),
  );
  process.exitCode = 1;
}
