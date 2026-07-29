import path from "node:path";

import {
  assertPackagedPrismaClient,
  copyGeneratedPrismaClient,
} from "./prisma-runtime.mjs";

export async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const projectRoot = context.packager.projectDir;
  const applicationRoot = path.join(
    context.appOutDir,
    "resources",
    "app",
  );

  copyGeneratedPrismaClient(projectRoot, applicationRoot);
  const result = assertPackagedPrismaClient(
    applicationRoot,
    "Electron resources/app",
  );

  console.log(
    `Electron 打包前 Prisma Client 检查通过：${result.clientRoot}`,
  );
}

export default afterPack;
