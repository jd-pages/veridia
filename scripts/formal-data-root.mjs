import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readDataLocation } = require("../desktop/data-location.cjs");

export function defaultVeridiaControlRoot({
  environment = process.env,
  homeDirectory = os.homedir(),
} = {}) {
  const configuredLocalAppData = environment.LOCALAPPDATA?.trim();
  if (configuredLocalAppData) {
    return path.resolve(configuredLocalAppData, "VERIDIA");
  }

  const configuredAppData = environment.APPDATA?.trim();
  const localAppData = configuredAppData
    ? path.resolve(configuredAppData, "..", "Local")
    : path.resolve(homeDirectory, "AppData", "Local");
  return path.join(localAppData, "VERIDIA");
}

export function resolveFormalDataRoot({
  environment = process.env,
  controlRoot,
  homeDirectory,
} = {}) {
  const explicitRoot = environment.VERIDIA_PRODUCTION_DATA_DIR?.trim();
  if (explicitRoot) return path.resolve(explicitRoot);

  const resolvedControlRoot = path.resolve(
    controlRoot || defaultVeridiaControlRoot({ environment, homeDirectory }),
  );
  return readDataLocation(resolvedControlRoot) || resolvedControlRoot;
}
