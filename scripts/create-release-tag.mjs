import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const tag = `v${packageJson.version}`;
const status = execFileSync("git", ["status", "--porcelain"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (status) {
  throw new Error("创建发布标签前请先提交当前代码和版本文件");
}
execFileSync("git", ["tag", "-a", tag, "-m", `VERIDIA ${packageJson.version}`], {
  cwd: root,
  stdio: "inherit",
});
process.stdout.write(
  `已创建 ${tag}。运行 git push origin ${tag} 后将触发 GitHub Release。\n`,
);
