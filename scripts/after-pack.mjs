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
  const accountPublicKey = path.join(
    applicationRoot,
    "config",
    "account-signing-ed25519-public.pem",
  );
  if (!fs.existsSync(accountPublicKey)) {
    throw new Error("Electron 产物缺少账号签名公钥");
  }
  const forbiddenNames = new Set([
    "创建veridia账号.bat",
    "创建veridia密码重置码.bat",
    "创建veridia账号更新码.bat",
    "account-developer-tool.ts",
  ]);
  const forbiddenAccountArtifacts = [];
  function scanAccountArtifacts(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) scanAccountArtifacts(fullPath);
      else if (
        forbiddenNames.has(entry.name.toLocaleLowerCase("zh-CN")) ||
        /(?:account|rules?).*signing.*private.*\.pem$/i.test(entry.name)
      ) {
        forbiddenAccountArtifacts.push(path.relative(applicationRoot, fullPath));
      }
    }
  }
  scanAccountArtifacts(applicationRoot);
  if (forbiddenAccountArtifacts.length) {
    throw new Error(
      `Electron 产物包含开发者账号文件：${forbiddenAccountArtifacts.join("、")}`,
    );
  }

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
  const configuredRepository = process.env.GITHUB_REPOSITORY || "";
  const repositoryUrl =
    typeof context.packager.appInfo.metadata.repository === "string"
      ? context.packager.appInfo.metadata.repository
      : context.packager.appInfo.metadata.repository?.url || "";
  const updateUrl = process.env.VERIDIA_UPDATE_URL || repositoryUrl;
  const updateRepository =
    configuredRepository ||
    updateUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?(?:\/|$)/i)?.[1] ||
    "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(updateRepository)) {
    throw new Error("VERIDIA 软件更新仓库必须是有效的 GitHub owner/repo");
  }
  const [owner, repo] = updateRepository.split("/");
  fs.writeFileSync(
    path.join(context.appOutDir, "resources", "app-update.yml"),
    [
      "provider: github",
      `owner: ${owner}`,
      `repo: ${repo}`,
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
