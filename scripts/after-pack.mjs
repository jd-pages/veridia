import fs from "node:fs";
import path from "node:path";

import {
  assertPackagedPrismaClient,
  copyGeneratedPrismaClient,
} from "./prisma-runtime.mjs";

function repositoryFrom(value) {
  if (typeof value === "string") {
    const candidate = value.trim();
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(candidate)) {
      return candidate;
    }
    return (
      candidate.match(
        /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?(?:\/|$)/iu,
      )?.[1] || ""
    );
  }
  if (!value || typeof value !== "object") return "";
  if (value.provider && value.provider !== "github") return "";
  const owner = typeof value.owner === "string" ? value.owner.trim() : "";
  const repo = typeof value.repo === "string" ? value.repo.trim() : "";
  if (
    /^[A-Za-z0-9_.-]+$/u.test(owner) &&
    /^[A-Za-z0-9_.-]+$/u.test(repo)
  ) {
    return `${owner}/${repo}`;
  }
  return repositoryFrom(value.url);
}

function projectMetadata(projectRoot) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

export function resolveSoftwareUpdateRepository(
  context,
  environment = process.env,
) {
  const projectRoot = context?.packager?.projectDir || "";
  const metadata = projectRoot ? projectMetadata(projectRoot) : {};
  const configuredPublish = context?.packager?.config?.publish;
  const packagePublish = metadata?.build?.publish;
  const publishEntries = [configuredPublish, packagePublish].flatMap((value) =>
    Array.isArray(value) ? value : value ? [value] : [],
  );
  const candidates = [
    environment.GITHUB_REPOSITORY,
    environment.VERIDIA_UPDATE_URL,
    ...publishEntries,
    context?.packager?.info?.metadata?.repository,
    context?.packager?.appInfo?.metadata?.repository,
    metadata?.repository,
  ];
  return candidates.map(repositoryFrom).find(Boolean) || "";
}

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
  const updateRepository = resolveSoftwareUpdateRepository(context);
  const appUpdatePath = path.join(
    context.appOutDir,
    "resources",
    "app-update.yml",
  );
  if (updateRepository) {
    const [owner, repo] = updateRepository.split("/");
    fs.writeFileSync(
      appUpdatePath,
      [
        "provider: github",
        `owner: ${owner}`,
        `repo: ${repo}`,
        "updaterCacheDirName: veridia-updater",
        "",
      ].join("\n"),
      "utf8",
    );
  } else {
    fs.rmSync(appUpdatePath, { force: true });
    console.warn(
      "未找到软件更新 GitHub 仓库配置；本地验收继续，但已跳过 app-update.yml。正式发布前请配置 package.json repository 或 build.publish。",
    );
  }

  console.log(
    `Electron 打包前运行资源检查通过：Prisma ${result.clientRoot}，Playwright 别名 ${[...playwrightAliases].join(", ") || "无"}`,
  );
}

export default afterPack;
