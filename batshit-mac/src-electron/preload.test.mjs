import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(moduleDir, 'preload.cjs'), 'utf8');

class FakePort extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.started = false;
    this.messages = [];
  }
  addEventListener(type, listener) { this.on(type, listener); }
  removeEventListener(type, listener) { this.off(type, listener); }
  start() { this.started = true; }
  close() { this.closed = true; }
  postMessage(value) { this.messages.push(value); }
  receive(value) { this.emit('message', { data: value }); }
}

function loadPreload(role) {
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = async (...args) => args;
  let exposed = null;
  const contextBridge = {
    exposeInMainWorld(name, value) {
      assert.equal(name, 'zero');
      exposed = value;
    }
  };
  vm.runInNewContext(source, {
    require(name) {
      assert.equal(name, 'electron');
      return { contextBridge, ipcRenderer };
    },
    process: {
      argv: role === 'main' ? ['electron'] : ['electron', `--batshit-window-role=${role}`]
    },
    Promise,
    Object,
    Set,
    Number,
    Error,
    TypeError,
    RangeError,
    TextEncoder
  });
  return { zero: exposed, ipcRenderer };
}

test('desktop preload exposes only the frozen versioned Desktop Goon API', async () => {
  const { zero } = loadPreload('desktop');
  assert.deepEqual(Object.keys(zero), ['desktopGoon']);
  assert.equal(Object.isFrozen(zero), true);
  assert.equal(Object.isFrozen(zero.desktopGoon), true);
  assert.equal(zero.desktopGoon.role, 'desktop');
  assert.equal(zero.invoke, undefined);
  assert.equal(zero.dialogs, undefined);
  await assert.rejects(
    () => zero.desktopGoon.invoke('desktopGoon.open', {}),
    /unavailable in the desktop window/
  );
});

test('main preload retains existing narrow APIs and adds Desktop Goon commands', async () => {
  const { zero, ipcRenderer } = loadPreload('main');
  assert.deepEqual(Object.keys(zero).sort(), [
    'desktopControls',
    'desktopGoon',
    'dialogs',
    'invoke',
    'lifecycle'
  ]);
  assert.equal(zero.desktopGoon.role, 'main');
  await zero.desktopGoon.invoke('desktopGoon.open', {});
  const invocation = ipcRenderer.listeners('batshit:desktop-goon:status');
  assert.equal(invocation.length, 1);
});

test('main preload exposes a frozen one-way intentional-shutdown lifecycle', () => {
  const { zero, ipcRenderer } = loadPreload('main');
  const received = [];
  const unsubscribe = zero.lifecycle.onShutdown((event) => received.push(event));

  assert.equal(Object.isFrozen(zero.lifecycle), true);
  assert.equal(zero.lifecycle.isShuttingDown(), false);
  ipcRenderer.emit('batshit:lifecycle:shutdown-started', {}, {
    schemaVersion: 'app-lifecycle/v0',
    type: 'shutdown-started',
    reason: 'window-close'
  });
  assert.equal(zero.lifecycle.isShuttingDown(), false);
  assert.equal(received.length, 0);
  ipcRenderer.emit('batshit:lifecycle:shutdown-started', {}, {
    schemaVersion: 'app-lifecycle/v1',
    type: 'shutdown-started',
    reason: 'window-close'
  });
  assert.equal(zero.lifecycle.isShuttingDown(), true);
  assert.equal(received.length, 1);
  assert.equal(Object.isFrozen(received[0]), true);
  assert.equal(received[0].schemaVersion, 'app-lifecycle/v1');
  assert.equal(received[0].type, 'shutdown-started');
  assert.equal(received[0].reason, 'window-close');

  ipcRenderer.emit('batshit:lifecycle:shutdown-started', {}, {
    schemaVersion: 'app-lifecycle/v1',
    type: 'shutdown-started',
    reason: 'app-quit'
  });
  assert.equal(received.length, 1);
  unsubscribe();
});

test('controls preload exposes only its frozen role-scoped state and intent bridge', async () => {
  const { zero, ipcRenderer } = loadPreload('controls');
  assert.deepEqual(Object.keys(zero), ['desktopControls']);
  assert.equal(Object.isFrozen(zero), true);
  assert.equal(Object.isFrozen(zero.desktopControls), true);
  assert.equal(zero.desktopControls.role, 'controls');
  assert.equal(zero.desktopGoon, undefined);
  assert.equal(zero.invoke, undefined);
  assert.equal(zero.dialogs, undefined);
  await assert.rejects(
    () => zero.desktopControls.invoke('desktopControls.updateState', { state: {} }),
    /unavailable in the controls window/
  );
  await zero.desktopControls.invoke('desktopControls.setAdjust', { enabled: true });

  const received = [];
  zero.desktopControls.onState((event) => received.push(event));
  ipcRenderer.emit('batshit:desktop-controls:state', {}, {
    schemaVersion: 'desktop-controls/v1',
    type: 'projection-updated',
    detail: {},
    state: {
      schemaVersion: 'desktop-controls/v1',
      active: true,
      visible: true,
      projection: { sessionId: 's1' }
    }
  });
  assert.equal(received.length, 1);
  assert.equal(Object.isFrozen(received[0]), true);
  assert.equal(Object.isFrozen(received[0].state), true);
  assert.equal(Object.isFrozen(received[0].state.projection), true);
  assert.equal(received[0].state.projection.sessionId, 's1');
  const intent = await zero.desktopControls.invoke('desktopControls.sendIntent', {
    intent: 'voice.start',
    payload: { source: 'desktop-controls' }
  });
  assert.equal(intent[1].command, 'desktopControls.sendIntent');
});

test('main preload can push bounded Desktop Controls projection state', async () => {
  const { zero, ipcRenderer } = loadPreload('main');
  const result = await zero.desktopControls.invoke('desktopControls.updateState', {
    state: { sessionId: 's1', clips: { count: 2 } }
  });
  assert.equal(result[0], 'batshit:desktop-controls:command');
  assert.equal(result[1].command, 'desktopControls.updateState');
  assert.deepEqual(result[1].payload, {
    state: { sessionId: 's1', clips: { count: 2 } }
  });
  assert.equal(ipcRenderer.listeners('batshit:desktop-controls:state').length, 1);
});

test('state-port transfer exposes only a frozen facade and never leaks the raw port', () => {
  const { zero, ipcRenderer } = loadPreload('main');
  const receivedFacades = [];
  zero.desktopGoon.onStatePort((facade) => receivedFacades.push(facade));
  const rawPort = new FakePort();
  ipcRenderer.emit(
    'batshit:desktop-goon:port',
    { ports: [rawPort] },
    { schemaVersion: 'desktop-goon/v1', generation: 7, role: 'main' }
  );

  assert.equal(receivedFacades.length, 1);
  const facade = receivedFacades[0];
  assert.equal(Object.isFrozen(facade), true);
  assert.equal(Object.isFrozen(facade.metadata), true);
  assert.deepEqual(Object.keys(facade).sort(), [
    'close',
    'generation',
    'metadata',
    'onClose',
    'onMessage',
    'postMessage'
  ]);
  assert.equal(Object.values(facade).includes(rawPort), false);
  assert.equal(facade.port, undefined);
  assert.equal(rawPort.started, true);

  const incoming = [];
  facade.onMessage((value) => incoming.push(value));
  rawPort.receive({ messageType: 'snapshot-required', lastSequence: 3 });
  assert.deepEqual(incoming, [{ messageType: 'snapshot-required', lastSequence: 3 }]);
  facade.postMessage({ messageType: 'snapshot', sequence: 4 });
  assert.deepEqual(rawPort.messages, [{ messageType: 'snapshot', sequence: 4 }]);
  assert.throws(() => facade.postMessage(new Date()), /clone-safe plain data/);
  assert.throws(
    () => facade.postMessage({ payload: 'x'.repeat(512 * 1024) }),
    /512 KiB/
  );
});

test('state-port replacement and close notifications close the hidden raw port deterministically', () => {
  const { zero, ipcRenderer } = loadPreload('desktop');
  const facades = [];
  zero.desktopGoon.onStatePort((facade) => facades.push(facade));

  const firstPort = new FakePort();
  ipcRenderer.emit(
    'batshit:desktop-goon:port',
    { ports: [firstPort] },
    { schemaVersion: 'desktop-goon/v1', generation: 1, role: 'desktop' }
  );
  const firstCloses = [];
  facades[0].onClose((value) => firstCloses.push(value));

  const secondPort = new FakePort();
  ipcRenderer.emit(
    'batshit:desktop-goon:port',
    { ports: [secondPort] },
    { schemaVersion: 'desktop-goon/v1', generation: 2, role: 'desktop' }
  );
  assert.equal(firstPort.closed, true);
  assert.equal(firstCloses.length, 1);
  assert.equal(firstCloses[0].generation, 1);
  assert.equal(firstCloses[0].reason, 'port-replaced');
  assert.throws(() => facades[0].postMessage({ ok: true }), /closed/);

  const secondCloses = [];
  facades[1].onClose((value) => secondCloses.push(value));
  ipcRenderer.emit(
    'batshit:desktop-goon:port-close',
    {},
    { schemaVersion: 'desktop-goon/v1', generation: 2, reason: 'desktop-navigation' }
  );
  assert.equal(secondPort.closed, true);
  assert.equal(secondCloses.length, 1);
  assert.equal(secondCloses[0].generation, 2);
  assert.equal(secondCloses[0].reason, 'desktop-navigation');
  assert.throws(() => facades[1].postMessage({ ok: true }), /closed/);
});
