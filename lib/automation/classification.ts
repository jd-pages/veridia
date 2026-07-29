import type { ExtractedNote } from "@/lib/types";
import type { AutomaticFailureCode } from "./failure";

export function failureCodeForPageStatus(
  status: ExtractedNote["pageStatus"],
) {
  const statusMap: Partial<
    Record<ExtractedNote["pageStatus"], AutomaticFailureCode>
  > = {
    NOT_FOUND: "PAGE_NOT_FOUND",
    DELETED: "NOTE_DELETED",
    NO_PERMISSION: "NO_PERMISSION",
    LOGIN_EXPIRED: "LOGIN_REQUIRED",
    SECURITY_VERIFICATION: "SECURITY_CHECK",
    READ_FAILED: "PAGE_READ_FAILED",
  };
  return statusMap[status] || null;
}

export function detectContentWarnings(note: ExtractedNote) {
  const warnings: AutomaticFailureCode[] = [];
  if (!note.body?.trim()) warnings.push("BODY_NOT_RECOGNIZED");
  if (note.topics.length === 0) warnings.push("TOPICS_NOT_RECOGNIZED");
  return warnings;
}
