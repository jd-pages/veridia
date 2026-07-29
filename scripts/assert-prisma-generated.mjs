import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertGeneratedPrismaClient } from "./prisma-runtime.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const result = assertGeneratedPrismaClient(
  projectRoot,
  "Prisma generate 输出",
);

process.stdout.write(
  `Prisma Client ${result.version} 已生成：${result.clientRoot}\n`,
);
