import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertGeneratedPrismaClient,
  copyGeneratedPrismaClient,
} from "./prisma-runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneRoot = path.join(projectRoot, ".next", "standalone");
const runtimeRoot = path.join(projectRoot, "desktop-runtime");
const browserRoot = path.join(runtimeRoot, "ms-playwright");
const nodeRuntimeRoot = path.join(runtimeRoot, "node");

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`缺少桌面构建资源：${source}`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

if (!fs.existsSync(path.join(standaloneRoot, "server.js"))) {
  throw new Error("未找到 Next.js standalone 构建，请先运行 npm run build");
}

for (const relativePath of [
  ".env",
  ".env.local",
  ".playwright",
  "backups",
  "logs",
  "outputs",
  "artifacts",
  "release",
  "dist-installer",
  "desktop-runtime",
  "test-results",
  "playwright-report",
]) {
  fs.rmSync(path.join(standaloneRoot, relativePath), {
    recursive: true,
    force: true,
  });
}
const standalonePrisma = path.join(standaloneRoot, "prisma");
if (fs.existsSync(standalonePrisma)) {
  for (const entry of fs.readdirSync(standalonePrisma)) {
    if (/\.db(?:-journal)?$/i.test(entry)) {
      fs.rmSync(path.join(standalonePrisma, entry), { force: true });
    }
  }
}

copyDirectory(
  path.join(projectRoot, ".next", "static"),
  path.join(standaloneRoot, ".next", "static"),
);
copyDirectory(path.join(projectRoot, "public"), path.join(standaloneRoot, "public"));
copyDirectory(path.join(projectRoot, "rules"), path.join(standaloneRoot, "rules"));

assertGeneratedPrismaClient(
  projectRoot,
  "项目 node_modules/.prisma/client",
);
copyDirectory(
  path.join(projectRoot, "node_modules", "@prisma", "client"),
  path.join(standaloneRoot, "node_modules", "@prisma", "client"),
);
copyGeneratedPrismaClient(projectRoot, standaloneRoot);

// Next 16 Turbopack may externalize Prisma Client under a content-hashed
// package name while standalone tracing only copies the canonical package.
// Materialize every referenced alias so the production server remains
// relocatable inside the desktop application.
const serverChunksRoot = path.join(standaloneRoot, ".next", "server", "chunks");
const prismaClientAliases = new Set();
const playwrightAliases = new Set();
for (const entry of fs.readdirSync(serverChunksRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
  const source = fs.readFileSync(path.join(serverChunksRoot, entry.name), "utf8");
  for (const match of source.matchAll(/@prisma\/(client-[a-f0-9]{16})/g)) {
    prismaClientAliases.add(match[1]);
  }
  for (const match of source.matchAll(/\b(playwright-[a-f0-9]{16})\b/g)) {
    playwrightAliases.add(match[1]);
  }
}
for (const alias of prismaClientAliases) {
  copyDirectory(
    path.join(standaloneRoot, "node_modules", "@prisma", "client"),
    path.join(standaloneRoot, "node_modules", "@prisma", alias),
  );
}
for (const alias of playwrightAliases) {
  copyDirectory(
    path.join(projectRoot, "node_modules", "playwright"),
    path.join(standaloneRoot, "node_modules", alias),
  );
}

fs.mkdirSync(nodeRuntimeRoot, { recursive: true });
fs.copyFileSync(process.execPath, path.join(nodeRuntimeRoot, "node.exe"));

fs.mkdirSync(browserRoot, { recursive: true });
const playwrightBrowsers = JSON.parse(
  fs.readFileSync(
    path.join(projectRoot, "node_modules", "playwright-core", "browsers.json"),
    "utf8",
  ),
);
const chromiumRevision = playwrightBrowsers.browsers.find(
  (browser) => browser.name === "chromium",
)?.revision;
if (!chromiumRevision) {
  throw new Error("无法确定当前 Playwright 对应的 Chromium 版本");
}
const expectedChromiumName = `chromium-${chromiumRevision}`;
for (const entry of fs.readdirSync(browserRoot, { withFileTypes: true })) {
  if (
    entry.isDirectory() &&
    entry.name.startsWith("chromium-") &&
    entry.name !== expectedChromiumName
  ) {
    fs.rmSync(path.join(browserRoot, entry.name), {
      recursive: true,
      force: true,
    });
  }
}
const hasChromium = [
  path.join(browserRoot, expectedChromiumName, "chrome-win64", "chrome.exe"),
  path.join(browserRoot, expectedChromiumName, "chrome-win", "chrome.exe"),
].some((candidate) => fs.existsSync(candidate));
if (!hasChromium) {
  process.stdout.write("正在下载 VERIDIA 随安装包提供的 Playwright Chromium...\n");
  try {
    execFileSync(
      process.execPath,
      [
        path.join(projectRoot, "node_modules", "playwright", "cli.js"),
        "install",
        "chromium",
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: browserRoot,
          PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "120000",
        },
        stdio: "inherit",
        timeout: 5 * 60 * 1000,
      },
    );
  } catch {
    const cacheRoots = [
      process.env.PLAYWRIGHT_BROWSERS_PATH,
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "ms-playwright")
        : "",
    ].filter(Boolean);
    const cachedChromium = cacheRoots
      .flatMap((cacheRoot) =>
        fs.existsSync(cacheRoot)
          ? fs
              .readdirSync(cacheRoot, { withFileTypes: true })
              .filter(
                (entry) =>
                  entry.isDirectory() && entry.name === expectedChromiumName,
              )
              .map((entry) => ({
                name: entry.name,
                path: path.join(cacheRoot, entry.name),
              }))
          : [],
      )
      .find(({ path: chromiumPath }) =>
        [
          path.join(chromiumPath, "chrome-win64", "chrome.exe"),
          path.join(chromiumPath, "chrome-win", "chrome.exe"),
        ].some((candidate) => fs.existsSync(candidate)),
      );
    if (!cachedChromium) {
      throw new Error(
        `Playwright Chromium ${chromiumRevision} 下载失败，且本机没有可复用的匹配浏览器缓存`,
      );
    }
    fs.cpSync(
      cachedChromium.path,
      path.join(browserRoot, cachedChromium.name),
      { recursive: true },
    );
    process.stdout.write(
      `官方下载超时，已安全复用本机 Playwright Chromium 缓存：${cachedChromium.name}\n`,
    );
  }
}

let repository = process.env.GITHUB_REPOSITORY || "";
if (!repository) {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    repository =
      remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i)?.[1] || "";
  } catch {
    repository = "";
  }
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
if (!repository) {
  const repositoryUrl =
    typeof packageJson.repository === "string"
      ? packageJson.repository
      : packageJson.repository?.url || "";
  repository =
    repositoryUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i)?.[1] ||
    "";
}
const migrationRoot = path.join(projectRoot, "prisma", "migrations");
const databaseVersion = fs
  .readdirSync(migrationRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .at(-1);
const buildInfo = {
  version: packageJson.version,
  buildDate: new Date().toISOString(),
  databaseVersion,
  repository,
  signed: Boolean(process.env.CSC_LINK),
};
fs.writeFileSync(
  path.join(projectRoot, "desktop", "build-info.json"),
  JSON.stringify(buildInfo, null, 2),
  "utf8",
);

const forbiddenArtifacts = [];
function scanForbidden(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = path.relative(standaloneRoot, fullPath);
    if (entry.isDirectory()) {
      scanForbidden(fullPath);
    } else if (
      /(^|[\\/])\.env(?:\.|$)/i.test(relativePath) ||
      /\.db(?:-journal)?$/i.test(entry.name) ||
      /(^|[\\/])(Cookies|Cookies-journal)$/i.test(relativePath)
    ) {
      forbiddenArtifacts.push(relativePath);
    }
  }
}
scanForbidden(standaloneRoot);
if (forbiddenArtifacts.length) {
  throw new Error(
    `桌面构建包含禁止分发的本地数据：${forbiddenArtifacts.join("、")}`,
  );
}
process.stdout.write(
  `桌面资源准备完成：VERIDIA ${buildInfo.version}，数据库 ${databaseVersion}\n`,
);
