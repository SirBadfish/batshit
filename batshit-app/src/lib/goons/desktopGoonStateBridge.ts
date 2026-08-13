import {
  DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
  DESKTOP_GOON_TRANSPORT_POLICY_V1,
  checkDesktopGoonDeltaRate,
  isDesktopGoonReplaceableDelta,
  validateDesktopGoonDeltaEnvelopeV1,
  validateDesktopGoonRuntimeSnapshotV1,
  type DesktopGoonDeltaEnvelopeV1,
  type DesktopGoonRateWindowV1,
  type DesktopGoonRuntimeDeltaV1,
  type DesktopGoonRuntimeSnapshotV1,
} from "$lib/goons/desktopGoonContracts";
import {
  parseDesktopGoonCameraCommandV1,
  parseDesktopGoonCameraStateV1,
} from "$lib/goons/desktopGoonCamera";
import { projectDesktopGoonVoiceVisual } from "$lib/goons/desktopGoonVoiceProjection";

export type DesktopGoonPortEvent = { data?: unknown };
export type DesktopGoonPortEventType = "message" | "messageerror";
export type DesktopGoonPortEventListener = (
  event: DesktopGoonPortEvent,
) => void;

export interface DesktopGoonMessagePortLike {
  postMessage(value: unknown): void;
  addEventListener(
    type: DesktopGoonPortEventType,
    listener: DesktopGoonPortEventListener,
  ): void;
  removeEventListener(
    type: DesktopGoonPortEventType,
    listener: DesktopGoonPortEventListener,
  ): void;
  start?(): void;
  close(): void;
}

export type DesktopGoonSnapshotRequestReason =
  "sequence-gap" | "stale-sequence" | "renderer-reload";

export type DesktopGoonSnapshotRequiredRequestV1 = {
  messageType: "snapshot-required";
  schemaVersion: typeof DESKTOP_GOON_RUNTIME_SCHEMA_VERSION;
  epoch: string | null;
  lastSequence: number;
  reason: DesktopGoonSnapshotRequestReason;
};

export type DesktopGoonBridgeFailureCode =
  | "BRIDGE_CLOSED"
  | "INITIAL_SNAPSHOT_REQUIRED"
  | "INITIAL_SNAPSHOT_ALREADY_SENT"
  | "INVALID_SNAPSHOT"
  | "INVALID_DELTA"
  | "RATE_LIMITED"
  | "PORT_ERROR"
  | "SNAPSHOT_RECOVERY_FAILED"
  | "UNEXPECTED_MESSAGE";

export type DesktopGoonBridgeFailure = {
  code: DesktopGoonBridgeFailureCode;
  message: string;
  recoverToDock: true;
};

export type DesktopGoonMainToDesktopMessageV1 =
  | { messageType: "snapshot"; snapshot: DesktopGoonRuntimeSnapshotV1 }
  | { messageType: "delta"; envelope: DesktopGoonDeltaEnvelopeV1 }
  | { messageType: "terminal"; failure: DesktopGoonBridgeFailure };

export type DesktopGoonPublisherResult =
  | { ok: true; status: "sent"; sequence: number }
  | { ok: true; status: "coalesced" }
  | { ok: false; failure: DesktopGoonBridgeFailure };

export type DesktopGoonConsumerState =
  | "awaiting-snapshot"
  | "connected"
  | "snapshot-requested"
  | "disconnected"
  | "closed";

const BRIDGE_FAILURE_CODES = new Set<DesktopGoonBridgeFailureCode>([
  "BRIDGE_CLOSED",
  "INITIAL_SNAPSHOT_REQUIRED",
  "INITIAL_SNAPSHOT_ALREADY_SENT",
  "INVALID_SNAPSHOT",
  "INVALID_DELTA",
  "RATE_LIMITED",
  "PORT_ERROR",
  "SNAPSHOT_RECOVERY_FAILED",
  "UNEXPECTED_MESSAGE",
]);

function failure(
  code: DesktopGoonBridgeFailureCode,
  message: string,
): DesktopGoonBridgeFailure {
  return { code, message, recoverToDock: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCloneSafePlainData(
  value: unknown,
  seen = new Set<object>(),
): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isCloneSafePlainData(entry, seen));
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return false;
  }
  return Object.values(value).every((entry) =>
    isCloneSafePlainData(entry, seen),
  );
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSnapshot(
  input: DesktopGoonRuntimeSnapshotV1,
):
  | { ok: true; value: DesktopGoonRuntimeSnapshotV1 }
  | { ok: false; message: string } {
  if (!isRecord(input))
    return { ok: false, message: "Desktop Goon snapshot must be an object." };
  let voiceVisual = input.voiceVisual;
  if (voiceVisual !== null) {
    const projected = projectDesktopGoonVoiceVisual(voiceVisual);
    if (!projected.ok) return { ok: false, message: projected.message };
    voiceVisual = projected.value;
  }
  try {
    const camera =
      input.camera === null
        ? null
        : parseDesktopGoonCameraStateV1(input.camera);
    const value = { ...input, voiceVisual, camera };
    const validation = validateDesktopGoonRuntimeSnapshotV1(value);
    if (!validation.ok) return { ok: false, message: validation.message };
    return { ok: true, value: clonePlain(value) };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Desktop Goon camera snapshot is invalid.",
    };
  }
}

function normalizeDelta(
  input: DesktopGoonRuntimeDeltaV1,
):
  | { ok: true; value: DesktopGoonRuntimeDeltaV1 }
  | { ok: false; message: string } {
  if (!isRecord(input) || typeof input.type !== "string") {
    return {
      ok: false,
      message: "Desktop Goon delta must be an object with a type.",
    };
  }
  try {
    if (input.type === "voice.visual") {
      const projected = projectDesktopGoonVoiceVisual(input.visual);
      if (!projected.ok) return { ok: false, message: projected.message };
      return {
        ok: true,
        value: { type: "voice.visual", visual: projected.value },
      };
    }
    if (input.type === "camera.command") {
      return {
        ok: true,
        value: {
          type: "camera.command",
          value: parseDesktopGoonCameraCommandV1(input.value),
        },
      };
    }
    if (input.type === "camera.state") {
      return {
        ok: true,
        value: {
          type: "camera.state",
          camera: parseDesktopGoonCameraStateV1(input.camera),
        },
      };
    }
    if (!isCloneSafePlainData(input)) {
      return {
        ok: false,
        message: "Desktop Goon delta must contain clone-safe plain data only.",
      };
    }
    return { ok: true, value: clonePlain(input) };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Desktop Goon delta is invalid.",
    };
  }
}

function replaceableKey(delta: DesktopGoonRuntimeDeltaV1): string | null {
  if (delta.type === "camera.state") return "camera.state";
  if (delta.type === "voice.visual" && delta.visual.kind === "frame") {
    return `voice.frame:${delta.visual.generation}`;
  }
  return null;
}

function validSnapshotRequest(
  value: unknown,
): value is DesktopGoonSnapshotRequiredRequestV1 {
  if (!isRecord(value) || !isCloneSafePlainData(value)) return false;
  const validEpoch =
    value.epoch === null ||
    (typeof value.epoch === "string" &&
      value.epoch.length > 0 &&
      value.epoch.length <= DESKTOP_GOON_TRANSPORT_POLICY_V1.maxEpochChars &&
      /^[A-Za-z0-9._:-]+$/.test(value.epoch));
  return (
    value.messageType === "snapshot-required" &&
    value.schemaVersion === DESKTOP_GOON_RUNTIME_SCHEMA_VERSION &&
    validEpoch &&
    Number.isSafeInteger(value.lastSequence) &&
    Number(value.lastSequence) >= 0 &&
    (value.reason === "sequence-gap" ||
      value.reason === "stale-sequence" ||
      value.reason === "renderer-reload")
  );
}

export class DesktopGoonMainStatePublisher {
  private port: DesktopGoonMessagePortLike | null = null;
  private messageListener: DesktopGoonPortEventListener | null = null;
  private messageErrorListener: DesktopGoonPortEventListener | null = null;
  private generation = 0;
  private initialSnapshotSent = false;
  private snapshotRecoveryUsed = false;
  private epoch: string | null = null;
  private sequence = 0;
  private rateWindow: DesktopGoonRateWindowV1 | null = null;
  private readonly pendingReplaceable = new Map<
    string,
    DesktopGoonRuntimeDeltaV1
  >();
  private terminalFailure: DesktopGoonBridgeFailure | null = null;

  constructor(
    private readonly options: {
      port: DesktopGoonMessagePortLike;
      now?: () => number;
      onSnapshotRequired: (
        request: DesktopGoonSnapshotRequiredRequestV1,
      ) => DesktopGoonRuntimeSnapshotV1 | null;
      onTerminal?: (failure: DesktopGoonBridgeFailure) => void;
    },
  ) {
    this.attachPort(options.port);
  }

  publishInitialSnapshot(
    snapshot: DesktopGoonRuntimeSnapshotV1,
  ): DesktopGoonPublisherResult {
    if (this.terminalFailure || !this.port) return this.unavailableResult();
    if (this.initialSnapshotSent) {
      return {
        ok: false,
        failure: failure(
          "INITIAL_SNAPSHOT_ALREADY_SENT",
          "Desktop Goon publisher already sent its initial snapshot on this port.",
        ),
      };
    }
    const normalized = normalizeSnapshot(snapshot);
    if (!normalized.ok) {
      return {
        ok: false,
        failure: failure("INVALID_SNAPSHOT", normalized.message),
      };
    }
    if (!this.post({ messageType: "snapshot", snapshot: normalized.value })) {
      return this.unavailableResult();
    }
    this.initialSnapshotSent = true;
    this.epoch = normalized.value.epoch;
    this.sequence = normalized.value.sequence;
    this.rateWindow = null;
    return { ok: true, status: "sent", sequence: this.sequence };
  }

  publishDelta(delta: DesktopGoonRuntimeDeltaV1): DesktopGoonPublisherResult {
    if (this.terminalFailure || !this.port) return this.unavailableResult();
    if (!this.initialSnapshotSent || this.epoch === null) {
      return {
        ok: false,
        failure: failure(
          "INITIAL_SNAPSHOT_REQUIRED",
          "Desktop Goon publisher must send one initial snapshot before any delta.",
        ),
      };
    }
    const normalized = normalizeDelta(delta);
    if (!normalized.ok) {
      return {
        ok: false,
        failure: failure("INVALID_DELTA", normalized.message),
      };
    }
    const candidate = this.createEnvelope(normalized.value);
    const validation = validateDesktopGoonDeltaEnvelopeV1(candidate, {
      epoch: this.epoch,
      lastSequence: this.sequence,
    });
    if (!validation.ok) {
      return {
        ok: false,
        failure: failure("INVALID_DELTA", validation.message),
      };
    }

    const nowMs = this.now();
    const rate = checkDesktopGoonDeltaRate(
      normalized.value,
      nowMs,
      this.rateWindow,
    );
    if (!rate.ok) {
      if (isDesktopGoonReplaceableDelta(normalized.value)) {
        const key = replaceableKey(normalized.value);
        if (key) this.pendingReplaceable.set(key, normalized.value);
        return { ok: true, status: "coalesced" };
      }
      const terminal = failure("RATE_LIMITED", rate.message);
      this.disconnectPublisher(terminal, true);
      return { ok: false, failure: terminal };
    }

    if (
      normalized.value.type === "voice.visual" &&
      normalized.value.visual.kind === "end"
    ) {
      this.pendingReplaceable.delete(
        `voice.frame:${normalized.value.visual.generation}`,
      );
    }
    if (!this.post({ messageType: "delta", envelope: candidate })) {
      return this.unavailableResult();
    }
    this.rateWindow = rate.state;
    this.sequence = candidate.sequence;
    return { ok: true, status: "sent", sequence: this.sequence };
  }

  flushReplaceable(): DesktopGoonPublisherResult[] {
    const results: DesktopGoonPublisherResult[] = [];
    for (const [key, delta] of [...this.pendingReplaceable]) {
      const result = this.publishDelta(delta);
      results.push(result);
      if (result.ok && result.status === "sent")
        this.pendingReplaceable.delete(key);
      if (!result.ok || (result.ok && result.status === "coalesced")) break;
    }
    return results;
  }

  replacePort(port: DesktopGoonMessagePortLike): void {
    this.detachPort(true);
    this.initialSnapshotSent = false;
    this.snapshotRecoveryUsed = false;
    this.epoch = null;
    this.sequence = 0;
    this.rateWindow = null;
    this.pendingReplaceable.clear();
    this.terminalFailure = null;
    this.attachPort(port);
  }

  close(): void {
    this.detachPort(true);
    this.pendingReplaceable.clear();
    this.terminalFailure = failure(
      "BRIDGE_CLOSED",
      "Desktop Goon publisher is closed.",
    );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private createEnvelope(
    delta: DesktopGoonRuntimeDeltaV1,
  ): DesktopGoonDeltaEnvelopeV1 {
    return {
      schemaVersion: DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
      epoch: this.epoch as string,
      sequence: this.sequence + 1,
      sentAtMs: this.now(),
      delta,
    };
  }

  private unavailableResult(): DesktopGoonPublisherResult {
    return {
      ok: false,
      failure:
        this.terminalFailure ??
        failure("BRIDGE_CLOSED", "Desktop Goon publisher has no active port."),
    };
  }

  private post(message: DesktopGoonMainToDesktopMessageV1): boolean {
    if (!this.port || !isCloneSafePlainData(message)) {
      const terminal = failure(
        "PORT_ERROR",
        "Desktop Goon publisher refused a non-clone-safe message.",
      );
      this.disconnectPublisher(terminal, false);
      return false;
    }
    try {
      this.port.postMessage(message);
      return true;
    } catch (error) {
      const terminal = failure(
        "PORT_ERROR",
        error instanceof Error
          ? error.message
          : "Desktop Goon port post failed.",
      );
      this.disconnectPublisher(terminal, false);
      return false;
    }
  }

  private attachPort(port: DesktopGoonMessagePortLike): void {
    this.port = port;
    const generation = ++this.generation;
    this.messageListener = (event) => {
      if (generation !== this.generation || port !== this.port) return;
      this.handleControlMessage(event.data);
    };
    this.messageErrorListener = () => {
      if (generation !== this.generation || port !== this.port) return;
      this.disconnectPublisher(
        failure(
          "PORT_ERROR",
          "Desktop Goon publisher received a MessagePort decoding error.",
        ),
        false,
      );
    };
    port.addEventListener("message", this.messageListener);
    port.addEventListener("messageerror", this.messageErrorListener);
    port.start?.();
  }

  private detachPort(close: boolean): void {
    const port = this.port;
    const messageListener = this.messageListener;
    const messageErrorListener = this.messageErrorListener;
    this.generation += 1;
    this.port = null;
    this.messageListener = null;
    this.messageErrorListener = null;
    if (!port) return;
    if (messageListener) port.removeEventListener("message", messageListener);
    if (messageErrorListener)
      port.removeEventListener("messageerror", messageErrorListener);
    if (close) port.close();
  }

  private handleControlMessage(value: unknown): void {
    if (!validSnapshotRequest(value)) {
      this.disconnectPublisher(
        failure(
          "UNEXPECTED_MESSAGE",
          "Desktop Goon publisher received an invalid control message.",
        ),
        true,
      );
      return;
    }
    if (value.epoch !== this.epoch || value.lastSequence > this.sequence) {
      this.disconnectPublisher(
        failure(
          "SNAPSHOT_RECOVERY_FAILED",
          "Desktop Goon snapshot recovery request has stale epoch or sequence state.",
        ),
        true,
      );
      return;
    }
    if (this.snapshotRecoveryUsed) {
      this.disconnectPublisher(
        failure(
          "SNAPSHOT_RECOVERY_FAILED",
          "Desktop Goon publisher received more than one snapshot recovery request.",
        ),
        true,
      );
      return;
    }
    this.snapshotRecoveryUsed = true;
    let snapshot: DesktopGoonRuntimeSnapshotV1 | null;
    try {
      snapshot = this.options.onSnapshotRequired(clonePlain(value));
    } catch (error) {
      this.disconnectPublisher(
        failure(
          "SNAPSHOT_RECOVERY_FAILED",
          error instanceof Error
            ? error.message
            : "Desktop Goon snapshot recovery failed.",
        ),
        true,
      );
      return;
    }
    if (!snapshot) {
      this.disconnectPublisher(
        failure(
          "SNAPSHOT_RECOVERY_FAILED",
          "Desktop Goon publisher could not produce a fresh snapshot.",
        ),
        true,
      );
      return;
    }
    const normalized = normalizeSnapshot(snapshot);
    if (!normalized.ok) {
      this.disconnectPublisher(
        failure("SNAPSHOT_RECOVERY_FAILED", normalized.message),
        true,
      );
      return;
    }
    this.epoch = normalized.value.epoch;
    this.sequence = normalized.value.sequence;
    this.initialSnapshotSent = true;
    this.rateWindow = null;
    this.pendingReplaceable.clear();
    this.post({ messageType: "snapshot", snapshot: normalized.value });
  }

  private disconnectPublisher(
    terminal: DesktopGoonBridgeFailure,
    notifyDesktop: boolean,
  ): void {
    if (this.terminalFailure) return;
    this.terminalFailure = terminal;
    if (notifyDesktop && this.port) {
      try {
        this.port.postMessage({ messageType: "terminal", failure: terminal });
      } catch {
        // The local terminal callback remains the visible failure when the port itself is broken.
      }
    }
    this.detachPort(true);
    this.pendingReplaceable.clear();
    this.options.onTerminal?.(terminal);
  }
}

export class DesktopGoonDesktopStateConsumer {
  private port: DesktopGoonMessagePortLike | null = null;
  private messageListener: DesktopGoonPortEventListener | null = null;
  private messageErrorListener: DesktopGoonPortEventListener | null = null;
  private generation = 0;
  private state: DesktopGoonConsumerState = "awaiting-snapshot";
  private snapshotRecoveryUsed = false;
  private epoch: string | null = null;
  private lastSequence = 0;
  private rateWindow: DesktopGoonRateWindowV1 | null = null;

  constructor(
    private readonly options: {
      port: DesktopGoonMessagePortLike;
      now?: () => number;
      onSnapshot: (snapshot: DesktopGoonRuntimeSnapshotV1) => void;
      onDelta: (envelope: DesktopGoonDeltaEnvelopeV1) => void;
      onDisconnected: (failure: DesktopGoonBridgeFailure) => void;
      onRecovery: (failure: DesktopGoonBridgeFailure) => void;
    },
  ) {
    this.attachPort(options.port);
  }

  getState(): DesktopGoonConsumerState {
    return this.state;
  }

  requestSnapshot(reason: "renderer-reload"): void {
    if (this.state === "closed" || this.state === "disconnected") return;
    this.sendSnapshotRequest(reason);
  }

  replacePort(port: DesktopGoonMessagePortLike): void {
    this.detachPort(true);
    this.state = "awaiting-snapshot";
    this.snapshotRecoveryUsed = false;
    this.epoch = null;
    this.lastSequence = 0;
    this.rateWindow = null;
    this.attachPort(port);
  }

  close(): void {
    this.state = "closed";
    this.detachPort(true);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private attachPort(port: DesktopGoonMessagePortLike): void {
    this.port = port;
    const generation = ++this.generation;
    this.messageListener = (event) => {
      if (generation !== this.generation || port !== this.port) return;
      this.handleMessage(event.data);
    };
    this.messageErrorListener = () => {
      if (generation !== this.generation || port !== this.port) return;
      this.disconnect(
        failure(
          "PORT_ERROR",
          "Desktop Goon consumer received a port decoding error.",
        ),
      );
    };
    port.addEventListener("message", this.messageListener);
    port.addEventListener("messageerror", this.messageErrorListener);
    port.start?.();
  }

  private detachPort(close: boolean): void {
    const port = this.port;
    const messageListener = this.messageListener;
    const messageErrorListener = this.messageErrorListener;
    this.generation += 1;
    this.port = null;
    this.messageListener = null;
    this.messageErrorListener = null;
    if (!port) return;
    if (messageListener) port.removeEventListener("message", messageListener);
    if (messageErrorListener)
      port.removeEventListener("messageerror", messageErrorListener);
    if (close) port.close();
  }

  private handleMessage(value: unknown): void {
    if (!isRecord(value) || !isCloneSafePlainData(value)) {
      this.disconnect(
        failure(
          "UNEXPECTED_MESSAGE",
          "Desktop Goon consumer received unsafe data.",
        ),
      );
      return;
    }
    if (value.messageType === "terminal" && isRecord(value.failure)) {
      const incoming = value.failure;
      const incomingCode =
        typeof incoming.code === "string" &&
        BRIDGE_FAILURE_CODES.has(incoming.code as DesktopGoonBridgeFailureCode)
          ? (incoming.code as DesktopGoonBridgeFailureCode)
          : "PORT_ERROR";
      this.disconnect(
        failure(
          incomingCode,
          typeof incoming.message === "string"
            ? incoming.message
            : "Desktop Goon publisher disconnected.",
        ),
      );
      return;
    }
    if (value.messageType === "snapshot") {
      this.acceptSnapshot(value.snapshot);
      return;
    }
    if (value.messageType === "delta") {
      this.acceptDelta(value.envelope);
      return;
    }
    this.disconnect(
      failure(
        "UNEXPECTED_MESSAGE",
        "Desktop Goon consumer received an unknown message.",
      ),
    );
  }

  private acceptSnapshot(value: unknown): void {
    if (
      this.state !== "awaiting-snapshot" &&
      this.state !== "snapshot-requested"
    ) {
      this.disconnect(
        failure(
          "UNEXPECTED_MESSAGE",
          "Desktop Goon consumer received an unexpected snapshot.",
        ),
      );
      return;
    }
    const normalized = normalizeSnapshot(value as DesktopGoonRuntimeSnapshotV1);
    if (!normalized.ok) {
      this.disconnect(
        failure(
          this.state === "snapshot-requested"
            ? "SNAPSHOT_RECOVERY_FAILED"
            : "INVALID_SNAPSHOT",
          normalized.message,
        ),
      );
      return;
    }
    this.epoch = normalized.value.epoch;
    this.lastSequence = normalized.value.sequence;
    this.rateWindow = null;
    this.state = "connected";
    try {
      this.options.onSnapshot(normalized.value);
    } catch (error) {
      this.disconnect(
        failure(
          "SNAPSHOT_RECOVERY_FAILED",
          error instanceof Error
            ? error.message
            : "Desktop Goon snapshot application failed.",
        ),
      );
    }
  }

  private acceptDelta(value: unknown): void {
    if (this.state !== "connected" || this.epoch === null) {
      this.disconnect(
        failure(
          this.state === "snapshot-requested"
            ? "SNAPSHOT_RECOVERY_FAILED"
            : "INITIAL_SNAPSHOT_REQUIRED",
          "Desktop Goon consumer received a delta without an active snapshot.",
        ),
      );
      return;
    }
    const validation = validateDesktopGoonDeltaEnvelopeV1(value, {
      epoch: this.epoch,
      lastSequence: this.lastSequence,
    });
    if (!validation.ok) {
      if (validation.code === "SEQUENCE_GAP") {
        this.sendSnapshotRequest("sequence-gap");
        return;
      }
      if (validation.code === "SEQUENCE_STALE") {
        this.sendSnapshotRequest("stale-sequence");
        return;
      }
      this.disconnect(failure("INVALID_DELTA", validation.message));
      return;
    }
    const envelope = value as DesktopGoonDeltaEnvelopeV1;
    const normalized = normalizeDelta(envelope.delta);
    if (!normalized.ok) {
      this.disconnect(failure("INVALID_DELTA", normalized.message));
      return;
    }
    const rate = checkDesktopGoonDeltaRate(
      normalized.value,
      this.now(),
      this.rateWindow,
    );
    if (!rate.ok) {
      this.disconnect(failure("RATE_LIMITED", rate.message));
      return;
    }
    const accepted = clonePlain({ ...envelope, delta: normalized.value });
    this.lastSequence = accepted.sequence;
    this.rateWindow = rate.state;
    try {
      this.options.onDelta(accepted);
    } catch (error) {
      this.disconnect(
        failure(
          "INVALID_DELTA",
          error instanceof Error
            ? error.message
            : "Desktop Goon delta application failed.",
        ),
      );
    }
  }

  private sendSnapshotRequest(reason: DesktopGoonSnapshotRequestReason): void {
    if (!this.port || this.state === "closed" || this.state === "disconnected")
      return;
    if (this.snapshotRecoveryUsed || this.state === "snapshot-requested") {
      this.disconnect(
        failure(
          "SNAPSHOT_RECOVERY_FAILED",
          "Desktop Goon state failed again after its one snapshot recovery attempt.",
        ),
      );
      return;
    }
    this.snapshotRecoveryUsed = true;
    this.state = "snapshot-requested";
    const request: DesktopGoonSnapshotRequiredRequestV1 = {
      messageType: "snapshot-required",
      schemaVersion: DESKTOP_GOON_RUNTIME_SCHEMA_VERSION,
      epoch: this.epoch,
      lastSequence: this.lastSequence,
      reason,
    };
    try {
      this.port.postMessage(request);
    } catch (error) {
      this.disconnect(
        failure(
          "PORT_ERROR",
          error instanceof Error
            ? error.message
            : "Desktop Goon snapshot request failed.",
        ),
      );
    }
  }

  private disconnect(terminal: DesktopGoonBridgeFailure): void {
    if (this.state === "disconnected" || this.state === "closed") return;
    this.state = "disconnected";
    this.detachPort(true);
    try {
      this.options.onDisconnected(terminal);
    } finally {
      this.options.onRecovery(terminal);
    }
  }
}
