import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertPackagedPrismaClient } from "./prisma-runtime.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const applicationRoot =
  process.argv[2] ||
  path.join(
    projectRoot,
    "dist-installer",
    "win-unpacked",
    "resources",
    "app",
  );
const result = assertPackagedPrismaClient(
  applicationRoot,
  "win-unpacked/resources/app",
);

process.stdout.write(
  `打包后的 Prisma Client ${result.version} 检查通过：${result.clientRoot}\n` +
    `${result.files.join("\n")}\n`,
);
