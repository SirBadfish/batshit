const { contextBridge, ipcRenderer } = require('electron');

const schemaVersion = 'desktop-goon/v1';
const commandChannel = 'batshit:desktop-goon:command';
const statusChannel = 'batshit:desktop-goon:status';
const portChannel = 'batshit:desktop-goon:port';
const portCloseChannel = 'batshit:desktop-goon:port-close';
const controlsSchemaVersion = 'desktop-controls/v1';
const controlsCommandChannel = 'batshit:desktop-controls:command';
const controlsStateChannel = 'batshit:desktop-controls:state';
const maximumPortMessageBytes = 512 * 1024;
const roleArgument = process.argv.find((argument) => argument.startsWith('--batshit-window-role='));
const requestedRole = roleArgument?.slice('--batshit-window-role='.length);
const role = requestedRole === 'desktop' || requestedRole === 'controls' ? requestedRole : 'main';

const mainCommands = new Set([
  'desktopGoon.getStatus',
  'desktopGoon.open',
  'desktopGoon.close',
  'desktopGoon.updatePreferences',
  'desktopGoon.setBounds',
  'desktopGoon.setAdjustMode',
  'desktopGoon.returnToBatshit',
  'desktopGoon.registerShortcut',
  'desktopGoon.connectStatePort'
]);
const desktopCommands = new Set([
  'desktopGoon.getStatus',
  'desktopGoon.setBounds',
  'desktopGoon.setAdjustMode',
  'desktopGoon.returnToBatshit',
  'desktopGoon.bridgeReady',
  'desktopGoon.rendererReady',
  'desktopGoon.rendererFailed'
]);
const allowedCommands = role === 'desktop'
  ? desktopCommands
  : role === 'main'
    ? mainCommands
    : new Set();

let commandSequence = 0;
let controlsCommandSequence = 0;
let activePortState = null;
let activePortGeneration = 0;
const statusListeners = new Set();
const portListeners = new Set();
const controlsStateListeners = new Set();

function subscribe(listeners, listener, label) {
  if (typeof listener !== 'function') throw new TypeError(`${label} listener must be a function.`);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isPlainCloneable(value, seen = new Set()) {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isPlainCloneable(entry, seen));
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const prototype = Object.getPrototypeOf(value);
  const constructor = prototype?.constructor;
  if (prototype !== null && (typeof constructor !== 'function' || constructor.name !== 'Object')) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every(
    (descriptor) =>
      descriptor.enumerable === true &&
      'value' in descriptor &&
      isPlainCloneable(descriptor.value, seen)
  );
}

function validatedPortPayload(value) {
  if (!isPlainCloneable(value)) {
    throw new TypeError('Desktop Goon state-port messages must contain clone-safe plain data.');
  }
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    throw new TypeError('Desktop Goon state-port messages must be JSON serializable.');
  }
  if (new TextEncoder().encode(serialized).byteLength > maximumPortMessageBytes) {
    throw new RangeError('Desktop Goon state-port message exceeds the 512 KiB limit.');
  }
  return value;
}

function attachPortMessageListener(port, listener) {
  if (typeof port.addEventListener === 'function') {
    port.addEventListener('message', listener);
    return () => port.removeEventListener?.('message', listener);
  }
  const previous = port.onmessage;
  port.onmessage = listener;
  return () => {
    if (port.onmessage === listener) port.onmessage = previous || null;
  };
}

function createStatePortFacade(port, metadata) {
  const messageListeners = new Set();
  const closeListeners = new Set();
  let closed = false;
  const safeMetadata = Object.freeze({
    schemaVersion: metadata.schemaVersion,
    generation: metadata.generation,
    role: metadata.role
  });
  const onPortMessage = (event) => {
    if (closed) return;
    try {
      const value = validatedPortPayload(event?.data);
      for (const listener of messageListeners) listener(value);
    } catch {
      close('invalid-message');
    }
  };
  const detachMessageListener = attachPortMessageListener(port, onPortMessage);

  function close(reason = 'renderer-close') {
    if (closed) return;
    closed = true;
    detachMessageListener();
    port.close();
    const event = Object.freeze({ generation: metadata.generation, reason });
    for (const listener of closeListeners) listener(event);
    messageListeners.clear();
    closeListeners.clear();
    if (activePortState?.port === port) {
      activePortState = null;
      activePortGeneration = 0;
    }
  }

  const facade = Object.freeze({
    generation: metadata.generation,
    metadata: safeMetadata,
    postMessage(value) {
      if (closed) throw new Error('Desktop Goon state port is closed.');
      port.postMessage(validatedPortPayload(value));
    },
    onMessage(listener) {
      return subscribe(messageListeners, listener, 'Desktop Goon state-port message');
    },
    onClose(listener) {
      return subscribe(closeListeners, listener, 'Desktop Goon state-port close');
    },
    close() {
      close('renderer-close');
    }
  });
  port.start?.();
  return { port, facade, close };
}

function closeActivePort(reason = 'closed') {
  if (!activePortState) return;
  activePortState.close(reason);
  activePortState = null;
  activePortGeneration = 0;
}

ipcRenderer.on(statusChannel, (_event, value) => {
  if (!value || value.schemaVersion !== schemaVersion || typeof value.type !== 'string') return;
  for (const listener of statusListeners) listener(value);
});

ipcRenderer.on(controlsStateChannel, (_event, value) => {
  if (
    !value ||
    value.schemaVersion !== controlsSchemaVersion ||
    typeof value.type !== 'string' ||
    !value.state ||
    value.state.schemaVersion !== controlsSchemaVersion
  ) return;
  const deepFreeze = (entry) => {
    if (entry && typeof entry === 'object' && !Object.isFrozen(entry)) {
      for (const nested of Object.values(entry)) deepFreeze(nested);
      Object.freeze(entry);
    }
    return entry;
  };
  const event = deepFreeze({
    schemaVersion: value.schemaVersion,
    type: value.type,
    detail: { ...(value.detail || {}) },
    state: { ...value.state }
  });
  for (const listener of controlsStateListeners) listener(event);
});

ipcRenderer.on(portCloseChannel, (_event, value) => {
  if (!value || value.schemaVersion !== schemaVersion) return;
  if (activePortGeneration && value.generation !== activePortGeneration) return;
  closeActivePort(typeof value.reason === 'string' ? value.reason : 'main-process-close');
});

ipcRenderer.on(portChannel, (event, metadata) => {
  const port = event.ports?.[0];
  if (
    !port ||
    !metadata ||
    metadata.schemaVersion !== schemaVersion ||
    metadata.role !== role ||
    !Number.isSafeInteger(metadata.generation) ||
    metadata.generation < 1
  ) {
    for (const rejected of event.ports || []) rejected.close();
    return;
  }
  closeActivePort('port-replaced');
  activePortState = createStatePortFacade(port, metadata);
  activePortGeneration = metadata.generation;
  for (const listener of portListeners) listener(activePortState.facade);
});

const desktopGoon = Object.freeze({
  schemaVersion,
  role,
  invoke(command, payload = {}) {
    if (!allowedCommands.has(command)) {
      return Promise.reject(new Error(`Desktop Goon command is unavailable in the ${role} window.`));
    }
    commandSequence += 1;
    return ipcRenderer.invoke(commandChannel, {
      schemaVersion,
      sequence: commandSequence,
      command,
      payload
    });
  },
  onStatus(listener) {
    return subscribe(statusListeners, listener, 'Desktop Goon status');
  },
  onStatePort(listener) {
    return subscribe(portListeners, listener, 'Desktop Goon state port');
  }
});

const mainControlsCommands = new Set([
  'desktopControls.getState',
  'desktopControls.show',
  'desktopControls.hide',
  'desktopControls.toggle',
  'desktopControls.updateState'
]);
const rendererControlsCommands = new Set([
  'desktopControls.getState',
  'desktopControls.hide',
  'desktopControls.sendIntent',
  'desktopControls.setAdjust',
  'desktopControls.rendererReady'
]);
const allowedControlsCommands = role === 'controls'
  ? rendererControlsCommands
  : role === 'main'
    ? mainControlsCommands
    : new Set();

const desktopControls = Object.freeze({
  schemaVersion: controlsSchemaVersion,
  role,
  invoke(command, payload = {}) {
    if (!allowedControlsCommands.has(command)) {
      return Promise.reject(
        new Error(`Desktop Controls command is unavailable in the ${role} window.`)
      );
    }
    controlsCommandSequence += 1;
    return ipcRenderer.invoke(controlsCommandChannel, {
      schemaVersion: controlsSchemaVersion,
      sequence: controlsCommandSequence,
      command,
      payload
    });
  },
  onState(listener) {
    return subscribe(controlsStateListeners, listener, 'Desktop Controls state');
  }
});

const zero = role === 'desktop'
  ? Object.freeze({ desktopGoon })
  : role === 'controls'
    ? Object.freeze({ desktopControls })
    : Object.freeze({
      invoke(command, payload = {}) {
        return ipcRenderer.invoke('batshit:invoke', command, payload);
      },
      dialogs: Object.freeze({
        saveFile(options = {}) {
          return ipcRenderer.invoke('batshit:save-file', options);
        }
      }),
      desktopGoon,
      desktopControls
    });

contextBridge.exposeInMainWorld('zero', zero);
