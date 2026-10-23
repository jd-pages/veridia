import { ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import { enqueueDueResultFollowUp } from "@/lib/automation/result-follow-up";
import { kickAutomaticAuditQueue } from "@/lib/automation/queue";

/** One bounded scan. Queue ownership/pacing/login/physical-close gates remain
 * the same as normal audit; no direct platform requests in the scanner. */
export const POST = withApiErrorBoundary(async function POST() {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const result = await enqueueDueResultFollowUp(user.id);
  if (result.status === "QUEUED") kickAutomaticAuditQueue();
  return ok(result);
}, "自动补采及到期复核");
