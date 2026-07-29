import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.E2E_PORT || 3100);
const baseURL = `http://127.0.0.1:${port}`;
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

export default defineConfig({
  testDir: "./tests/e2e",
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
    reuseExistingServer: process.env.E2E_REUSE_SERVER !== "false",
    timeout: 240_000,
    env: {
      ...process.env,
      ...(executablePath ? { PLAYWRIGHT_EXECUTABLE_PATH: executablePath } : {}),
    },
  },
});
