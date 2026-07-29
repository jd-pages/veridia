import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";

const acceptanceRoot = process.env.VERIDIA_ACCEPTANCE_ROOT;
if (!acceptanceRoot) {
  throw new Error("VERIDIA_ACCEPTANCE_ROOT is required");
}

const customRoot =
  process.env.VERIDIA_ACCEPTANCE_DATA_ROOT ||
  path.join(acceptanceRoot, "D-Drive-Simulation", "VERIDIA-Data");
const desktop = await electron.launch({
  executablePath: path.resolve(
    "dist-installer",
    "win-unpacked",
    "VERIDIA.exe",
  ),
  env: {
    ...process.env,
    LOCALAPPDATA: path.join(acceptanceRoot, "Local"),
    APPDATA: path.join(acceptanceRoot, "Roaming"),
  },
});
const page = await desktop.firstWindow({ timeout: 70_000 });
await page.waitForURL("http://127.0.0.1:3100/**", { timeout: 70_000 });
const systemInfo = await page.evaluate(() =>
  window.veridiaDesktop?.getSystemInfo(),
);
const statusResponse = await fetch("http://127.0.0.1:3100/api/setup/status");
const statusBody = await statusResponse.json();
process.stdout.write(
  `${JSON.stringify({
    httpStatus: statusResponse.status,
    systemInfo,
    setupStatus: statusBody.data,
    databaseStillExists: fs.existsSync(
      path.join(customRoot, "data", "veridia.db"),
    ),
  })}\n`,
);
await desktop.evaluate(({ app }) => app.quit()).catch(() => undefined);
