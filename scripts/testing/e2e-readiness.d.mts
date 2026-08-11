export interface StartupRouteResponse {
  status: number | (() => number);
  ok: boolean | (() => boolean);
}

export interface StartupRouteReadyResult<T extends StartupRouteResponse> {
  response: T;
  attempts: number;
  elapsedMs: number;
}

export function waitForStartupRoute<T extends StartupRouteResponse>(input: {
  label: string;
  request: () => Promise<T | null>;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<StartupRouteReadyResult<T>>;
