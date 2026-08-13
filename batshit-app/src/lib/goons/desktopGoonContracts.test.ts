import { describe, expect, it } from "vitest";

import {
  checkDesktopGoonDeltaRate,
  DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
  DESKTOP_GOON_TRANSPORT_POLICY_V1,
  getDesktopGoonDeltaRatePolicy,
  validateDesktopGoonDeltaEnvelopeV1,
  validateDesktopGoonRuntimeSnapshotV1,
  type DesktopGoonDeltaEnvelopeV1,
  type DesktopGoonRateWindowV1,
  type DesktopGoonRuntimeSnapshotV1,
} from "$lib/goons/desktopGoonContracts";
import { createDesktopGoonPresentationState } from "$lib/goons/desktopGoonPresentation";
import { DEFAULT_DESKTOP_GOON_PREFERENCES } from "$lib/goons/resolve";

function snapshot(
  overrides: Partial<DesktopGoonRuntimeSnapshotV1> = {},
): DesktopGoonRuntimeSnapshotV1 {
  return {
    schemaVersion: DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
    epoch: "desktop-window:1",
    sequence: 0,
    createdAtMs: 1,
    presentation: createDesktopGoonPresentationState("dock"),
    sessionId: "session-1",
    activeAgentId: "agent-1",
    activeSpeaker: { agentId: "agent-1", source: "current-agent-fallback" },
    goon: null,
    mountedRuntimeState: null,
    voiceVisual: null,
    camera: null,
    preferences: { ...DEFAULT_DESKTOP_GOON_PREFERENCES },
    ...overrides,
  };
}

function envelope(
  overrides: Partial<DesktopGoonDeltaEnvelopeV1> = {},
): DesktopGoonDeltaEnvelopeV1 {
  return {
    schemaVersion: DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
    epoch: "desktop-window:1",
    sequence: 1,
    sentAtMs: 2,
    delta: {
      type: "speaker.changed",
      activeSpeaker: { agentId: "agent-1", source: "audible-playback" },
    },
    ...overrides,
  };
}

describe("Desktop Goon runtime snapshot v1", () => {
  it("accepts a bounded versioned initial snapshot", () => {
    expect(validateDesktopGoonRuntimeSnapshotV1(snapshot())).toMatchObject({
      ok: true,
    });
  });

  it("rejects schema mismatch and oversized snapshots visibly", () => {
    expect(
      validateDesktopGoonRuntimeSnapshotV1({ ...snapshot(), schemaVersion: 2 }),
    ).toMatchObject({
      ok: false,
      code: "SCHEMA_MISMATCH",
      recovery: "disconnect",
    });
    expect(
      validateDesktopGoonRuntimeSnapshotV1(
        snapshot({
          mountedRuntimeState: {
            payload: "x".repeat(
              DESKTOP_GOON_TRANSPORT_POLICY_V1.maxSnapshotBytes,
            ),
          },
        }),
      ),
    ).toMatchObject({ ok: false, code: "PAYLOAD_TOO_LARGE" });
  });
});

describe("Desktop Goon delta envelope v1", () => {
  it("requires the exact connection epoch and next contiguous sequence", () => {
    expect(
      validateDesktopGoonDeltaEnvelopeV1(envelope(), {
        epoch: "desktop-window:1",
        lastSequence: 0,
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateDesktopGoonDeltaEnvelopeV1(envelope({ sequence: 3 }), {
        epoch: "desktop-window:1",
        lastSequence: 1,
      }),
    ).toMatchObject({
      ok: false,
      code: "SEQUENCE_GAP",
      recovery: "request-snapshot",
    });
    expect(
      validateDesktopGoonDeltaEnvelopeV1(envelope({ epoch: "old-window" }), {
        epoch: "desktop-window:1",
        lastSequence: 0,
      }),
    ).toMatchObject({
      ok: false,
      code: "EPOCH_MISMATCH",
      recovery: "disconnect",
    });
  });

  it("gives replaceable visual frames a smaller payload/rate budget", () => {
    const replaceable = getDesktopGoonDeltaRatePolicy({
      type: "voice.visual",
      visual: {
        kind: "frame",
        generation: "speech-1",
        agentId: null,
        messageId: null,
        atMs: 3,
        elapsedMs: 3,
        frame: null,
        audioLevel: 0.5,
      },
    });
    const critical = getDesktopGoonDeltaRatePolicy({
      type: "snapshot.required",
      reason: "sequence-gap",
    });

    expect(replaceable).toEqual({
      replaceable: true,
      maxBytes: DESKTOP_GOON_TRANSPORT_POLICY_V1.maxReplaceableDeltaBytes,
      maxPerSecond:
        DESKTOP_GOON_TRANSPORT_POLICY_V1.maxReplaceableDeltasPerSecond,
    });
    expect(critical.replaceable).toBe(false);
    expect(critical.maxPerSecond).toBeGreaterThan(replaceable.maxPerSecond);
  });

  it("enforces separate one-second rate windows for replaceable and critical deltas", () => {
    const visual = {
      type: "voice.visual" as const,
      visual: {
        kind: "frame" as const,
        generation: "speech-1",
        agentId: null,
        messageId: null,
        atMs: 3,
        elapsedMs: 3,
        frame: null,
        audioLevel: 0.5,
      },
    };
    let state: DesktopGoonRateWindowV1 | null = null;
    for (
      let index = 0;
      index < DESKTOP_GOON_TRANSPORT_POLICY_V1.maxReplaceableDeltasPerSecond;
      index += 1
    ) {
      const result = checkDesktopGoonDeltaRate(visual, 100, state);
      expect(result.ok).toBe(true);
      state = result.state;
    }
    expect(checkDesktopGoonDeltaRate(visual, 100, state)).toMatchObject({
      ok: false,
      code: "RATE_LIMITED",
    });
    expect(checkDesktopGoonDeltaRate(visual, 1100, state)).toMatchObject({
      ok: true,
    });
  });

  it("never classifies voice lifecycle or alignment as replaceable", () => {
    for (const visual of [
      {
        kind: "start" as const,
        generation: "speech-1",
        agentId: null,
        messageId: null,
        startedAtMs: 1,
        durationMs: null,
        analyzerId: null,
        timeline: null,
      },
      {
        kind: "end" as const,
        generation: "speech-1",
        agentId: null,
        messageId: null,
        endedAtMs: 2,
      },
    ]) {
      expect(
        getDesktopGoonDeltaRatePolicy({ type: "voice.visual", visual })
          .replaceable,
      ).toBe(false);
    }
  });
});
