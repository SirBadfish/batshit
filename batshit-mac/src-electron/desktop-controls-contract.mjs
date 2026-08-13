export const DESKTOP_CONTROLS_SCHEMA_VERSION = 'desktop-controls/v1';
export const DESKTOP_CONTROLS_IPC_CHANNEL = 'batshit:desktop-controls:command';
export const DESKTOP_CONTROLS_STATE_CHANNEL = 'batshit:desktop-controls:state';
export const DESKTOP_CONTROLS_MAX_COMMAND_BYTES = 80 * 1024;
export const DESKTOP_CONTROLS_MAX_STATE_BYTES = 64 * 1024;

export const DESKTOP_CONTROLS_COMMANDS = Object.freeze({
  getState: 'desktopControls.getState',
  show: 'desktopControls.show',
  hide: 'desktopControls.hide',
  toggle: 'desktopControls.toggle',
  updateState: 'desktopControls.updateState',
  sendIntent: 'desktopControls.sendIntent',
  setAdjust: 'desktopControls.setAdjust',
  rendererReady: 'desktopControls.rendererReady'
});

const MAIN_COMMANDS = new Set([
  DESKTOP_CONTROLS_COMMANDS.getState,
  DESKTOP_CONTROLS_COMMANDS.show,
  DESKTOP_CONTROLS_COMMANDS.hide,
  DESKTOP_CONTROLS_COMMANDS.toggle,
  DESKTOP_CONTROLS_COMMANDS.updateState
]);

const CONTROLS_COMMANDS = new Set([
  DESKTOP_CONTROLS_COMMANDS.getState,
  DESKTOP_CONTROLS_COMMANDS.hide,
  DESKTOP_CONTROLS_COMMANDS.sendIntent,
  DESKTOP_CONTROLS_COMMANDS.setAdjust,
  DESKTOP_CONTROLS_COMMANDS.rendererReady
]);

const PAYLOAD_KEYS = Object.freeze({
  [DESKTOP_CONTROLS_COMMANDS.getState]: [],
  [DESKTOP_CONTROLS_COMMANDS.show]: [],
  [DESKTOP_CONTROLS_COMMANDS.hide]: ['reason'],
  [DESKTOP_CONTROLS_COMMANDS.toggle]: [],
  [DESKTOP_CONTROLS_COMMANDS.updateState]: ['state'],
  [DESKTOP_CONTROLS_COMMANDS.sendIntent]: ['intent', 'payload'],
  [DESKTOP_CONTROLS_COMMANDS.setAdjust]: ['enabled'],
  [DESKTOP_CONTROLS_COMMANDS.rendererReady]: []
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateReason(value) {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > 256 || value.includes('\0')) {
    throw new Error('Desktop Controls reason must be a bounded string.');
  }
}

function isPlainCloneable(value, seen = new Set()) {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isPlainCloneable(entry, seen));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((entry) => isPlainCloneable(entry, seen));
}

export function commandsForDesktopControlsRole(role) {
  if (role === 'main') return MAIN_COMMANDS;
  if (role === 'controls') return CONTROLS_COMMANDS;
  return new Set();
}

export function validateDesktopControlsCommandEnvelope(
  value,
  { role, lastSequence = 0, maximumBytes = DESKTOP_CONTROLS_MAX_COMMAND_BYTES } = {}
) {
  if (!isPlainObject(value)) throw new Error('Desktop Controls command must be an object.');
  const envelopeKeys = new Set(['schemaVersion', 'sequence', 'command', 'payload']);
  for (const key of Object.keys(value)) {
    if (!envelopeKeys.has(key)) throw new Error(`Unsupported Desktop Controls envelope field: ${key}`);
  }
  if (value.schemaVersion !== DESKTOP_CONTROLS_SCHEMA_VERSION) {
    throw new Error(`Desktop Controls schema mismatch: expected ${DESKTOP_CONTROLS_SCHEMA_VERSION}.`);
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence <= lastSequence) {
    throw new Error('Desktop Controls command sequence is missing or stale.');
  }
  if (!commandsForDesktopControlsRole(role).has(value.command)) {
    throw new Error(`Desktop Controls command is not allowed for the ${role || 'unknown'} role.`);
  }
  if (!isPlainObject(value.payload)) throw new Error('Desktop Controls payload must be an object.');
  const allowedKeys = PAYLOAD_KEYS[value.command];
  for (const key of Object.keys(value.payload)) {
    if (!allowedKeys.includes(key)) throw new Error(`Unsupported Desktop Controls payload field: ${key}`);
  }
  if (
    value.command === DESKTOP_CONTROLS_COMMANDS.setAdjust &&
    typeof value.payload.enabled !== 'boolean'
  ) {
    throw new Error('Desktop Controls Adjust intent must be boolean.');
  }
  if (value.command === DESKTOP_CONTROLS_COMMANDS.updateState) {
    if (!isPlainObject(value.payload.state) || !isPlainCloneable(value.payload.state)) {
      throw new Error('Desktop Controls projected state must be clone-safe plain JSON.');
    }
    if (
      Buffer.byteLength(JSON.stringify(value.payload.state), 'utf8') >
      DESKTOP_CONTROLS_MAX_STATE_BYTES
    ) {
      throw new Error(
        `Desktop Controls projected state exceeds the ${DESKTOP_CONTROLS_MAX_STATE_BYTES}-byte limit.`
      );
    }
  }
  if (value.command === DESKTOP_CONTROLS_COMMANDS.sendIntent) {
    if (
      typeof value.payload.intent !== 'string' ||
      !/^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)*$/.test(value.payload.intent) ||
      value.payload.intent.length > 128
    ) {
      throw new Error('Desktop Controls renderer intent must use a bounded stable name.');
    }
    if (!isPlainObject(value.payload.payload) || !isPlainCloneable(value.payload.payload)) {
      throw new Error('Desktop Controls renderer intent payload must be clone-safe plain JSON.');
    }
  }
  if (value.command === DESKTOP_CONTROLS_COMMANDS.hide) {
    validateReason(value.payload.reason);
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Desktop Controls command must be JSON serializable.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new Error(`Desktop Controls command exceeds the ${maximumBytes}-byte limit.`);
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    sequence: value.sequence,
    command: value.command,
    payload: Object.freeze({ ...value.payload })
  });
}
