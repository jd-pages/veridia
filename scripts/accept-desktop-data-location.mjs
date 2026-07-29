import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";

const acceptanceRoot = process.env.VERIDIA_ACCEPTANCE_ROOT;
if (!acceptanceRoot) {
  throw new Error("VERIDIA_ACCEPTANCE_ROOT is required");
}

const executablePath = path.resolve(
  "dist-installer",
  "win-unpacked",
  "VERIDIA.exe",
);
const localRoot = path.join(acceptanceRoot, "Local");
const roamingRoot = path.join(acceptanceRoot, "Roaming");
const customRoot = path.join(
  acceptanceRoot,
  "D-Drive-Simulation",
  "VERIDIA-Data",
);
const screenshotPath = path.join(acceptanceRoot, "first-launch.png");
fs.mkdirSync(localRoot, { recursive: true });
fs.mkdirSync(roamingRoot, { recursive: true });

const desktop = await electron.launch({
  executablePath,
  env: {
    ...process.env,
    LOCALAPPDATA: localRoot,
    APPDATA: roamingRoot,
  },
});
const page = await desktop.firstWindow();
await page.waitForSelector("h1");

const snapshot = {
  title: await page.locator("h1").textContent(),
  description: await page.locator(".description").innerText(),
  buttons: await page.locator("button").allTextContents(),
  initialDbExists: fs.existsSync(path.join(customRoot, "data", "veridia.db")),
};
await page.screenshot({ path: screenshotPath, fullPage: true });
const confirmed = await page.evaluate(
  (target) => window.veridiaDesktop?.confirmDataDirectory(target),
  customRoot,
);
process.stdout.write(
  `${JSON.stringify({
    acceptanceRoot,
    screenshotPath,
    customRoot,
    snapshot,
    confirmed,
  })}\n`,
);
await new Promise((resolve) => setTimeout(resolve, 1_400));
