import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import {
  cleanupKnownTestNextGeneratedTypes,
  formalNextTypesNeedGeneration,
} from "./next-type-isolation.mjs";

const root = process.cwd();
const removed = cleanupKnownTestNextGeneratedTypes(root);
if (removed.length > 0) {
  process.stdout.write(`已隔离 E2E generated types：${removed.join("、")}\n`);
}

if (formalNextTypesNeedGeneration(root)) {
  process.stdout.write("正式 Next route types 需要恢复，正在执行 next typegen。\n");
  const environment = { ...process.env };
  delete environment.VERIDIA_NEXT_DIST_DIR;
  delete environment.VERIDIA_NEXT_TSCONFIG_PATH;
  delete environment.E2E_NEXT_DIST_DIR;
  const result = spawnSync(
    process.execPath,
    [path.join(root, "node_modules", "next", "dist", "bin", "next"), "typegen"],
    { cwd: root, env: environment, stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (formalNextTypesNeedGeneration(root)) {
    throw new Error("next typegen 完成后正式 route types 仍不可用");
  }
}
