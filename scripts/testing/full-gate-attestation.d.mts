export interface FullGateValidation {
  valid: boolean;
  reasons: string[];
  attestation?: Record<string, unknown>;
  current?: Record<string, unknown>;
}

export const ATTESTATION_SCHEMA_VERSION: number;
export const ATTESTATION_RELATIVE_PATH: string;
export function collectAttestationState(root?: string): Record<string, unknown>;
export function attestationPath(root?: string): string;
export function invalidateFullGateAttestation(root?: string): void;
export function writeFullGateAttestation(results: Record<string, unknown>, root?: string): Record<string, unknown>;
export function validateFullGateAttestation(root?: string): FullGateValidation;
export function printValidation(validation: FullGateValidation): void;
