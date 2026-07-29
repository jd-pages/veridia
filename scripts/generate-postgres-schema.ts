import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const sourcePath = path.join(process.cwd(), "prisma", "schema.prisma");
  const targetPath = path.join(process.cwd(), "prisma", "schema.postgresql.prisma");
  const source = await readFile(sourcePath, "utf8");
  const output = source
    .replace(
      'generator client {\n  provider = "prisma-client-js"\n}',
      'generator client {\n  provider = "prisma-client-js"\n  output   = "../node_modules/@prisma/client-postgresql"\n}',
    )
    .replace('provider = "sqlite"', 'provider = "postgresql"')
    .replace('url      = env("DATABASE_URL")', 'url      = env("POSTGRES_DATABASE_URL")');
  await writeFile(
    targetPath,
    `// 由 scripts/generate-postgres-schema.ts 从本地 SQLite schema 机械生成。\n${output}`,
    "utf8",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "PostgreSQL schema 生成失败");
  process.exit(1);
});
