import type { DesktopGoonActiveSpeaker } from "$lib/goons/desktopGoonActiveSpeaker";
import type {
  DesktopGoonCameraCommandV1,
  DesktopGoonCameraStateV1,
} from "$lib/goons/desktopGoonCamera";
import type { DesktopGoonPresentationState } from "$lib/goons/desktopGoonPresentation";
import type { DesktopGoonVoiceVisualProjection } from "$lib/goons/desktopGoonVoiceProjection";
import type { DesktopGoonPreferences } from "$lib/types/goons";

export const DESKTOP_GOON_RUNTIME_SCHEMA_VERSION = 1 as const;

export const DESKTOP_GOON_TRANSPORT_POLICY_V1 = Object.freeze({
  schemaVersion: DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
  maxEpochChars: 128,
  maxSnapshotBytes: 512 * 1024,
  maxDeltaBytes: 128 * 1024,
  maxReplaceableDeltaBytes: 32 * 1024,
  maxCriticalDeltasPerSecond: 120,
  maxReplaceableDeltasPerSecond: 30,
  strictContiguousSequences: true,
  firstDeltaSequence: 1,
});

export type DesktopGoonJsonValue =
  | null
  | boolean
  | number
  | string
  | DesktopGoonJsonValue[]
  | { [key: string]: DesktopGoonJsonValue };

export type DesktopGoonRuntimeGoonRefV1 = {
  goonId: string;
  activationKey: string;
  recordUpdatedAt: string;
  packageRevision: string | null;
};

export type DesktopGoonRuntimeSnapshotV1 = {
  schemaVersion: typeof DESKTOP_GOON_RUNTIME_SCHEMA_VERSION;
  epoch: string;
  sequence: number;
  createdAtMs: number;
  presentation: DesktopGoonPresentationState;
  sessionId: string | null;
  activeAgentId: string | null;
  activeSpeaker: DesktopGoonActiveSpeaker | null;
  goon: DesktopGoonRuntimeGoonRefV1 | null;
  mountedRuntimeState: { [key: string]: DesktopGoonJsonValue } | null;
  voiceVisual: DesktopGoonVoiceVisualProjection | null;
  camera: DesktopGoonCameraStateV1 | null;
  preferences: DesktopGoonPreferences;
};

export type DesktopGoonRuntimeDeltaV1 =
  | { type: "presentation.changed"; presentation: DesktopGoonPresentationState }
  | {
      type: "session-agent.changed";
      sessionId: string | null;
      activeAgentId: string | null;
    }
  | { type: "speaker.changed"; activeSpeaker: DesktopGoonActiveSpeaker | null }
  | { type: "goon.invalidated"; goon: DesktopGoonRuntimeGoonRefV1 | null }
  | { type: "voice.visual"; visual: DesktopGoonVoiceVisualProjection }
  | {
      type: "cue";
      cueId: string;
      name: string;
      payload: { [key: string]: DesktopGoonJsonValue };
    }
  | { type: "settings.changed"; preferences: DesktopGoonPreferences }
  | { type: "camera.command"; value: DesktopGoonCameraCommandV1 }
  | { type: "camera.state"; camera: DesktopGoonCameraStateV1 }
  | {
      type: "snapshot.required";
      reason: "sequence-gap" | "renderer-reload" | "wake" | "manual";
    }
  | {
      type: "terminal.error";
      code: string;
      message: string;
      recoverToDock: boolean;
    };

export type DesktopGoonDeltaEnvelopeV1 = {
  schemaVersion: typeof DESKTOP_GOON_RUNTIME_SCHEMA_VERSION;
  epoch: string;
  sequence: number;
  sentAtMs: number;
  delta: DesktopGoonRuntimeDeltaV1;
};

export type DesktopGoonContractValidationResult =
  | { ok: true; sizeBytes: number }
  | {
      ok: false;
      code:
        | "SCHEMA_MISMATCH"
        | "EPOCH_INVALID"
        | "EPOCH_MISMATCH"
        | "SEQUENCE_INVALID"
        | "SEQUENCE_STALE"
        | "SEQUENCE_GAP"
        | "PAYLOAD_INVALID"
        | "PAYLOAD_TOO_LARGE";
      recovery: "reject" | "request-snapshot" | "disconnect";
      message: string;
    };

export type DesktopGoonRateWindowV1 = {
  startedAtMs: number;
  criticalCount: number;
  replaceableCount: number;
};

export type DesktopGoonRateCheckResult =
  | { ok: true; state: DesktopGoonRateWindowV1 }
  | {
      ok: false;
      state: DesktopGoonRateWindowV1;
      code: "RATE_LIMITED";
      message: string;
    };

const DELTA_TYPES = new Set<DesktopGoonRuntimeDeltaV1["type"]>([
  "presentation.changed",
  "session-agent.changed",
  "speaker.changed",
  "goon.invalidated",
  "voice.visual",
  "cue",
  "settings.changed",
  "camera.command",
  "camera.state",
  "snapshot.required",
  "terminal.error",
]);

function isPlainSerializable(
  value: unknown,
  seen = new Set<object>(),
): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value))
    return value.every((entry) => isPlainSerializable(entry, seen));
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return false;
  }
  return Object.values(value).every((entry) =>
    isPlainSerializable(entry, seen),
  );
}

function payloadBytes(value: unknown): number | null {
  if (!isPlainSerializable(value)) return null;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

function validEpoch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= DESKTOP_GOON_TRANSPORT_POLICY_V1.maxEpochChars &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function validSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validPresentationState(
  value: unknown,
): value is DesktopGoonPresentationState {
  if (!value || typeof value !== "object") return false;
  const mode = (value as DesktopGoonPresentationState).mode;
  return mode === "dock" || mode === "immersive" || mode === "desktop";
}

function validPreferences(value: unknown): value is DesktopGoonPreferences {
  if (!value || typeof value !== "object") return false;
  const preferences = value as DesktopGoonPreferences;
  return (
    typeof preferences.fullHeight === "boolean" &&
    typeof preferences.normalizedWidth === "number" &&
    Number.isFinite(preferences.normalizedWidth) &&
    preferences.normalizedWidth >= 0.1 &&
    preferences.normalizedWidth <= 1 &&
    typeof preferences.stayOnTop === "boolean" &&
    typeof preferences.clickThrough === "boolean" &&
    typeof preferences.controlsShortcut === "string" &&
    preferences.controlsShortcut.length > 0 &&
    preferences.controlsShortcut.length <= 128 &&
    (preferences.workspace === "current-workspace" ||
      preferences.workspace === "all-workspaces")
  );
}

export function isDesktopGoonReplaceableDelta(
  delta: DesktopGoonRuntimeDeltaV1,
): boolean {
  return (
    delta.type === "camera.state" ||
    (delta.type === "voice.visual" && delta.visual.kind === "frame")
  );
}

export function getDesktopGoonDeltaRatePolicy(
  delta: DesktopGoonRuntimeDeltaV1,
) {
  const replaceable = isDesktopGoonReplaceableDelta(delta);
  return {
    replaceable,
    maxBytes: replaceable
      ? DESKTOP_GOON_TRANSPORT_POLICY_V1.maxReplaceableDeltaBytes
      : DESKTOP_GOON_TRANSPORT_POLICY_V1.maxDeltaBytes,
    maxPerSecond: replaceable
      ? DESKTOP_GOON_TRANSPORT_POLICY_V1.maxReplaceableDeltasPerSecond
      : DESKTOP_GOON_TRANSPORT_POLICY_V1.maxCriticalDeltasPerSecond,
  };
}

export function checkDesktopGoonDeltaRate(
  delta: DesktopGoonRuntimeDeltaV1,
  nowMs: number,
  previous?: DesktopGoonRateWindowV1 | null,
): DesktopGoonRateCheckResult {
  const reset =
    !previous ||
    !Number.isFinite(previous.startedAtMs) ||
    nowMs < previous.startedAtMs ||
    nowMs - previous.startedAtMs >= 1000;
  const state: DesktopGoonRateWindowV1 = reset
    ? { startedAtMs: nowMs, criticalCount: 0, replaceableCount: 0 }
    : { ...previous };
  const policy = getDesktopGoonDeltaRatePolicy(delta);
  const key = policy.replaceable ? "replaceableCount" : "criticalCount";
  if (state[key] >= policy.maxPerSecond) {
    return {
      ok: false,
      state,
      code: "RATE_LIMITED",
      message: `Desktop Goon ${policy.replaceable ? "replaceable" : "critical"} delta rate exceeded.`,
    };
  }
  state[key] += 1;
  return { ok: true, state };
}

export function validateDesktopGoonRuntimeSnapshotV1(
  value: unknown,
): DesktopGoonContractValidationResult {
  if (!value || typeof value !== "object") {
    return {
      ok: false,
      code: "PAYLOAD_INVALID",
      recovery: "disconnect",
      message: "Desktop Goon snapshot must be an object.",
    };
  }
  const snapshot = value as Partial<DesktopGoonRuntimeSnapshotV1>;
  if (snapshot.schemaVersion !== DESKTOP_GOON_RUNTIME_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "SCHEMA_MISMATCH",
      recovery: "disconnect",
      message: "Desktop Goon snapshot schema is not supported.",
    };
  }
  if (!validEpoch(snapshot.epoch)) {
    return {
      ok: false,
      code: "EPOCH_INVALID",
      recovery: "disconnect",
      message: "Desktop Goon snapshot epoch is invalid.",
    };
  }
  if (!validSequence(snapshot.sequence)) {
    return {
      ok: false,
      code: "SEQUENCE_INVALID",
      recovery: "disconnect",
      message: "Desktop Goon snapshot sequence is invalid.",
    };
  }
  if (
    typeof snapshot.createdAtMs !== "number" ||
    !Number.isFinite(snapshot.createdAtMs) ||
    snapshot.createdAtMs < 0 ||
    !validPresentationState(snapshot.presentation) ||
    !validPreferences(snapshot.preferences)
  ) {
    return {
      ok: false,
      code: "PAYLOAD_INVALID",
      recovery: "disconnect",
      message: "Desktop Goon snapshot is missing required v1 state.",
    };
  }
  const sizeBytes = payloadBytes(value);
  if (sizeBytes === null) {
    return {
      ok: false,
      code: "PAYLOAD_INVALID",
      recovery: "disconnect",
      message: "Desktop Goon snapshot is not finite plain structured data.",
    };
  }
  if (sizeBytes > DESKTOP_GOON_TRANSPORT_POLICY_V1.maxSnapshotBytes) {
    return {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      recovery: "disconnect",
      message: "Desktop Goon snapshot exceeds the transport size limit.",
    };
  }
  return { ok: true, sizeBytes };
}

export function validateDesktopGoonDeltaEnvelopeV1(
  value: unknown,
  expected: { epoch: string; lastSequence: number },
): DesktopGoonContractValidationResult {
  if (!value || typeof value !== "object") {
    return {
      ok: false,
      code: "PAYLOAD_INVALID",
      recovery: "disconnect",
      message: "Desktop Goon delta envelope must be an object.",
    };
  }
  const envelope = value as Partial<DesktopGoonDeltaEnvelopeV1>;
  if (envelope.schemaVersion !== DESKTOP_GOON_RUNTIME_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "SCHEMA_MISMATCH",
      recovery: "disconnect",
      message: "Desktop Goon delta schema is not supported.",
    };
  }
  if (!validEpoch(envelope.epoch)) {
    return {
      ok: false,
      code: "EPOCH_INVALID",
      recovery: "disconnect",
      message: "Desktop Goon delta epoch is invalid.",
    };
  }
  if (envelope.epoch !== expected.epoch) {
    return {
      ok: false,
      code: "EPOCH_MISMATCH",
      recovery: "disconnect",
      message: "Desktop Goon delta belongs to a stale connection epoch.",
    };
  }
  if (!validSequence(envelope.sequence)) {
    return {
      ok: false,
      code: "SEQUENCE_INVALID",
      recovery: "disconnect",
      message: "Desktop Goon delta sequence is invalid.",
    };
  }
  const nextSequence = expected.lastSequence + 1;
  if (envelope.sequence < nextSequence) {
    return {
      ok: false,
      code: "SEQUENCE_STALE",
      recovery: "reject",
      message: "Desktop Goon delta sequence is stale.",
    };
  }
  if (envelope.sequence > nextSequence) {
    return {
      ok: false,
      code: "SEQUENCE_GAP",
      recovery: "request-snapshot",
      message:
        "Desktop Goon delta sequence has a gap; a fresh snapshot is required.",
    };
  }
  if (
    typeof envelope.sentAtMs !== "number" ||
    !Number.isFinite(envelope.sentAtMs) ||
    envelope.sentAtMs < 0 ||
    !envelope.delta ||
    typeof envelope.delta.type !== "string" ||
    !DELTA_TYPES.has(envelope.delta.type as DesktopGoonRuntimeDeltaV1["type"])
  ) {
    return {
      ok: false,
      code: "PAYLOAD_INVALID",
      recovery: "disconnect",
      message: "Desktop Goon delta payload is invalid.",
    };
  }
  const sizeBytes = payloadBytes(value);
  if (sizeBytes === null) {
    return {
      ok: false,
      code: "PAYLOAD_INVALID",
      recovery: "disconnect",
      message: "Desktop Goon delta is not finite plain structured data.",
    };
  }
  const ratePolicy = getDesktopGoonDeltaRatePolicy(
    envelope.delta as DesktopGoonRuntimeDeltaV1,
  );
  if (sizeBytes > ratePolicy.maxBytes) {
    return {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      recovery: "disconnect",
      message: "Desktop Goon delta exceeds its transport size limit.",
    };
  }
  return { ok: true, sizeBytes };
}
