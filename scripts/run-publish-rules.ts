import { formatRulePublishError } from "@/lib/rules/database-preflight";

try {
  await import("./publish-rules");
} catch (error) {
  console.error(formatRulePublishError(error));
  process.exitCode = 1;
}
