import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const electronPackagePath = path.join(
  projectRoot,
  "node_modules",
  "electron",
  "package.json",
);
const electronExecutablePath = path.join(
  projectRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

if (!fs.existsSync(electronPackagePath)) {
  throw new Error(
    "缺少 Electron 开发依赖。请确认使用 npm ci --include=dev 安装完整依赖。",
  );
}
if (!fs.existsSync(electronExecutablePath)) {
  throw new Error(
    "Electron 运行文件未下载完整。请重新执行 npm rebuild electron 后再构建安装包。",
  );
}

const electronPackage = JSON.parse(
  fs.readFileSync(electronPackagePath, "utf8"),
);
process.stdout.write(
  `Electron ${electronPackage.version} 运行文件检查通过：${electronExecutablePath}\n`,
);
