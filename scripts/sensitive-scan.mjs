import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} 执行失败`);
  }
  return result.stdout;
}

const candidates = git([
  "-c",
  "core.quotepath=false",
  "ls-files",
  "-co",
  "--exclude-standard",
])
  .split(/\r?\n/u)
  .filter(Boolean);
const forbiddenPath =
  /(^|\/)(?:\.env(?:\.(?!example$).*)?|logs|sessions|release|dist-installer|test-results|playwright-report)(\/|$)|\.(?:db|sqlite|sqlite3|log)$/iu;
const secretPatterns = [
  {
    label: "私钥",
    pattern: /-----BEGIN (?:ED25519 |RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  },
  {
    label: "GitHub Token",
    pattern: /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/u,
  },
  {
    label: "OpenAI Key",
    pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/u,
  },
  {
    label: "Bearer Token",
    pattern: /Bearer\s+[A-Za-z0-9._~+/-]{24,}/u,
  },
];

let scanned = 0;
for (const relative of candidates) {
  if (forbiddenPath.test(relative)) {
    throw new Error(`发现不应进入源码或安装包的敏感路径：${relative}`);
  }
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) continue;
  if (fs.statSync(absolute).size > 10 * 1024 * 1024) continue;
  scanned += 1;
  const content = fs.readFileSync(absolute, "utf8");
  const matched = secretPatterns.find(({ pattern }) => pattern.test(content));
  if (matched) {
    throw new Error(`在 ${relative} 中检测到${matched.label}`);
  }
}

process.stdout.write(
  `敏感信息扫描通过：检查 ${scanned} 个源码和配置文件，未发现私钥或真实 Token。\n`,
);
