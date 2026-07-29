import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireApiUser } from "@/lib/api";

export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const file = await readFile(path.join(process.cwd(), "templates", "笔记导入模板.xlsx"));
  return new Response(file, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition":
        "attachment; filename*=UTF-8''%E7%AC%94%E8%AE%B0%E5%AF%BC%E5%85%A5%E6%A8%A1%E6%9D%BF.xlsx",
    },
  });
}
