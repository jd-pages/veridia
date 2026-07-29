import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertPackagedPrismaClient } from "./prisma-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const updateUrl =
  process.env.VERIDIA_UPDATE_URL ||
  "https://github.com/jd-pages/veridia/releases/latest/download";
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules", "electron-builder", "out", "cli", "cli.js"),
    "--win",
    process.argv.includes("--dir") ? "dir" : "nsis",
    "--publish",
    "never",
  ],
  {
    cwd: root,
    env: { ...process.env, VERIDIA_UPDATE_URL: updateUrl },
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  assertPackagedPrismaClient(
    path.join(
      root,
      "dist-installer",
      "win-unpacked",
      "resources",
      "app",
    ),
    "win-unpacked/resources/app",
  );
}
