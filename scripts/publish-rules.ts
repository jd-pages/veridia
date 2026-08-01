import { execFileSync } from "node:child_process";
import { createHash, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import packageJson from "@/package.json";
import { ensureRuleDatabaseReady } from "@/lib/rules/database-preflight";
import { exportCurrentRulePayload } from "@/lib/rules/package";
import type { RulePackageManifest } from "@/lib/rules/types";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function gh(args: string[], capture = true) {
  return execFileSync("gh", args, {
    cwd: process.cwd(),
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  }) as string;
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replace(/-/gu, ".");
}

const repository = required("VERIDIA_RULES_REPOSITORY");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
  throw new Error("VERIDIA_RULES_REPOSITORY 必须为 owner/repository");
}
const privateKeyPath = path.resolve(
  required("VERIDIA_RULES_SIGNING_KEY_PATH"),
);
if (!fs.existsSync(privateKeyPath)) throw new Error("规则签名私钥文件不存在");

try {
  await ensureRuleDatabaseReady();
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "数据库结构检查失败，规则发布已停止。",
  );
  process.exit(1);
}

gh(["--version"]);
gh(["auth", "status"]);
const existing = JSON.parse(
  gh([
    "release",
    "list",
    "--repo",
    repository,
    "--limit",
    "100",
    "--json",
    "tagName",
  ]),
) as Array<{ tagName: string }>;
const date = shanghaiDate();
const datePattern = date.replace(/\./gu, "\\.");
const sequence =
  Math.max(
    0,
    ...existing
      .map((item) =>
        new RegExp(`^rules-${datePattern}\\.(\\d+)$`, "u").exec(item.tagName),
      )
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => Number(match[1])),
  ) + 1;
const ruleVersion =
  process.env.VERIDIA_RULE_VERSION?.trim() || `rules-${date}.${sequence}`;
if (!/^rules-\d{4}\.\d{2}\.\d{2}\.\d+$/u.test(ruleVersion)) {
  throw new Error("规则版本必须符合 rules-YYYY.MM.DD.N");
}
if (existing.some((item) => item.tagName === ruleVersion)) {
  throw new Error(`远程规则版本已存在：${ruleVersion}`);
}

const payload = await exportCurrentRulePayload({
  ruleVersion,
  minimumAppVersion: packageJson.version,
});
const zip = new JSZip();
zip.file("rules.json", JSON.stringify(payload, null, 2));
const packageBytes = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});
const packageName = `veridia-rules-${ruleVersion}.zip`;
const downloadUrl = `https://github.com/${repository}/releases/download/${ruleVersion}/${packageName}`;
const manifest: RulePackageManifest = {
  ruleVersion,
  schemaVersion: payload.schemaVersion,
  publishedAt: payload.publishedAt,
  minimumAppVersion: payload.minimumAppVersion,
  downloadUrl,
  fileSize: packageBytes.length,
  sha256: createHash("sha256").update(packageBytes).digest("hex"),
  productCount: payload.products.length,
  activityCount: payload.campaigns.length,
  stageGroupCount: payload.stageGroups.length,
  topicRuleCount: payload.topicRules.length,
  templateVersion: payload.importExportTemplates?.templateVersion,
  templateConfigSha256: payload.importExportTemplates
    ? createHash("sha256")
        .update(JSON.stringify(payload.importExportTemplates))
        .digest("hex")
    : undefined,
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
const signature = sign(
  null,
  manifestBytes,
  fs.readFileSync(privateKeyPath, "utf8"),
).toString("base64");

const outputDirectory = path.join(process.cwd(), "rules-release", ruleVersion);
fs.mkdirSync(outputDirectory, { recursive: true });
const packagePath = path.join(outputDirectory, packageName);
const manifestPath = path.join(outputDirectory, "manifest.json");
const signaturePath = path.join(outputDirectory, "manifest.sig");
fs.writeFileSync(packagePath, packageBytes);
fs.writeFileSync(manifestPath, manifestBytes);
fs.writeFileSync(signaturePath, `${signature}\n`, "utf8");

// 先创建草稿；远程复核通过前不替换上一版正式规则。
gh(
  [
    "release",
    "create",
    ruleVersion,
    packagePath,
    manifestPath,
    signaturePath,
    "--repo",
    repository,
    "--draft",
    "--title",
    ruleVersion,
    "--notes",
    `VERIDIA 审核规则 ${ruleVersion}`,
  ],
  false,
);

const verifyDirectory = path.join(outputDirectory, "remote-verify");
fs.mkdirSync(verifyDirectory, { recursive: true });
gh(
  [
    "release",
    "download",
    ruleVersion,
    "--repo",
    repository,
    "--dir",
    verifyDirectory,
  ],
  false,
);
const remotePackage = fs.readFileSync(path.join(verifyDirectory, packageName));
const remoteSha256 = createHash("sha256").update(remotePackage).digest("hex");
if (
  remotePackage.length !== manifest.fileSize ||
  remoteSha256 !== manifest.sha256
) {
  throw new Error("远程规则包文件大小或 SHA-256 复核失败，Release 保持草稿");
}
gh(
  [
    "release",
    "edit",
    ruleVersion,
    "--repo",
    repository,
    "--draft=false",
    "--latest",
  ],
  false,
);
console.log(`规则发布成功：${ruleVersion}`);
console.log(`远程规则包：${downloadUrl}`);
