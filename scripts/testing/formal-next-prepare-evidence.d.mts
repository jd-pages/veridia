export interface FormalPrepareContext { root: string; head: string; sourceFingerprint: string; startedAt: string; now: string; }
export function validateFormalNextPrepareReceipt(receipt: unknown, context: FormalPrepareContext): Record<string, unknown>;
export function readFormalNextPrepareEvidence(output: string, context: FormalPrepareContext): Record<string, unknown>;
