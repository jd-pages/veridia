import fs from "node:fs";
import path from "node:path";

import {
  assertPackagedPrismaClient,
  copyGeneratedPrismaClient,
} from "./prisma-runtime.mjs";

export async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const projectRoot = context.packager.projectDir;
  const applicationRoot = path.join(
    context.appOutDir,
    "resources",
    "app",
  );

  copyGeneratedPrismaClient(projectRoot, applicationRoot);
  const result = assertPackagedPrismaClient(
    applicationRoot,
    "Electron resources/app",
  );
  const chunksRoot = path.join(
    applicationRoot,
    ".next",
    "standalone",
    ".next",
    "server",
    "chunks",
  );
  const standaloneModules = path.join(
    applicationRoot,
    ".next",
    "standalone",
    "node_modules",
  );
  const playwrightAliases = new Set();
  for (const entry of fs.readdirSync(chunksRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const source = fs.readFileSync(path.join(chunksRoot, entry.name), "utf8");
    for (const match of source.matchAll(/\b(playwright-[a-f0-9]{16})\b/g)) {
      playwrightAliases.add(match[1]);
    }
  }
  for (const alias of playwrightAliases) {
    const packageFile = path.join(standaloneModules, alias, "package.json");
    if (!fs.existsSync(packageFile)) {
      const source = path.join(
        projectRoot,
        ".next",
        "standalone",
        "node_modules",
        alias,
      );
      if (!fs.existsSync(path.join(source, "package.json"))) {
        throw new Error(`桌面构建目录缺少 Playwright 外部模块别名：${alias}`);
      }
      fs.mkdirSync(path.dirname(packageFile), { recursive: true });
      fs.cpSync(source, path.dirname(packageFile), { recursive: true });
    }
    if (!fs.existsSync(packageFile)) {
      throw new Error(`Electron 产物缺少 Playwright 外部模块别名：${alias}`);
    }
  }
  const updateUrl =
    process.env.VERIDIA_UPDATE_URL ||
    "https://github.com/jd-pages/veridia/releases/latest/download";
  const parsedUpdateUrl = new URL(updateUrl);
  if (
    parsedUpdateUrl.protocol !== "https:" ||
    parsedUpdateUrl.hostname !== "github.com"
  ) {
    throw new Error("VERIDIA 软件更新地址必须使用 GitHub HTTPS Release");
  }
  fs.writeFileSync(
    path.join(context.appOutDir, "resources", "app-update.yml"),
    [
      "provider: generic",
      `url: ${updateUrl}`,
      "updaterCacheDirName: veridia-updater",
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(
    `Electron 打包前运行资源检查通过：Prisma ${result.clientRoot}，Playwright 别名 ${[...playwrightAliases].join(", ") || "无"}`,
  );
}

export default afterPack;
