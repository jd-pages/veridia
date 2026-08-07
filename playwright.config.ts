import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = Number(process.env.E2E_PORT || 3100);
const baseURL = `http://127.0.0.1:${port}`;
const defaultE2eDatabasePath = path.resolve(
  process.cwd(),
  "prisma",
  "e2e.db",
);
const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL?.trim() ||
  `file:${defaultE2eDatabasePath}`;
const bundledBrowserRoot = path.join(
  process.cwd(),
  "desktop-runtime",
  "ms-playwright",
);
const bundledExecutable = fs.existsSync(bundledBrowserRoot)
  ? fs
      .readdirSync(bundledBrowserRoot, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("chromium-"),
      )
      .map((entry) =>
        path.join(
          bundledBrowserRoot,
          entry.name,
          "chrome-win64",
          "chrome.exe",
        ),
      )
      .find((candidate) => fs.existsSync(candidate))
  : undefined;
const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim() || bundledExecutable;
const e2eAccountPublicKeyPath =
  process.env.VERIDIA_ACCOUNT_SIGNING_PUBLIC_KEY_PATH?.trim() ||
  path.join(os.tmpdir(), "veridia-e2e-account-signing", "public.pem");
const e2eXhsProfilePath =
  process.env.E2E_XHS_PROFILE_PATH?.trim() ||
  path.join(process.cwd(), ".playwright", "xhs-e2e-profile");
const e2eDouyinProfilePath =
  process.env.E2E_DOUYIN_PROFILE_PATH?.trim() ||
    path.join(process.cwd(), ".playwright", "douyin-e2e-profile");
const e2eNextDistDir =
  process.env.E2E_NEXT_DIST_DIR?.trim() ||
  path.join(".playwright", "next-e2e");

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore:
    process.env.VERIDIA_BROWSER_STRESS_E2E === "true"
      ? undefined
      : "**/*.stress.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1366, height: 768 },
        ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL?.trim()
          ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL }
          : executablePath
            ? { launchOptions: { executablePath } }
            : {}),
      },
    },
  ],
  webServer: {
    command: `node node_modules/next/dist/bin/next dev -p ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "true",
    timeout: 240_000,
    env: {
      ...process.env,
      DATABASE_URL: e2eDatabaseUrl,
      EXTENSION_TOKEN:
        process.env.EXTENSION_TOKEN || "local-extension-demo-token",
      VERIDIA_ACCOUNT_SIGNING_PUBLIC_KEY_PATH: e2eAccountPublicKeyPath,
      XHS_PROFILE_PATH: e2eXhsProfilePath,
      DOUYIN_PROFILE_PATH: e2eDouyinProfilePath,
      VERIDIA_NEXT_DIST_DIR: e2eNextDistDir,
      AUTOMATION_LOCAL_MOCK_WAIT_CAP_MS: "5",
      ...(executablePath ? { PLAYWRIGHT_EXECUTABLE_PATH: executablePath } : {}),
    },
  },
});
