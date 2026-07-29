import path from "node:path";
import { readFile } from "node:fs/promises";
import { requireApiUser } from "@/lib/api";

export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const file = await readFile(
    path.join(process.cwd(), "templates", "活动规则标准导入模板.xlsx"),
  );
  return new Response(file, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition":
        "attachment; filename*=UTF-8''%E6%B4%BB%E5%8A%A8%E8%A7%84%E5%88%99%E6%A0%87%E5%87%86%E5%AF%BC%E5%85%A5%E6%A8%A1%E6%9D%BF.xlsx",
      "Cache-Control": "no-store",
    },
  });
}
