import { describe, expect, it } from "vitest";

import {
  DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
  DESKTOP_GOON_TRANSPORT_POLICY_V1,
  type DesktopGoonDeltaEnvelopeV1,
  type DesktopGoonRuntimeDeltaV1,
  type DesktopGoonRuntimeSnapshotV1,
} from "$lib/goons/desktopGoonContracts";
import { DESKTOP_GOON_CAMERA_SCHEMA_VERSION } from "$lib/goons/desktopGoonCamera";
import { createDesktopGoonPresentationState } from "$lib/goons/desktopGoonPresentation";
import {
  DesktopGoonDesktopStateConsumer,
  DesktopGoonMainStatePublisher,
  type DesktopGoonBridgeFailure,
  type DesktopGoonMessagePortLike,
  type DesktopGoonPortEventListener,
} from "$lib/goons/desktopGoonStateBridge";
import { DEFAULT_DESKTOP_GOON_PREFERENCES } from "$lib/goons/resolve";

class MockPort implements DesktopGoonMessagePortLike {
  peer: MockPort | null = null;
  readonly posted: unknown[] = [];
  readonly removedMessageListeners: DesktopGoonPortEventListener[] = [];
  startCount = 0;
  closeCount = 0;
  private readonly listeners = {
    message: new Set<DesktopGoonPortEventListener>(),
    messageerror: new Set<DesktopGoonPortEventListener>(),
  };

  postMessage(value: unknown): void {
    if (this.closeCount > 0) throw new Error("Mock port is closed.");
    this.posted.push(value);
    this.peer?.emitMessage(value);
  }

  addEventListener(
    type: "message" | "messageerror",
    listener: DesktopGoonPortEventListener,
  ): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(
    type: "message" | "messageerror",
    listener: DesktopGoonPortEventListener,
  ): void {
    this.listeners[type].delete(listener);
    if (type === "message") this.removedMessageListeners.push(listener);
  }

  start(): void {
    this.startCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }

  emitMessage(value: unknown): void {
    for (const listener of [...this.listeners.message])
      listener({ data: value });
  }

  emitMessageError(): void {
    for (const listener of [...this.listeners.messageerror]) listener({});
  }
}

function portPair(): [MockPort, MockPort] {
  const main = new MockPort();
  const desktop = new MockPort();
  main.peer = desktop;
  desktop.peer = main;
  return [main, desktop];
}

function snapshot(
  overrides: Partial<DesktopGoonRuntimeSnapshotV1> = {},
): DesktopGoonRuntimeSnapshotV1 {
  return {
    schemaVersion: DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
    epoch: "desktop-window:1",
    sequence: 0,
    createdAtMs: 1,
    presentation: createDesktopGoonPresentationState("desktop"),
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
  sequence: number,
  delta: DesktopGoonRuntimeDeltaV1,
  epoch = "desktop-window:1",
): DesktopGoonDeltaEnvelopeV1 {
  return {
    schemaVersion: DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
    epoch,
    sequence,
    sentAtMs: sequence + 1,
    delta,
  };
}

function speakerDelta(agentId = "agent-2"): DesktopGoonRuntimeDeltaV1 {
  return {
    type: "speaker.changed",
    activeSpeaker: { agentId, source: "audible-playback" },
  };
}

function voiceFrame(
  index: number,
  generation = "speech-1",
): DesktopGoonRuntimeDeltaV1 {
  return {
    type: "voice.visual",
    visual: {
      kind: "frame",
      generation,
      agentId: "agent-1",
      messageId: "message-1",
      atMs: index,
      elapsedMs: index,
      frame: null,
      audioLevel: Math.min(1, index / 100),
    },
  };
}

function snapshotMessage(value: DesktopGoonRuntimeSnapshotV1) {
  return { messageType: "snapshot" as const, snapshot: value };
}

function deltaMessage(value: DesktopGoonDeltaEnvelopeV1) {
  return { messageType: "delta" as const, envelope: value };
}

describe("Desktop Goon main-side state publisher", () => {
  it("sends exactly one initial snapshot before contiguous deltas", () => {
    const port = new MockPort();
    const publisher = new DesktopGoonMainStatePublisher({
      port,
      now: () => 10,
      onSnapshotRequired: () => null,
    });

    expect(publisher.publishDelta(speakerDelta())).toMatchObject({
      ok: false,
      failure: { code: "INITIAL_SNAPSHOT_REQUIRED" },
    });
    expect(publisher.publishInitialSnapshot(snapshot())).toEqual({
      ok: true,
      status: "sent",
      sequence: 0,
    });
    expect(publisher.publishInitialSnapshot(snapshot())).toMatchObject({
      ok: false,
      failure: { code: "INITIAL_SNAPSHOT_ALREADY_SENT" },
    });
    expect(publisher.publishDelta(speakerDelta("agent-2"))).toEqual({
      ok: true,
      status: "sent",
      sequence: 1,
    });
    expect(publisher.publishDelta(speakerDelta("agent-3"))).toEqual({
      ok: true,
      status: "sent",
      sequence: 2,
    });

    expect(port.posted.map((message: any) => message.messageType)).toEqual([
      "snapshot",
      "delta",
      "delta",
    ]);
    expect(
      port.posted.slice(1).map((message: any) => message.envelope.sequence),
    ).toEqual([1, 2]);
  });

  it("rejects audio ownership, unsafe data, and forbidden camera commands before posting", () => {
    const port = new MockPort();
    const publisher = new DesktopGoonMainStatePublisher({
      port,
      onSnapshotRequired: () => null,
    });
    publisher.publishInitialSnapshot(snapshot());

    const forbiddenVoice = {
      type: "voice.visual",
      visual: {
        kind: "frame",
        generation: "speech-1",
        agentId: null,
        messageId: null,
        atMs: 1,
        elapsedMs: 1,
        frame: null,
        audioLevel: 0.5,
        audio: {},
      },
    } as unknown as DesktopGoonRuntimeDeltaV1;
    const forbiddenCamera = {
      type: "camera.command",
      value: {
        schemaVersion: DESKTOP_GOON_CAMERA_SCHEMA_VERSION,
        kind: "orbit",
        deltaX: 2,
        deltaY: 1,
      },
    } as unknown as DesktopGoonRuntimeDeltaV1;
    const unsafeCue = {
      type: "cue",
      cueId: "cue-1",
      name: "wave",
      payload: { callback: () => "unsafe" },
    } as unknown as DesktopGoonRuntimeDeltaV1;

    expect(publisher.publishDelta(forbiddenVoice)).toMatchObject({
      ok: false,
      failure: {
        code: "INVALID_DELTA",
        message: expect.stringMatching(/cannot carry audio/),
      },
    });
    expect(publisher.publishDelta(forbiddenCamera)).toMatchObject({
      ok: false,
      failure: {
        code: "INVALID_DELTA",
        message: expect.stringMatching(/camera orbit/),
      },
    });
    expect(publisher.publishDelta(unsafeCue)).toMatchObject({
      ok: false,
      failure: {
        code: "INVALID_DELTA",
        message: expect.stringMatching(/clone-safe/),
      },
    });
    expect(port.posted).toHaveLength(1);
  });

  it("coalesces only replaceable visual frames and flushes the newest frame in a new rate window", () => {
    let nowMs = 100;
    const port = new MockPort();
    const publisher = new DesktopGoonMainStatePublisher({
      port,
      now: () => nowMs,
      onSnapshotRequired: () => null,
    });
    publisher.publishInitialSnapshot(snapshot());
    expect(
      publisher.publishDelta({
        type: "voice.visual",
        visual: {
          kind: "start",
          generation: "speech-1",
          agentId: "agent-1",
          messageId: "message-1",
          startedAtMs: 100,
          durationMs: null,
          analyzerId: null,
          timeline: null,
        },
      }),
    ).toMatchObject({ ok: true, status: "sent" });

    for (
      let index = 0;
      index < DESKTOP_GOON_TRANSPORT_POLICY_V1.maxReplaceableDeltasPerSecond;
      index += 1
    ) {
      expect(publisher.publishDelta(voiceFrame(index))).toMatchObject({
        ok: true,
        status: "sent",
      });
    }
    expect(publisher.publishDelta(voiceFrame(75))).toEqual({
      ok: true,
      status: "coalesced",
    });

    nowMs = 1100;
    expect(publisher.flushReplaceable()).toEqual([
      { ok: true, status: "sent", sequence: 32 },
    ]);
    const flushed = port.posted.at(-1) as any;
    expect(flushed.envelope.delta.visual.audioLevel).toBe(0.75);
    expect(
      publisher.publishDelta({
        type: "voice.visual",
        visual: {
          kind: "end",
          generation: "speech-1",
          agentId: "agent-1",
          messageId: "message-1",
          endedAtMs: 1100,
        },
      }),
    ).toMatchObject({ ok: true, status: "sent" });
  });

  it("never coalesces critical deltas and terminates visibly instead of dropping overload", () => {
    const failures: DesktopGoonBridgeFailure[] = [];
    const port = new MockPort();
    const publisher = new DesktopGoonMainStatePublisher({
      port,
      now: () => 100,
      onSnapshotRequired: () => null,
      onTerminal: (value) => failures.push(value),
    });
    publisher.publishInitialSnapshot(snapshot());
    for (
      let index = 0;
      index < DESKTOP_GOON_TRANSPORT_POLICY_V1.maxCriticalDeltasPerSecond;
      index += 1
    ) {
      expect(
        publisher.publishDelta(speakerDelta(`agent-${index}`)),
      ).toMatchObject({
        ok: true,
        status: "sent",
      });
    }
    expect(publisher.publishDelta(speakerDelta("overload"))).toMatchObject({
      ok: false,
      failure: { code: "RATE_LIMITED" },
    });
    expect(failures).toMatchObject([
      { code: "RATE_LIMITED", recoverToDock: true },
    ]);
    expect(port.closeCount).toBe(1);
  });

  it("resets initial-snapshot state and rejects stale handlers when its port is replaced", () => {
    const oldPort = new MockPort();
    const newPort = new MockPort();
    let recoveryRequests = 0;
    const publisher = new DesktopGoonMainStatePublisher({
      port: oldPort,
      onSnapshotRequired: () => {
        recoveryRequests += 1;
        return snapshot({ epoch: "unexpected" });
      },
    });
    publisher.publishInitialSnapshot(snapshot());

    publisher.replacePort(newPort);
    expect(oldPort.closeCount).toBe(1);
    oldPort.removedMessageListeners.at(-1)?.({
      data: {
        messageType: "snapshot-required",
        schemaVersion: DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
        epoch: "desktop-window:1",
        lastSequence: 0,
        reason: "renderer-reload",
      },
    });
    expect(recoveryRequests).toBe(0);
    expect(publisher.publishDelta(speakerDelta())).toMatchObject({
      ok: false,
      failure: { code: "INITIAL_SNAPSHOT_REQUIRED" },
    });
    expect(
      publisher.publishInitialSnapshot(
        snapshot({ epoch: "desktop-window:new" }),
      ),
    ).toMatchObject({ ok: true, status: "sent" });
    expect(newPort.posted).toMatchObject([{ messageType: "snapshot" }]);
  });

});

describe("Desktop Goon desktop-side state consumer", () => {
  it("accepts a valid snapshot followed by contiguous validated deltas", () => {
    const port = new MockPort();
    const snapshots: DesktopGoonRuntimeSnapshotV1[] = [];
    const deltas: DesktopGoonDeltaEnvelopeV1[] = [];
    const consumer = new DesktopGoonDesktopStateConsumer({
      port,
      now: () => 10,
      onSnapshot: (value) => snapshots.push(value),
      onDelta: (value) => deltas.push(value),
      onDisconnected: () => undefined,
      onRecovery: () => undefined,
    });

    port.emitMessage(snapshotMessage(snapshot()));
    port.emitMessage(deltaMessage(envelope(1, speakerDelta())));

    expect(consumer.getState()).toBe("connected");
    expect(snapshots).toHaveLength(1);
    expect(deltas.map((value) => value.sequence)).toEqual([1]);
  });

  it("requests one fresh snapshot on a gap, resets epoch, then disconnects on repeated failure", () => {
    const [mainPort, desktopPort] = portPair();
    const recoveries: DesktopGoonBridgeFailure[] = [];
    const snapshots: DesktopGoonRuntimeSnapshotV1[] = [];
    const publisher = new DesktopGoonMainStatePublisher({
      port: mainPort,
      onSnapshotRequired: (request) =>
        snapshot({
          epoch: "desktop-window:2",
          sequence: 0,
          createdAtMs: 20,
          mountedRuntimeState: { recoveredFrom: request.reason },
        }),
    });
    const consumer = new DesktopGoonDesktopStateConsumer({
      port: desktopPort,
      onSnapshot: (value) => snapshots.push(value),
      onDelta: () => undefined,
      onDisconnected: () => undefined,
      onRecovery: (value) => recoveries.push(value),
    });
    publisher.publishInitialSnapshot(snapshot());

    mainPort.postMessage(deltaMessage(envelope(3, speakerDelta())));
    expect(desktopPort.posted).toMatchObject([
      {
        messageType: "snapshot-required",
        epoch: "desktop-window:1",
        lastSequence: 0,
        reason: "sequence-gap",
      },
    ]);
    expect(consumer.getState()).toBe("connected");
    expect(snapshots.map((value) => value.epoch)).toEqual([
      "desktop-window:1",
      "desktop-window:2",
    ]);

    mainPort.postMessage(
      deltaMessage(envelope(0, speakerDelta(), "desktop-window:2")),
    );
    expect(consumer.getState()).toBe("disconnected");
    expect(recoveries).toMatchObject([
      { code: "SNAPSHOT_RECOVERY_FAILED", recoverToDock: true },
    ]);
  });

  it("uses the same single recovery path for a renderer reload", () => {
    const [mainPort, desktopPort] = portPair();
    const recoveries: DesktopGoonBridgeFailure[] = [];
    let requestCount = 0;
    const publisher = new DesktopGoonMainStatePublisher({
      port: mainPort,
      onSnapshotRequired: () => {
        requestCount += 1;
        return snapshot({ epoch: "desktop-window:reload", sequence: 0 });
      },
    });
    const consumer = new DesktopGoonDesktopStateConsumer({
      port: desktopPort,
      onSnapshot: () => undefined,
      onDelta: () => undefined,
      onDisconnected: () => undefined,
      onRecovery: (value) => recoveries.push(value),
    });
    publisher.publishInitialSnapshot(snapshot());

    consumer.requestSnapshot("renderer-reload");
    expect(requestCount).toBe(1);
    expect(consumer.getState()).toBe("connected");
    expect(desktopPort.posted).toMatchObject([{ reason: "renderer-reload" }]);

    consumer.requestSnapshot("renderer-reload");
    expect(consumer.getState()).toBe("disconnected");
    expect(recoveries).toHaveLength(1);
  });

  it("enforces the receiver rate policy independently", () => {
    const port = new MockPort();
    const failures: DesktopGoonBridgeFailure[] = [];
    const consumer = new DesktopGoonDesktopStateConsumer({
      port,
      now: () => 100,
      onSnapshot: () => undefined,
      onDelta: () => undefined,
      onDisconnected: (value) => failures.push(value),
      onRecovery: () => undefined,
    });
    port.emitMessage(snapshotMessage(snapshot()));
    for (
      let index = 0;
      index <= DESKTOP_GOON_TRANSPORT_POLICY_V1.maxReplaceableDeltasPerSecond;
      index += 1
    ) {
      port.emitMessage(deltaMessage(envelope(index + 1, voiceFrame(index))));
    }

    expect(consumer.getState()).toBe("disconnected");
    expect(failures).toMatchObject([{ code: "RATE_LIMITED" }]);
  });

  it("rejects clone-safe but forbidden audio ownership and camera commands", () => {
    for (const unsafeDelta of [
      {
        type: "voice.visual",
        visual: {
          kind: "frame",
          generation: "speech-1",
          agentId: null,
          messageId: null,
          atMs: 1,
          elapsedMs: 1,
          frame: null,
          audioLevel: 0.5,
          audio: {},
        },
      },
      {
        type: "camera.command",
        value: {
          schemaVersion: DESKTOP_GOON_CAMERA_SCHEMA_VERSION,
          kind: "orbit",
          deltaX: 1,
          deltaY: 1,
        },
      },
    ]) {
      const port = new MockPort();
      const failures: DesktopGoonBridgeFailure[] = [];
      const consumer = new DesktopGoonDesktopStateConsumer({
        port,
        onSnapshot: () => undefined,
        onDelta: () => undefined,
        onDisconnected: (value) => failures.push(value),
        onRecovery: () => undefined,
      });
      port.emitMessage(snapshotMessage(snapshot()));
      port.emitMessage(
        deltaMessage(
          envelope(1, unsafeDelta as unknown as DesktopGoonRuntimeDeltaV1),
        ),
      );
      expect(consumer.getState()).toBe("disconnected");
      expect(failures).toMatchObject([{ code: "INVALID_DELTA" }]);
    }
  });

  it("closes replaced ports and ignores stale old-port handlers deterministically", () => {
    const oldPort = new MockPort();
    const newPort = new MockPort();
    const snapshots: string[] = [];
    const deltas: number[] = [];
    const consumer = new DesktopGoonDesktopStateConsumer({
      port: oldPort,
      onSnapshot: (value) => snapshots.push(value.epoch),
      onDelta: (value) => deltas.push(value.sequence),
      onDisconnected: () => undefined,
      onRecovery: () => undefined,
    });
    oldPort.emitMessage(snapshotMessage(snapshot()));

    consumer.replacePort(newPort);
    expect(oldPort.closeCount).toBe(1);
    expect(consumer.getState()).toBe("awaiting-snapshot");
    oldPort.removedMessageListeners.at(-1)?.({
      data: deltaMessage(envelope(1, speakerDelta())),
    });
    expect(deltas).toEqual([]);
    expect(consumer.getState()).toBe("awaiting-snapshot");

    newPort.emitMessage(
      snapshotMessage(snapshot({ epoch: "desktop-window:new" })),
    );
    expect(consumer.getState()).toBe("connected");
    expect(snapshots).toEqual(["desktop-window:1", "desktop-window:new"]);
  });

  it("cleans up message-error handlers and invokes visible recovery without retry timers", () => {
    const port = new MockPort();
    const failures: DesktopGoonBridgeFailure[] = [];
    const consumer = new DesktopGoonDesktopStateConsumer({
      port,
      onSnapshot: () => undefined,
      onDelta: () => undefined,
      onDisconnected: (value) => failures.push(value),
      onRecovery: (value) => failures.push(value),
    });

    port.emitMessageError();
    expect(consumer.getState()).toBe("disconnected");
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({
      code: "PORT_ERROR",
      recoverToDock: true,
    });
    expect(port.closeCount).toBe(1);
  });
});
