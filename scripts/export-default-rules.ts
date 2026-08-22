import fs from "node:fs/promises";
import path from "node:path";
import { exportCurrentRulePayload } from "@/lib/rules/package";

const payload = await exportCurrentRulePayload({
  ruleVersion: "builtin-2026.07.29.1",
  minimumAppVersion: "1.1.17",
  publishedAt: new Date("2026-07-29T00:00:00.000Z"),
});
const target = path.join(process.cwd(), "rules", "default-rules.json");
await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(
  `内置规则已生成：${payload.products.length} 个产品、${payload.campaigns.length} 个活动、${payload.topicRules.length} 条话题规则`,
);
