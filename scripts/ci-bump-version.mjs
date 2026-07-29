import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const bump = process.argv[2];
if (!["patch", "minor", "major"].includes(bump)) {
  throw new Error("CI 发布类型必须为 patch、minor 或 major");
}
execFileSync("npm.cmd", ["version", bump, "--no-git-tag-version"], {
  stdio: "inherit",
});
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = packageJson.version;
const date = new Date().toISOString().slice(0, 10);
const changelog = path.resolve("CHANGELOG.md");
const previous = fs.existsSync(changelog)
  ? fs.readFileSync(changelog, "utf8").replace(/^# VERIDIA 更新日志\s*/u, "")
  : "";
fs.writeFileSync(
  changelog,
  `# VERIDIA 更新日志\n\n## ${version} - ${date}\n\n- 通过自动测试与 Windows 桌面发布流水线验证。\n\n${previous}`.trimEnd() +
    "\n",
  "utf8",
);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`);
}
process.stdout.write(`CI_VERSION=${version}\n`);
