/* eslint-disable @typescript-eslint/no-require-imports */
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  Tray,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const APP_NAME = "VERIDIA";
const PORT = 3100;
const HOST = "127.0.0.1";

app.setName(APP_NAME);
app.setAppUserModelId("com.veridia.contentgovernance");

const localAppData =
  process.env.LOCALAPPDATA || path.join(app.getPath("appData"), "..", "Local");
const dataRoot = path.join(localAppData, APP_NAME);
app.setPath("userData", dataRoot);

const directories = {
  root: dataRoot,
  data: path.join(dataRoot, "data"),
  sessions: path.join(dataRoot, "sessions", "xiaohongshu-profile"),
  config: path.join(dataRoot, "config"),
  backups: path.join(dataRoot, "backups"),
  logs: path.join(dataRoot, "logs"),
};
const databasePath = path.join(directories.data, "veridia.db");
const configPath = path.join(directories.config, "settings.json");
const desktopLogPath = path.join(directories.logs, "desktop.log");

let mainWindow;
let tray;
let serverProcess;
let serverLogStream;
let quitting = false;
let lastUpdateInfo = null;
let lastUpdateStatus = { state: "idle" };
let manualUpdateCheck = false;
let updateCheckPromise;
let updateDownloadPromise;

function ensureDirectories() {
  for (const value of Object.values(directories)) {
    fs.mkdirSync(value, { recursive: true });
  }
}

function writeLog(message, error) {
  ensureDirectories();
  const suffix = error
    ? ` ${error instanceof Error ? error.stack || error.message : String(error)}`
    : "";
  fs.appendFileSync(
    desktopLogPath,
    `[${new Date().toISOString()}] ${message}${suffix}\n`,
    "utf8",
  );
}

function readConfig() {
  ensureDirectories();
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    current = {};
  }
  const next = {
    authSecret:
      current.authSecret || crypto.randomBytes(48).toString("base64url"),
    extensionToken:
      current.extensionToken || crypto.randomBytes(32).toString("base64url"),
    autoUpdate: current.autoUpdate !== false,
  };
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function saveConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function applicationRoot() {
  return app.getAppPath();
}

function nodeRuntimeExecutable() {
  const bundledNode = app.isPackaged
    ? path.join(process.resourcesPath, "node", "node.exe")
    : path.join(applicationRoot(), "desktop-runtime", "node", "node.exe");
  return fs.existsSync(bundledNode) ? bundledNode : process.execPath;
}

function nodeEnvironment(extra = {}) {
  const runtime = nodeRuntimeExecutable();
  const usingElectronAsNode = runtime === process.execPath;
  return {
    ...process.env,
    ...(usingElectronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    ...extra,
  };
}

function toDatabaseUrl(filePath) {
  // Prisma SQLite on Windows accepts an absolute drive path with backslashes.
  // Converting C:\... to C:/... causes schema-engine to fail creating a new DB.
  return `file:${filePath}`;
}

function latestMigrationName() {
  const migrationsRoot = path.join(applicationRoot(), "prisma", "migrations");
  try {
    return fs
      .readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .at(-1) || "unknown";
  } catch {
    return "unknown";
  }
}

function buildInfo() {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(applicationRoot(), "desktop", "build-info.json"),
        "utf8",
      ),
    );
  } catch {
    return {};
  }
}

function migrationEnvironment() {
  return nodeEnvironment({
    DATABASE_URL: toDatabaseUrl(databasePath),
    RUST_LOG: process.env.RUST_LOG || "info",
  });
}

function runDatabaseMigrations() {
  ensureDirectories();
  const existed = fs.existsSync(databasePath);
  // Prisma 6's Windows SQLite schema engine cannot create a database when the
  // datasource uses an absolute path, but it can initialize an existing empty
  // file. The desktop app requires an absolute path so data stays outside the
  // replaceable program directory.
  if (!existed) {
    fs.closeSync(fs.openSync(databasePath, "wx"));
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    directories.backups,
    `before-migration-${app.getVersion()}-${stamp}.db`,
  );
  if (existed) fs.copyFileSync(databasePath, backupPath);

  const prismaCli = path.join(
    applicationRoot(),
    "node_modules",
    "prisma",
    "build",
    "index.js",
  );
  const schemaPath = path.join(applicationRoot(), "prisma", "schema.prisma");
  const result = spawnSync(
    nodeRuntimeExecutable(),
    existed
      ? [prismaCli, "migrate", "deploy", "--schema", schemaPath]
      : [
          prismaCli,
          "migrate",
          "reset",
          "--force",
          "--skip-seed",
          "--skip-generate",
          "--schema",
          schemaPath,
        ],
    {
      cwd: applicationRoot(),
      env: migrationEnvironment(),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    writeLog("数据库迁移失败", `${result.stdout || ""}\n${result.stderr || ""}`);
    if (existed && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, databasePath);
    } else if (fs.existsSync(databasePath)) {
      fs.rmSync(databasePath, { force: true });
    }
    throw new Error(
      `数据库迁移失败，原数据库已恢复。详情：${desktopLogPath}`,
    );
  }

  const verify = spawnSync(
    nodeRuntimeExecutable(),
    [prismaCli, "migrate", "status", "--schema", schemaPath],
    {
      cwd: applicationRoot(),
      env: migrationEnvironment(),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (verify.status !== 0) {
    writeLog("数据库迁移验证失败", `${verify.stdout || ""}\n${verify.stderr || ""}`);
    if (existed && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, databasePath);
    }
    throw new Error(
      `数据库迁移验证失败，原数据库已恢复。详情：${desktopLogPath}`,
    );
  }
  writeLog(`数据库迁移完成：${latestMigrationName()}`);
}

function serverEnvironment() {
  const config = readConfig();
  const browserRoot = app.isPackaged
    ? path.join(process.resourcesPath, "ms-playwright")
    : path.join(applicationRoot(), "desktop-runtime", "ms-playwright");
  const bundledChromium = (() => {
    try {
      for (const entry of fs.readdirSync(browserRoot, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory() || !entry.name.startsWith("chromium-")) {
          continue;
        }
        for (const relativePath of [
          path.join("chrome-win64", "chrome.exe"),
          path.join("chrome-win", "chrome.exe"),
        ]) {
          const candidate = path.join(browserRoot, entry.name, relativePath);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {
      return "";
    }
    return "";
  })();
  return nodeEnvironment({
    NODE_ENV: "production",
    PORT: String(PORT),
    HOSTNAME: HOST,
    DATABASE_URL: toDatabaseUrl(databasePath),
    AUTH_SECRET: config.authSecret,
    AUTH_COOKIE_SECURE: "false",
    EXTENSION_TOKEN: config.extensionToken,
    VERIDIA_DESKTOP: "true",
    VERIDIA_DATA_DIR: dataRoot,
    VERIDIA_APP_VERSION: app.getVersion(),
    VERIDIA_BUILD_DATE:
      process.env.VERIDIA_BUILD_DATE || buildInfo().buildDate || "",
    VERIDIA_DATABASE_VERSION: latestMigrationName(),
    XHS_PROFILE_PATH: directories.sessions,
    AUTOMATION_EVIDENCE_PATH: path.join(directories.logs, "evidence"),
    PLAYWRIGHT_BROWSER_CHANNEL: "",
    PLAYWRIGHT_BROWSERS_PATH: browserRoot,
    PLAYWRIGHT_EXECUTABLE_PATH: bundledChromium,
    AI_ENABLED: "false",
  });
}

function startServer() {
  if (serverProcess && !serverProcess.killed) return;
  const standaloneRoot = path.join(applicationRoot(), ".next", "standalone");
  const serverPath = path.join(standaloneRoot, "server.js");
  if (!fs.existsSync(serverPath)) {
    throw new Error(`未找到生产服务文件：${serverPath}`);
  }
  serverLogStream = fs.createWriteStream(
    path.join(directories.logs, "server.log"),
    { flags: "a" },
  );
  const prismaAliasHook = path.join(
    applicationRoot(),
    "desktop",
    "prisma-alias.cjs",
  );
  serverProcess = spawn(
    nodeRuntimeExecutable(),
    ["--require", prismaAliasHook, serverPath],
    {
    cwd: standaloneRoot,
    env: serverEnvironment(),
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    },
  );
  serverProcess.stdout.pipe(serverLogStream);
  serverProcess.stderr.pipe(serverLogStream);
  serverProcess.once("exit", (code, signal) => {
    writeLog(`后台服务退出 code=${code} signal=${signal}`);
    serverProcess = undefined;
  });
  serverProcess.once("error", (error) => writeLog("后台服务启动失败", error));
}

function stopServer() {
  if (!serverProcess) return;
  serverProcess.kill();
  serverProcess = undefined;
  serverLogStream?.end();
  serverLogStream = undefined;
}

function waitForServer(timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(
        { hostname: HOST, port: PORT, path: "/api/setup/status", timeout: 2000 },
        (response) => {
          response.resume();
          if (response.statusCode && response.statusCode < 500) {
            resolve();
          } else {
            retry();
          }
        },
      );
      request.on("error", retry);
      request.on("timeout", () => {
        request.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(
          new Error(
            `后台服务未能在 ${Math.round(timeoutMs / 1000)} 秒内启动，请查看 ${path.join(directories.logs, "server.log")}`,
          ),
        );
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

function sendUpdateStatus(payload) {
  lastUpdateStatus = payload;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("veridia:update-status", payload);
  }
}

function normalizedReleaseNotes(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === "string"
          ? item
          : `${item.version ? `${item.version}\n` : ""}${item.note || ""}`,
      )
      .join("\n\n");
  }
  return "";
}

function setupUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on("checking-for-update", () =>
    sendUpdateStatus({ state: "checking" }),
  );
  autoUpdater.on("update-available", (info) => {
    lastUpdateInfo = {
      version: info.version,
      releaseName: info.releaseName || `VERIDIA ${info.version}`,
      releaseNotes: normalizedReleaseNotes(info.releaseNotes),
      releaseDate: info.releaseDate,
    };
    sendUpdateStatus({ state: "available", info: lastUpdateInfo });
    mainWindow?.show();
    mainWindow?.focus();
  });
  autoUpdater.on("update-not-available", () =>
    sendUpdateStatus({
      state: "not-available",
      version: app.getVersion(),
      manual: manualUpdateCheck,
    }),
  );
  autoUpdater.on("download-progress", (progress) =>
    sendUpdateStatus({
      state: "downloading",
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      info: lastUpdateInfo,
    }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    lastUpdateInfo = {
      ...lastUpdateInfo,
      version: info.version,
      releaseNotes: normalizedReleaseNotes(info.releaseNotes),
    };
    sendUpdateStatus({ state: "downloaded", info: lastUpdateInfo });
    mainWindow?.show();
    mainWindow?.focus();
  });
  autoUpdater.on("error", (error) => {
    writeLog("自动更新失败", error);
    sendUpdateStatus({
      state: "error",
      message: error?.message || "检查更新失败",
      manual: manualUpdateCheck,
    });
    manualUpdateCheck = false;
  });
}

async function checkForUpdates(manual = false) {
  if (updateCheckPromise) return updateCheckPromise;
  manualUpdateCheck = manual;
  if (!app.isPackaged) {
    sendUpdateStatus({
      state: "not-available",
      version: app.getVersion(),
      message: "开发模式不执行在线更新",
    });
    return;
  }
  updateCheckPromise = autoUpdater
    .checkForUpdates()
    .catch((error) => {
      writeLog("检查更新失败", error);
      sendUpdateStatus({
        state: "error",
        message: error instanceof Error ? error.message : "检查更新失败",
        manual,
      });
    })
    .finally(() => {
      manualUpdateCheck = false;
      updateCheckPromise = undefined;
    });
  return updateCheckPromise;
}

function registerIpc() {
  ipcMain.handle("veridia:get-system-info", () => ({
    version: app.getVersion(),
    buildDate: process.env.VERIDIA_BUILD_DATE || buildInfo().buildDate || null,
    databaseVersion: latestMigrationName(),
    dataDirectory: dataRoot,
    autoUpdate: readConfig().autoUpdate,
    packaged: app.isPackaged,
    updateStatus: lastUpdateStatus,
  }));
  ipcMain.handle("veridia:check-update", () => checkForUpdates(true));
  ipcMain.handle("veridia:download-update", async () => {
    updateDownloadPromise ??= autoUpdater.downloadUpdate().finally(() => {
      updateDownloadPromise = undefined;
    });
    await updateDownloadPromise;
    return true;
  });
  ipcMain.handle("veridia:install-update", () => {
    quitting = true;
    autoUpdater.quitAndInstall(false, true);
    return true;
  });
  ipcMain.handle("veridia:set-auto-update", (_event, enabled) => {
    saveConfig({ autoUpdate: Boolean(enabled) });
    return Boolean(enabled);
  });
  ipcMain.handle("veridia:open-release-notes", async () => {
    const repository = buildInfo().repository;
    if (repository) {
      await shell.openExternal(`https://github.com/${repository}/releases`);
    }
    return true;
  });
  ipcMain.handle("veridia:get-update-status", () => lastUpdateStatus);
}

function createTray() {
  const iconPath = path.join(applicationRoot(), "assets", "veridia.ico");
  tray = new Tray(iconPath);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开 VERIDIA",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      {
        label: "检查更新",
        click: () => void checkForUpdates(true),
      },
      { type: "separator" },
      {
        label: "退出并停止后台服务",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: "#f7f8fa",
    icon: path.join(applicationRoot(), "assets", "veridia.ico"),
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(applicationRoot(), "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(`http://${HOST}:${PORT}`);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", async (event) => {
    if (quitting) return;
    event.preventDefault();
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "关闭 VERIDIA",
      message: "关闭窗口后如何处理后台服务？",
      detail:
        "选择“最小化到托盘”可继续执行自动审核；选择“退出并停止”会安全停止本地服务。",
      buttons: ["最小化到托盘", "退出并停止", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (answer.response === 0) mainWindow.hide();
    if (answer.response === 1) {
      quitting = true;
      app.quit();
    }
  });
}

async function boot() {
  ensureDirectories();
  readConfig();
  runDatabaseMigrations();
  startServer();
  await waitForServer();
  registerIpc();
  setupUpdater();
  createMainWindow();
  createTray();
  if (readConfig().autoUpdate) {
    setTimeout(() => void checkForUpdates(false), 12_000);
  }
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    mainWindow?.show();
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.whenReady().then(boot).catch((error) => {
    writeLog("VERIDIA 启动失败", error);
    dialog.showErrorBox(
      "VERIDIA 启动失败",
      `${error instanceof Error ? error.message : String(error)}\n\n错误日志：${desktopLogPath}`,
    );
    quitting = true;
    app.quit();
  });
}

app.on("before-quit", () => {
  quitting = true;
  stopServer();
});
app.on("window-all-closed", () => {
  // Windows 桌面版保留托盘与后台服务，只有明确退出时才结束。
});
