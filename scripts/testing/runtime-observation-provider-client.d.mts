import type { EventEmitter } from "node:events";
export interface NativeIdentityFailure { code: string; operation: string; win32Error: number | null; ntStatus: number | null; }
export interface BirthGuardFailure { branch: "NON_POSITIVE_BIRTH" | "AFTER_PRECISE_UTC_BOUND";
  pid: number; parentPid: number; creationSigned: string; utcBirthUpperBound: string;
  clockSource: "GET_SYSTEM_TIME_PRECISE_AS_FILE_TIME"; }
export interface NativeSnapshotProcess { pid: number; parentPid: number; name: string; createdAt: string;
  nativeBirthStamp: string; nativeIdentityStatus: "SNAPSHOT_ONLY_BIRTH_PARENT_NAME_OBSERVATION";
  parentIdentityProof: "SPI_SNAPSHOT_BIRTH_PARENT_NAME_OBSERVATION_ONLY"; liveAtCaptureEnd: null;
  ownershipAuthority: false; workingSetBytes?: number | null; }
export interface NativeIdleProcess { pid: 0; parentPid: 0; name: null; createdAt: null; nativeBirthStamp: null;
  nativeIdentityStatus: "SPI_IDLE_SENTINEL_NO_AUTHORITY"; parentIdentityProof: "SPI_SNAPSHOT_BIRTH_PARENT_NAME_OBSERVATION_ONLY";
  liveAtCaptureEnd: null; ownershipAuthority: false; workingSetBytes?: number | null; }
export type NativeRuntimeProcess = NativeSnapshotProcess | NativeIdleProcess;
export interface NativeHeldComparison { pid: number; parentPid: number; name: string; createdAt: string; nativeBirthStamp: string;
  nativeWaitResultBefore: 258; nativeWaitResultAfter: 258; sameHandleLiveAtBothBoundaries: true; snapshotMatchesHeld: true; }
export interface SpiCoverage { osBuild: 26100 | 26200; architecture: "AMD64";
  layoutProfile: "SPI_X64_PREFIX256_THREAD80_CREATE32_IMAGE56_PID80_PARENT88"; queryStatus: 0; returnLength: number;
  bufferCapacity: 8388608; inventoryComplete: true; snapshotCompletedUtcFileTime: string;
  clockSource: "GET_SYSTEM_TIME_PRECISE_AS_FILE_TIME"; }
export interface NativeRuntimeSnapshot { processes: NativeRuntimeProcess[]; ports: { pid: number; port: number; state: string; family: string }[];
  nativeProvider: "SPI_SNAPSHOT_HELD_ROOTS_IPHELPER_WMI_FREE"; providerElapsedMs: number; tcpFamiliesComplete: string[];
  heldComparisons: NativeHeldComparison[]; spiCoverage: SpiCoverage; publicAbiGuarantee: "NOT_GUARANTEED"; }
export interface ProviderObservation { status: "PASSED" | "FAILED" | "NOT_COMPLETE"; state: string; firstFailure: string | null;
  runId: string; observerId: string; port: number; wrapperPid: number; wrapperCreatedAt: string;
  providerPid: number | null; providerParentPid: number | null; providerNativeBirthStamp: string | null; providerCreatedAt: string | null;
  wrapperNativeBirthStamp: string | null;
  startedMs: number; startupDeadlineMs: number; stopDeadlineMs: number | null; sequence: number; inFlightSequence: number | null;
  eofSent: boolean; eofAcknowledged: boolean; stdoutEnded: boolean; exitObserved: boolean; closeObserved: boolean;
  exitCode: number | null; closeCode: number | null; joined: boolean; stderrBytes: number; receipts: Record<string, unknown>[]; }
export interface ProviderChild extends EventEmitter { pid?: number; stdin: EventEmitter & { write(value: string): unknown; end(): unknown };
  stdout: EventEmitter; stderr: EventEmitter; }
export interface PersistentRuntimeProvider { ready: Promise<ProviderObservation>; closed: Promise<void>; snapshot(): ProviderObservation;
  query(input: { deadlineMs: number }): Promise<NativeRuntimeSnapshot>; stop(deadlineMs: number): Promise<ProviderObservation>; }
export interface WrapperIdentity { pid: number; createdAt: string; }
export function createPersistentRuntimeProvider(input: { runId: string; observerId: string; port: number; wrapperIdentity: WrapperIdentity;
  startupDeadlineMs?: number; spawnImpl?: (command: string, args: string[], options: { windowsHide: boolean; stdio: string[] }) => ProviderChild;
  now?: () => number; setTimer?: (callback: () => void, delay: number) => unknown; clearTimer?: (timer: unknown) => void }): PersistentRuntimeProvider;
export function validateNativeRuntimeSnapshot(runtime: unknown, input: { port: number; wrapperIdentity: WrapperIdentity;
  providerIdentity: { providerPid: number | null; providerNativeBirthStamp: string | null; providerCreatedAt: string | null;
    wrapperNativeBirthStamp: string | null } }): NativeRuntimeSnapshot;
export function validateNativeProviderReceipt(receipt: unknown, input: { runId: string; observerId: string; port: number; wrapperIdentity: WrapperIdentity;
  providerIdentity?: ProviderObservation; sequence?: number; receivedMs: number; stopRequestedMs?: number; stopDeadlineMs?: number; terminal?: boolean }): ProviderObservation;
export function safeNativeFailureCategory(value: unknown): string;
export function validateNativeIdentityFailure(value: unknown): NativeIdentityFailure;
