/* eslint-disable @typescript-eslint/no-require-imports */
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  shell,
  Tray,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  copyManagedData,
  createDirectoryLayout,
  ensureManagedDirectories,
  hasExistingVeridiaData,
  managedManifest,
  readDataLocation,
  validateDataDirectory,
  writeDataLocation,
} = require("./data-location.cjs");
const { createExportSaveHandler } = require("./export-save.cjs");

const APP_NAME = "VERIDIA";
const PORT = 3100;
const HOST = "127.0.0.1";
const HEALTH_PATH = "/api/health";
const serverInstanceId = crypto.randomBytes(18).toString("base64url");

app.setName(APP_NAME);
app.setAppUserModelId("com.veridia.contentgovernance");

const localAppData =
  process.env.LOCALAPPDATA || path.join(app.getPath("appData"), "..", "Local");
const defaultDataRoot = path.join(localAppData, APP_NAME);
const storedDataRoot = readDataLocation(defaultDataRoot);
let dataLocationConfirmed = Boolean(storedDataRoot);
let dataRoot = storedDataRoot || defaultDataRoot;
if (!dataLocationConfirmed && hasExistingVeridiaData(defaultDataRoot)) {
  dataLocationConfirmed = true;
  dataRoot = defaultDataRoot;
  writeDataLocation(defaultDataRoot, defaultDataRoot);
}

let directories = createDirectoryLayout(dataRoot);
let databasePath = path.join(directories.data, "veridia.db");
let configPath = path.join(directories.config, "settings.json");
let desktopLogPath = path.join(directories.logs, "desktop.log");
app.setPath("userData", dataRoot);

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
let applicationStarted = false;
let updaterConfigured = false;
let migrationInProgress = false;

function ensureDirectories() {
  ensureManagedDirectories(dataRoot);
}

function persistentSessionPath() {
  return path.join(directories.config, "local-session.bin");
}

function readPersistentSession() {
  const credentialPath = persistentSessionPath();
  if (!fs.existsSync(credentialPath) || !safeStorage.isEncryptionAvailable()) {
    return "";
  }
  try {
    const encrypted = fs.readFileSync(credentialPath);
    const token = safeStorage.decryptString(encrypted).trim();
    return /^[A-Za-z0-9_-]{40,200}$/.test(token) ? token : "";
  } catch (error) {
    writeLog("本地登录凭证已失效，已安全清除", error);
    try {
      fs.rmSync(credentialPath, { force: true });
    } catch {
      // A failed cleanup must not prevent the normal login screen from opening.
    }
    return "";
  }
}

function storePersistentSession(token) {
  const normalized = String(token || "").trim();
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(normalized)) {
    throw new Error("登录凭证格式无效。");
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows 安全凭证存储当前不可用，请重新登录后重试。");
  }
  ensureDirectories();
  const encrypted = safeStorage.encryptString(normalized);
  fs.writeFileSync(persistentSessionPath(), encrypted, { mode: 0o600 });
  return true;
}

function clearPersistentSession() {
  fs.rmSync(persistentSessionPath(), { force: true });
  return true;
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

function migrationEnvironment(targetDatabasePath = databasePath) {
  return nodeEnvironment({
    DATABASE_URL: toDatabaseUrl(targetDatabasePath),
    RUST_LOG: process.env.RUST_LOG || "info",
  });
}

function verifyDatabaseMigrations(targetDatabasePath) {
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
    [prismaCli, "migrate", "status", "--schema", schemaPath],
    {
      cwd: applicationRoot(),
      env: migrationEnvironment(targetDatabasePath),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error("迁移后的数据库校验失败，仍将继续使用原数据目录。");
  }
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
    VERIDIA_PERSISTENT_SESSION_TOKEN: readPersistentSession(),
    EXTENSION_TOKEN: config.extensionToken,
    VERIDIA_DESKTOP: "true",
    VERIDIA_DATA_LOCATION_CONFIRMED: "true",
    VERIDIA_DATA_DIR: dataRoot,
    VERIDIA_APP_VERSION: app.getVersion(),
    VERIDIA_DESKTOP_INSTANCE_ID: serverInstanceId,
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

function assertServerPortAvailable() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", (error) => {
      reject(
        new Error(
          error?.code === "EADDRINUSE"
            ? `本地端口 ${PORT} 已被其他程序占用，VERIDIA 无法启动自己的后台服务。请先退出旧版 VERIDIA 后台服务。`
            : `无法检查本地端口 ${PORT}：${error?.message || "未知错误"}`,
        ),
      );
    });
    probe.listen({ host: HOST, port: PORT, exclusive: true }, () => {
      probe.close(resolve);
    });
  });
}

function stopServer() {
  if (!serverProcess) return;
  serverProcess.kill();
  serverProcess = undefined;
  serverLogStream?.end();
  serverLogStream = undefined;
}

function stopServerAndWait() {
  const processToStop = serverProcess;
  if (!processToStop) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (serverProcess === processToStop) serverProcess = undefined;
      serverLogStream?.end();
      serverLogStream = undefined;
      resolve();
    };
    processToStop.once("exit", finish);
    processToStop.kill();
    setTimeout(() => {
      if (settled) return;
      if (process.platform === "win32" && processToStop.pid) {
        spawnSync("taskkill.exe", ["/PID", String(processToStop.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      }
      finish();
    }, 5_000);
  });
}

function waitForServer(timeoutMs = 60_000) {
  const started = Date.now();
  let lastFailure = "尚未收到健康检查响应";
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(
        { hostname: HOST, port: PORT, path: HEALTH_PATH, timeout: 2000 },
        (response) => {
          const chunks = [];
          let totalBytes = 0;
          response.on("data", (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes <= 16 * 1024) chunks.push(chunk);
          });
          response.on("end", () => {
            if (totalBytes > 16 * 1024) {
              lastFailure = "健康检查响应体过大";
              retry();
              return;
            }
            const body = Buffer.concat(chunks).toString("utf8");
            const contentType = String(response.headers["content-type"] || "");
            if (response.statusCode !== 200) {
              lastFailure = `健康检查返回 HTTP ${response.statusCode || 0}`;
              retry();
              return;
            }
            if (!contentType.toLowerCase().includes("application/json")) {
              lastFailure = `健康检查返回非 JSON（${contentType || "无 Content-Type"}）`;
              retry();
              return;
            }
            if (!body.trim()) {
              lastFailure = "健康检查返回空响应";
              retry();
              return;
            }
            try {
              const payload = JSON.parse(body);
              if (
                payload.ok !== true ||
                payload.service !== APP_NAME ||
                payload.version !== app.getVersion() ||
                payload.desktop !== true ||
                payload.instanceId !== serverInstanceId
              ) {
                lastFailure = "健康检查响应与当前桌面实例不匹配";
                retry();
                return;
              }
              resolve();
            } catch {
              lastFailure = "健康检查返回了无效 JSON";
              retry();
            }
          });
        },
      );
      request.on("error", (error) => {
        lastFailure = `健康检查连接失败（${error.code || error.message}）`;
        retry();
      });
      request.on("timeout", () => {
        lastFailure = "健康检查请求超时";
        request.destroy();
      });
    };
    const retry = () => {
      if (!serverProcess) {
        reject(
          new Error(
            `VERIDIA 后台服务进程已退出。${lastFailure}，请查看 ${path.join(directories.logs, "server.log")}`,
          ),
        );
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(
          new Error(
            `后台服务未能在 ${Math.round(timeoutMs / 1000)} 秒内通过 ${HEALTH_PATH} 健康检查：${lastFailure}。请查看 ${path.join(directories.logs, "server.log")}`,
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
  if (updaterConfigured) return;
  updaterConfigured = true;
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

function installDirectory() {
  return app.isPackaged
    ? path.dirname(process.execPath)
    : path.dirname(applicationRoot());
}

function validateSelectedDataDirectory(candidate) {
  return validateDataDirectory(candidate, {
    installDirectory: installDirectory(),
    applicationDirectory: applicationRoot(),
  });
}

async function chooseDataDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择数据保存位置",
    defaultPath: dataRoot || defaultDataRoot,
    buttonLabel: "选择此文件夹",
    properties: ["openDirectory", "createDirectory", "promptToCreate"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  try {
    return {
      success: true,
      dataDirectory: validateSelectedDataDirectory(result.filePaths[0]),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "所选目录不可用。",
    };
  }
}

function relaunchWithSelectedDataDirectory() {
  setTimeout(() => {
    quitting = true;
    app.relaunch();
    app.exit(0);
  }, 700);
}

async function confirmInitialDataDirectory(candidate) {
  try {
    const target = validateSelectedDataDirectory(candidate);
    writeDataLocation(defaultDataRoot, target);
    dataLocationConfirmed = true;
    relaunchWithSelectedDataDirectory();
    return { success: true, dataDirectory: target };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "无法保存数据目录设置。",
    };
  }
}

async function migrateDataDirectory(candidate) {
  if (migrationInProgress) {
    return { success: false, error: "数据迁移正在进行，请勿重复操作。" };
  }
  migrationInProgress = true;
  const sourceRoot = dataRoot;
  let targetRoot;
  let targetCreated = false;
  let serverWasRunning = Boolean(serverProcess);
  try {
    targetRoot = validateSelectedDataDirectory(candidate);
    if (path.resolve(targetRoot).toLowerCase() === path.resolve(sourceRoot).toLowerCase()) {
      throw new Error("所选目录与当前数据目录相同。");
    }
    const existingEntries = fs.readdirSync(targetRoot);
    if (existingEntries.length > 0) {
      throw new Error("目标目录不是空目录，请选择新的空文件夹。");
    }

    ensureDirectories();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (fs.existsSync(databasePath)) {
      fs.copyFileSync(
        databasePath,
        path.join(directories.backups, `before-data-move-${stamp}.db`),
      );
    }

    await stopServerAndWait();
    const beforeManifest = managedManifest(sourceRoot);
    const copied = copyManagedData(sourceRoot, targetRoot);
    targetCreated = true;
    if (
      JSON.stringify(beforeManifest) !== JSON.stringify(copied.targetManifest)
    ) {
      throw new Error("迁移文件校验失败，原数据目录保持不变。");
    }
    const migratedDatabase = path.join(targetRoot, "data", "veridia.db");
    if (!fs.existsSync(migratedDatabase)) {
      throw new Error("迁移后的数据库不存在，原数据目录保持不变。");
    }
    verifyDatabaseMigrations(migratedDatabase);

    writeDataLocation(defaultDataRoot, targetRoot);
    writeLog(`数据目录迁移校验完成：${sourceRoot} -> ${targetRoot}`);
    relaunchWithSelectedDataDirectory();
    return {
      success: true,
      dataDirectory: targetRoot,
      fileCount: copied.targetManifest.length,
    };
  } catch (error) {
    try {
      writeDataLocation(defaultDataRoot, sourceRoot);
    } catch (pointerError) {
      writeLog("恢复原数据目录定位配置失败", pointerError);
    }
    if (targetCreated && targetRoot && fs.existsSync(targetRoot)) {
      try {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        writeLog("清理迁移失败目录时出错", cleanupError);
      }
    }
    if (serverWasRunning && !serverProcess) {
      try {
        startServer();
        await waitForServer();
      } catch (restartError) {
        writeLog("数据迁移失败后重启后台服务失败", restartError);
      }
    }
    writeLog("数据目录迁移失败", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "数据迁移失败，原数据目录保持不变。",
    };
  } finally {
    migrationInProgress = false;
  }
}

function registerIpc() {
  ipcMain.handle("veridia:get-system-info", () => ({
    version: app.getVersion(),
    buildDate: process.env.VERIDIA_BUILD_DATE || buildInfo().buildDate || null,
    databaseVersion: latestMigrationName(),
    dataDirectory: dataRoot,
    autoUpdate: dataLocationConfirmed ? readConfig().autoUpdate : true,
    packaged: app.isPackaged,
    updateStatus: lastUpdateStatus,
  }));
  ipcMain.handle("veridia:get-data-location", () => ({
    confirmed: dataLocationConfirmed,
    defaultDirectory: defaultDataRoot,
    currentDirectory: dataRoot,
    installDirectory: installDirectory(),
  }));
  ipcMain.handle("veridia:choose-data-directory", chooseDataDirectory);
  ipcMain.handle("veridia:confirm-data-directory", (_event, candidate) =>
    confirmInitialDataDirectory(candidate),
  );
  ipcMain.handle("veridia:migrate-data-directory", (_event, candidate) =>
    migrateDataDirectory(candidate),
  );
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
  ipcMain.handle("veridia:store-persistent-session", (_event, token) =>
    storePersistentSession(token),
  );
  ipcMain.handle("veridia:clear-persistent-session", () =>
    clearPersistentSession(),
  );
  ipcMain.removeHandler("veridia:save-export-file");
  ipcMain.handle(
    "veridia:save-export-file",
    createExportSaveHandler({
      app,
      dialog,
      fs,
      path,
      getWindow: () => mainWindow,
      writeLog,
    }),
  );
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
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", async (event) => {
    if (quitting) return;
    if (!applicationStarted) {
      quitting = true;
      app.quit();
      return;
    }
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

async function startApplication() {
  ensureDirectories();
  readConfig();
  runDatabaseMigrations();
  await assertServerPortAvailable();
  startServer();
  await waitForServer();
  setupUpdater();
  applicationStarted = true;
  await mainWindow.loadURL(`http://${HOST}:${PORT}`);
  createTray();
  if (readConfig().autoUpdate) {
    setTimeout(() => void checkForUpdates(false), 12_000);
  }
}

async function boot() {
  registerIpc();
  createMainWindow();
  if (!dataLocationConfirmed) {
    await mainWindow.loadFile(
      path.join(applicationRoot(), "desktop", "data-location.html"),
    );
    return;
  }
  await startApplication();
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
