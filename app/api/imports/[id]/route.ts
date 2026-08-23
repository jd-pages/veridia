import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import {
  deleteImportRecords,
  ImportRecordDeletionError,
} from "@/lib/import-record-deletion";

export const DELETE = withApiErrorBoundary(async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(["ADMIN"]);
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!id.trim()) {
    return fail("导入记录 ID 格式不正确", 400, "INVALID_DELETE_REQUEST");
  }
  try {
    return ok(
      await deleteImportRecords({
        ids: [id.trim()],
        userId: user.id,
        mode: "SINGLE",
      }),
    );
  } catch (error) {
    if (error instanceof ImportRecordDeletionError) {
      return fail(error.message, error.status, error.code);
    }
    throw error;
  }
}, "删除导入记录");
