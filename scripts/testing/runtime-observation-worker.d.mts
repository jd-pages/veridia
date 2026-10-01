import type { EventEmitter } from "node:events";
import type { PersistentRuntimeProvider } from "./runtime-observation-provider-client.mjs";
export function startRuntimeObservationWorker(input: { parent: EventEmitter & { postMessage(message: Record<string, unknown>): void; close(): void };
  data: Record<string, unknown>; workerThreadId?: number; createProvider?: (input: Record<string, unknown>) => PersistentRuntimeProvider;
  now?: () => number; timeOrigin?: number }): { provider: PersistentRuntimeProvider; snapshot(): { sequence: number; stopping: boolean; failure: string | null } };
