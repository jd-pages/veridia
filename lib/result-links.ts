export interface ResultLinkSource {
  task: {
    url: string;
    finalUrl?: string | null;
  };
  note: {
    url: string;
    finalUrl?: string | null;
  };
}

export function resultDetailLinks(result: ResultLinkSource) {
  return {
    originalUrl: result.task.url,
    finalUrl: result.task.finalUrl || result.note.finalUrl || result.note.url,
  };
}
