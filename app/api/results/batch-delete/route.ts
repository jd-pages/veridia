import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import {
  AuditResultDeletionValidationError,
  deleteAuditResults,
  normalizeAuditResultIds,
} from "@/lib/audit-result-deletion";

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const user = await requireApiUser(["ADMIN", "OPERATOR"]);
  if (user instanceof Response) return user;

  const body = await request.json().catch(() => null);
  let ids: string[];
  try {
    ids = normalizeAuditResultIds(
      body && typeof body === "object" && "ids" in body
        ? (body as { ids?: unknown }).ids
        : undefined,
    );
  } catch (error) {
    if (error instanceof AuditResultDeletionValidationError) {
      return fail(error.message, 400, "INVALID_DELETE_REQUEST");
    }
    throw error;
  }

  return ok(await deleteAuditResults({ ids, userId: user.id, mode: "BULK" }));
}, "批量删除审核结果");
