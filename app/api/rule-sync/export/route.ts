import JSZip from "jszip";
import { requireApiUser } from "@/lib/api";
import { exportCurrentRulePayload } from "@/lib/rules/package";
import { SYSTEM_ADMIN_ROLES } from "@/lib/permissions";

export async function GET() {
  const user = await requireApiUser(SYSTEM_ADMIN_ROLES);
  if (user instanceof Response) return user;
  const payload = await exportCurrentRulePayload();
  const zip = new JSZip();
  zip.file("rules.json", JSON.stringify(payload, null, 2));
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename=\"veridia-rules-${payload.ruleVersion}.zip\"`,
      "Cache-Control": "no-store",
    },
  });
}
