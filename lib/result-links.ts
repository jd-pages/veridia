export interface ResultLinkSource {
  task: {
    url?: string | null;
    originalInput?: string | null;
    normalizedUrl?: string | null;
    finalUrl?: string | null;
  };
  note: {
    url?: string | null;
    finalUrl?: string | null;
  };
}

function firstLink(...values: Array<string | null | undefined>) {
  return values
    .map((value) => value?.trim() || "")
    .find(Boolean) || "";
}

/**
 * The audit task URL is the extracted URL supplied by the user and remains the
 * traceability source even when navigation later resolves to a 404 URL. Older
 * rows can fall back to the related note/canonical evidence without a data
 * backfill.
 */
export function resolveResultOriginalLink(result: ResultLinkSource) {
  return firstLink(
    result.task.url,
    result.note.url,
    result.task.normalizedUrl,
    result.task.finalUrl,
    result.note.finalUrl,
  );
}

export function resolveResultFinalLink(result: ResultLinkSource) {
  return firstLink(
    result.task.finalUrl,
    result.note.finalUrl,
    result.note.url,
    result.task.normalizedUrl,
  );
}

export function resultDetailLinks(result: ResultLinkSource) {
  return {
    originalUrl: resolveResultOriginalLink(result),
    finalUrl: resolveResultFinalLink(result),
  };
}
