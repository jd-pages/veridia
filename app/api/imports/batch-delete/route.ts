import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import {
  deleteImportRecords,
  ImportRecordDeletionError,
  normalizeImportRecordIds,
} from "@/lib/import-record-deletion";

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  const body = await request.json().catch(() => null);
  try {
    const ids = normalizeImportRecordIds(
      body && typeof body === "object" && "ids" in body
        ? (body as { ids?: unknown }).ids
        : undefined,
    );
    return ok(
      await deleteImportRecords({
        ids,
        userId: user.id,
        mode: "BULK",
      }),
    );
  } catch (error) {
    if (error instanceof ImportRecordDeletionError) {
      return fail(error.message, error.status, error.code);
    }
    throw error;
  }
}, "批量删除导入记录");
