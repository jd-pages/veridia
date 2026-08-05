import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  AutomaticBatchClearError,
  clearAutomaticBatchFromTaskView,
} from "@/lib/automation/batch-clear";

export const POST = withApiErrorBoundary(async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    return ok(
      await clearAutomaticBatchFromTaskView({
        batchId: id,
        userId: user.id,
        role: user.role,
      }),
    );
  } catch (error) {
    if (error instanceof AutomaticBatchClearError) {
      return fail(error.message, error.status, error.code);
    }
    throw error;
  }
}, "清除自动审核批次");
