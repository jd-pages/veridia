import "dotenv/config";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

async function main() {
  const databaseUrl = process.env.DATABASE_URL || "file:./dev.db";
  if (!databaseUrl.startsWith("file:")) return;
  const rawPath = databaseUrl.slice("file:".length).split("?")[0];
  const resolved = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(process.cwd(), "prisma", rawPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const handle = await open(resolved, "a");
  await handle.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "SQLite 初始化失败");
  process.exit(1);
});
