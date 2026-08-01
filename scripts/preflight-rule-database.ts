import { ensureRuleDatabaseReady } from "@/lib/rules/database-preflight";

try {
  await ensureRuleDatabaseReady();
  console.log("本地规则数据库结构检查通过。");
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "数据库结构检查失败，规则发布已停止。",
  );
  process.exitCode = 1;
}
