export const DESKTOP_GOON_SCHEMA_VERSION = 'desktop-goon/v1';
export const DESKTOP_GOON_IPC_CHANNEL = 'batshit:desktop-goon:command';
export const DESKTOP_GOON_STATUS_CHANNEL = 'batshit:desktop-goon:status';
export const DESKTOP_GOON_PORT_CHANNEL = 'batshit:desktop-goon:port';
export const DESKTOP_GOON_PORT_CLOSE_CHANNEL = 'batshit:desktop-goon:port-close';
export const DESKTOP_GOON_MAX_COMMAND_BYTES = 64 * 1024;
export const DESKTOP_GOON_MAX_PORT_MESSAGE_BYTES = 512 * 1024;
export const DESKTOP_GOON_MAX_PORT_MESSAGES_PER_SECOND = 120;

export const DESKTOP_GOON_WINDOW_ROLES = Object.freeze({
  main: 'main',
  desktop: 'desktop',
  controls: 'controls'
});

export const DESKTOP_GOON_COMMANDS = Object.freeze({
  getStatus: 'desktopGoon.getStatus',
  open: 'desktopGoon.open',
  close: 'desktopGoon.close',
  updatePreferences: 'desktopGoon.updatePreferences',
  setBounds: 'desktopGoon.setBounds',
  setAdjustMode: 'desktopGoon.setAdjustMode',
  returnToBatshit: 'desktopGoon.returnToBatshit',
  registerShortcut: 'desktopGoon.registerShortcut',
  bridgeReady: 'desktopGoon.bridgeReady',
  rendererReady: 'desktopGoon.rendererReady',
  rendererFailed: 'desktopGoon.rendererFailed',
  connectStatePort: 'desktopGoon.connectStatePort'
});

const MAIN_COMMANDS = new Set([
  DESKTOP_GOON_COMMANDS.getStatus,
  DESKTOP_GOON_COMMANDS.open,
  DESKTOP_GOON_COMMANDS.close,
  DESKTOP_GOON_COMMANDS.updatePreferences,
  DESKTOP_GOON_COMMANDS.setBounds,
  DESKTOP_GOON_COMMANDS.setAdjustMode,
  DESKTOP_GOON_COMMANDS.returnToBatshit,
  DESKTOP_GOON_COMMANDS.registerShortcut,
  DESKTOP_GOON_COMMANDS.connectStatePort
]);

const DESKTOP_COMMANDS = new Set([
  DESKTOP_GOON_COMMANDS.getStatus,
  DESKTOP_GOON_COMMANDS.setBounds,
  DESKTOP_GOON_COMMANDS.setAdjustMode,
  DESKTOP_GOON_COMMANDS.returnToBatshit,
  DESKTOP_GOON_COMMANDS.bridgeReady,
  DESKTOP_GOON_COMMANDS.rendererReady,
  DESKTOP_GOON_COMMANDS.rendererFailed
]);

const COMMAND_PAYLOAD_KEYS = Object.freeze({
  [DESKTOP_GOON_COMMANDS.getStatus]: [],
  [DESKTOP_GOON_COMMANDS.open]: ['preferences', 'bounds'],
  [DESKTOP_GOON_COMMANDS.close]: ['reason'],
  [DESKTOP_GOON_COMMANDS.updatePreferences]: ['preferences'],
  [DESKTOP_GOON_COMMANDS.setBounds]: ['bounds'],
  [DESKTOP_GOON_COMMANDS.setAdjustMode]: ['enabled'],
  [DESKTOP_GOON_COMMANDS.returnToBatshit]: ['reason'],
  [DESKTOP_GOON_COMMANDS.registerShortcut]: ['accelerator'],
  [DESKTOP_GOON_COMMANDS.bridgeReady]: [],
  [DESKTOP_GOON_COMMANDS.rendererReady]: [],
  [DESKTOP_GOON_COMMANDS.rendererFailed]: ['message'],
  [DESKTOP_GOON_COMMANDS.connectStatePort]: []
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializedByteLength(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable.`);
  }
  if (typeof serialized !== 'string') {
    throw new Error(`${label} must be JSON serializable.`);
  }
  return Buffer.byteLength(serialized, 'utf8');
}

function validateReason(value) {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > 256 || value.includes('\0')) {
    throw new Error('Desktop Goon reason must be a bounded string.');
  }
}

function validateCommandPayload(command, payload) {
  if (!isPlainObject(payload)) {
    throw new Error('Desktop Goon command payload must be an object.');
  }
  const allowedKeys = COMMAND_PAYLOAD_KEYS[command];
  if (!allowedKeys) throw new Error(`Unsupported Desktop Goon command: ${command}`);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Unsupported Desktop Goon command payload field: ${key}`);
    }
  }

  if (command === DESKTOP_GOON_COMMANDS.open) {
    if (payload.preferences !== undefined && !isPlainObject(payload.preferences)) {
      throw new Error('Desktop Goon preferences must be an object.');
    }
    if (payload.bounds !== undefined && !isPlainObject(payload.bounds)) {
      throw new Error('Desktop Goon bounds must be an object.');
    }
  }
  if (command === DESKTOP_GOON_COMMANDS.updatePreferences && !isPlainObject(payload.preferences)) {
    throw new Error('Desktop Goon preferences must be an object.');
  }
  if (command === DESKTOP_GOON_COMMANDS.setBounds && !isPlainObject(payload.bounds)) {
    throw new Error('Desktop Goon bounds must be an object.');
  }
  if (command === DESKTOP_GOON_COMMANDS.setAdjustMode && typeof payload.enabled !== 'boolean') {
    throw new Error('Desktop Goon Adjust state must be boolean.');
  }
  if (command === DESKTOP_GOON_COMMANDS.registerShortcut) {
    if (
      typeof payload.accelerator !== 'string' ||
      !payload.accelerator.trim() ||
      payload.accelerator.length > 128 ||
      payload.accelerator.includes('\0')
    ) {
      throw new Error('Desktop Goon shortcut must be a bounded accelerator string.');
    }
  }
  if (
    command === DESKTOP_GOON_COMMANDS.close ||
    command === DESKTOP_GOON_COMMANDS.returnToBatshit
  ) {
    validateReason(payload.reason);
  }
  if (command === DESKTOP_GOON_COMMANDS.rendererFailed) {
    if (
      typeof payload.message !== 'string' ||
      !payload.message.trim() ||
      payload.message.length > 1024 ||
      payload.message.includes('\0')
    ) {
      throw new Error('Desktop Goon renderer failure must include a bounded message.');
    }
  }
}

export function commandsForDesktopGoonRole(role) {
  if (role === DESKTOP_GOON_WINDOW_ROLES.main) return MAIN_COMMANDS;
  if (role === DESKTOP_GOON_WINDOW_ROLES.desktop) return DESKTOP_COMMANDS;
  return new Set();
}

export function validateDesktopGoonCommandEnvelope(
  value,
  { role, lastSequence = 0, maximumBytes = DESKTOP_GOON_MAX_COMMAND_BYTES } = {}
) {
  if (!isPlainObject(value)) throw new Error('Desktop Goon command envelope must be an object.');
  const allowedEnvelopeKeys = new Set(['schemaVersion', 'sequence', 'command', 'payload']);
  for (const key of Object.keys(value)) {
    if (!allowedEnvelopeKeys.has(key)) {
      throw new Error(`Unsupported Desktop Goon command envelope field: ${key}`);
    }
  }
  if (value.schemaVersion !== DESKTOP_GOON_SCHEMA_VERSION) {
    throw new Error(
      `Desktop Goon schema mismatch: expected ${DESKTOP_GOON_SCHEMA_VERSION}.`
    );
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error('Desktop Goon command sequence must be a positive integer.');
  }
  if (value.sequence <= lastSequence) {
    throw new Error(
      `Desktop Goon command sequence is stale: received ${value.sequence} after ${lastSequence}.`
    );
  }
  if (typeof value.command !== 'string' || !commandsForDesktopGoonRole(role).has(value.command)) {
    throw new Error(`Desktop Goon command is not allowed for the ${role || 'unknown'} window role.`);
  }
  validateCommandPayload(value.command, value.payload);
  if (serializedByteLength(value, 'Desktop Goon command') > maximumBytes) {
    throw new Error(`Desktop Goon command exceeds the ${maximumBytes}-byte limit.`);
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    sequence: value.sequence,
    command: value.command,
    payload: Object.freeze({ ...value.payload })
  });
}

export function validateDesktopGoonPortEnvelope(
  value,
  { lastSequence = 0, maximumBytes = DESKTOP_GOON_MAX_PORT_MESSAGE_BYTES } = {}
) {
  if (!isPlainObject(value)) throw new Error('Desktop Goon port message must be an object.');
  const allowedKeys = new Set(['schemaVersion', 'sequence', 'kind', 'payload']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`Unsupported Desktop Goon port field: ${key}`);
  }
  if (value.schemaVersion !== DESKTOP_GOON_SCHEMA_VERSION) {
    throw new Error(
      `Desktop Goon port schema mismatch: expected ${DESKTOP_GOON_SCHEMA_VERSION}.`
    );
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence <= lastSequence) {
    throw new Error('Desktop Goon port sequence is missing or stale.');
  }
  if (!['snapshot', 'delta', 'snapshot-request', 'ack', 'error'].includes(value.kind)) {
    throw new Error(`Unsupported Desktop Goon port message kind: ${value.kind}`);
  }
  if (!isPlainObject(value.payload)) throw new Error('Desktop Goon port payload must be an object.');
  if (serializedByteLength(value, 'Desktop Goon port message') > maximumBytes) {
    throw new Error(`Desktop Goon port message exceeds the ${maximumBytes}-byte limit.`);
  }
  return value;
}
