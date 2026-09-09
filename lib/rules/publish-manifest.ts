import { createHash } from "node:crypto";
import type { RulePackageManifest, RulePackagePayload } from "./types";
import { assertValidRulePackageVersion } from "./version-contract";

export function createRulePackageManifest(input: {
  payload: RulePackagePayload;
  packageBytes: Buffer;
  downloadUrl: string;
}): RulePackageManifest {
  const { payload, packageBytes, downloadUrl } = input;
  const minimumAppVersion = assertValidRulePackageVersion(
    payload.minimumAppVersion,
    "规则包内容最低软件版本",
  );
  const storeAliasCount =
    payload.storeTopicRules?.reduce(
      (total, rule) => total + rule.storeAliases.length,
      0,
    ) ?? 0;
  return {
    ruleVersion: payload.ruleVersion,
    schemaVersion: payload.schemaVersion,
    publishedAt: payload.publishedAt,
    minimumAppVersion,
    downloadUrl,
    fileSize: packageBytes.length,
    sha256: createHash("sha256").update(packageBytes).digest("hex"),
    productCount: payload.products.length,
    activityCount: payload.campaigns.length,
    stageGroupCount: payload.stageGroups.length,
    topicRuleCount: payload.topicRules.length,
    storeTopicRuleCount: payload.storeTopicRules?.length,
    storeAliasCount: payload.storeTopicRules ? storeAliasCount : undefined,
    templateVersion: payload.importExportTemplates?.templateVersion,
    templateConfigSha256: payload.importExportTemplates
      ? createHash("sha256")
          .update(JSON.stringify(payload.importExportTemplates))
          .digest("hex")
      : undefined,
  };
}
