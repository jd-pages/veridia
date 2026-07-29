import fs from "node:fs";
import path from "node:path";

export const REQUIRED_GENERATED_FILES = [
  "default.js",
  "index.js",
  "package.json",
  "schema.prisma",
  "query_engine-windows.dll.node",
];

export function generatedClientRoot(applicationRoot) {
  return path.join(applicationRoot, "node_modules", ".prisma", "client");
}

export function assertGeneratedPrismaClient(
  applicationRoot,
  label = applicationRoot,
) {
  const clientRoot = generatedClientRoot(applicationRoot);
  const missing = REQUIRED_GENERATED_FILES.filter(
    (relativePath) => !fs.existsSync(path.join(clientRoot, relativePath)),
  );

  if (missing.length > 0) {
    throw new Error(
      `${label} 缺少 Prisma Client 运行文件：${missing.join("、")}；` +
        "请先执行 prisma generate，禁止继续生成安装包。",
    );
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(clientRoot, "package.json"), "utf8"),
  );
  if (!packageJson.version) {
    throw new Error(`${label} 的 .prisma/client/package.json 缺少版本号。`);
  }

  return {
    clientRoot,
    files: fs
      .readdirSync(clientRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort(),
    version: packageJson.version,
  };
}

export function assertPackagedPrismaClient(
  applicationRoot,
  label = applicationRoot,
) {
  const canonicalEntry = path.join(
    applicationRoot,
    "node_modules",
    "@prisma",
    "client",
    "default.js",
  );
  if (!fs.existsSync(canonicalEntry)) {
    throw new Error(
      `${label} 缺少 node_modules/@prisma/client/default.js，禁止继续生成安装包。`,
    );
  }
  return assertGeneratedPrismaClient(applicationRoot, label);
}

export function copyGeneratedPrismaClient(sourceRoot, destinationRoot) {
  const source = assertGeneratedPrismaClient(
    sourceRoot,
    "项目 node_modules/.prisma/client",
  );
  const destination = generatedClientRoot(destinationRoot);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source.clientRoot, destination, {
    recursive: true,
    filter: (sourcePath) => !/\.tmp\d+$/i.test(path.basename(sourcePath)),
  });
  return assertGeneratedPrismaClient(
    destinationRoot,
    "复制后的 node_modules/.prisma/client",
  );
}
