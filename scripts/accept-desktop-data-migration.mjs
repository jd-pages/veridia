import { _electron as electron } from "playwright";
import path from "node:path";

const acceptanceRoot = process.env.VERIDIA_ACCEPTANCE_ROOT;
if (!acceptanceRoot) {
  throw new Error("VERIDIA_ACCEPTANCE_ROOT is required");
}

const targetRoot = path.join(
  acceptanceRoot,
  "Second-Drive-Simulation",
  "VERIDIA-Data",
);
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
const result = await page.evaluate(
  (target) => window.veridiaDesktop?.migrateDataDirectory(target),
  targetRoot,
);
process.stdout.write(`${JSON.stringify({ targetRoot, result })}\n`);
await new Promise((resolve) => setTimeout(resolve, 1_400));
