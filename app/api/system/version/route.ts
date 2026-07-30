import packageJson from "@/package.json";
import { ok, requireApiUser } from "@/lib/api";

export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  return ok({
    version: process.env.VERIDIA_APP_VERSION || packageJson.version,
    buildDate: process.env.VERIDIA_BUILD_DATE || null,
    databaseVersion: process.env.VERIDIA_DATABASE_VERSION || "开发数据库",
    dataDirectory: process.env.VERIDIA_DATA_DIR || "项目本地数据库",
    autoUpdate: false,
    packaged: process.env.VERIDIA_DESKTOP === "true",
  });
}
