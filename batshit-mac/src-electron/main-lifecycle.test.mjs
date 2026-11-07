import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { createNavigationDiagnostic, collectAllowedOrigins, isAllowedMainWindowUrl, isExactDesktopControlsUrl, isExactDesktopGoonUrl } from './electron-shell-policy.mjs';
import { DESKTOP_GOON_WINDOW_ROLES } from './desktop-goon-contract.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const mainSource = await readFile(join(moduleDir, 'main.mjs'), 'utf8');

test('actual role navigation keeps denial and logs only opted-in sanitized event fields', () => {
  const start = mainSource.indexOf('function configureRoleNavigation(');
  const end = mainSource.indexOf('\nfunction intentionalShutdownInProgress', start);
  assert.ok(start >= 0 && end > start);
  for (const enabled of [false, true]) {
    const logs = [];
    let evaluations = 0;
    const register = runInNewContext(`(${mainSource.slice(start, end)})`, {
      navigationDiagnosticsEnabled: enabled,
      DESKTOP_GOON_WINDOW_ROLES,
      allowedOrigins: collectAllowedOrigins({}),
      desktopGoonUrl: 'http://127.0.0.1:5640/desktop-goon',
      desktopControlsUrl: 'http://127.0.0.1:5640/desktop-controls',
      isExactDesktopGoonUrl, isExactDesktopControlsUrl, createNavigationDiagnostic,
      isAllowedMainWindowUrl: (...args) => { evaluations++; return isAllowedMainWindowUrl(...args); },
      console: { info: (...args) => logs.push(args) }
    });
    const contents = new EventEmitter();
    contents.getURL = () => 'http://127.0.0.1:5640/login?code=PRIVATE_SENTINEL';
    register(contents, 'main');
    for (const [url, denied] of [
      ['http://127.0.0.1:5640/login?code=PRIVATE_SENTINEL', false],
      ['https://PRIVATE_HOST.test/PRIVATE_PATH?code=PRIVATE_SENTINEL', true],
      ['http://127.0.0.1:5640/desktop-goon', true],
      [undefined, true]
    ]) {
      const event = { url: 'http://127.0.0.1:5640/login?code=PRIVATE_SENTINEL', isMainFrame: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      const before = evaluations;
      contents.emit('will-redirect', event, url);
      assert.equal(evaluations, before + 1, 'one unchanged policy decision per event');
      assert.equal(event.defaultPrevented, denied);
    }
    contents.emit('did-finish-load');
    contents.emit('did-fail-load', {}, -3, 'PRIVATE_ERROR_DESCRIPTION', 'http://127.0.0.1:5640/login?code=PRIVATE_SENTINEL', true);
    assert.equal(logs.length, enabled ? 6 : 0);
    for (const [prefix, serialized] of logs) {
      assert.equal(prefix, '[Batshit navigation]');
      assert.ok(!serialized.includes('PRIVATE'));
      assert.doesNotThrow(() => JSON.parse(serialized));
    }
    if (enabled) {
      assert.equal(JSON.parse(logs[3][1]).legacyArgument.category, 'missing');
      assert.equal(JSON.parse(logs[3][1]).eventUrl.route, 'login');
      assert.equal(JSON.parse(logs[5][1]).errorCode, -3);
    }
  }
});

test('intentional shutdown notifies and hides the renderer before service teardown', () => {
  const stopStart = mainSource.indexOf('async function stopRuntimeBeforeQuit');
  const notify = mainSource.indexOf('notifyRendererShutdown(reason);', stopStart);
  const stop = mainSource.indexOf("await runSupervisor('stop');", stopStart);

  assert.notEqual(stopStart, -1);
  assert.notEqual(notify, -1);
  assert.notEqual(stop, -1);
  assert.ok(notify < stop);
  assert.ok(mainSource.indexOf('settleShutdownPreparations', stopStart) < stop);
  assert.match(mainSource, /window\.webContents\.send\(appShutdownChannel/);
  assert.match(mainSource, /window\.hide\(\);/);
});

test('red-X close is identified separately from other application quit paths', () => {
  assert.match(mainSource, /pendingShutdownReason = 'window-close';/);
  assert.match(mainSource, /stopRuntimeBeforeQuit\(pendingShutdownReason\)/);
});

test('intentional shutdown cannot surface renderer failure dialogs during teardown', () => {
  assert.match(
    mainSource,
    /function intentionalShutdownInProgress\(\) \{\s+return shutdownStarted \|\| quittingAfterShutdown;\s+\}/
  );

  const rendererGoneStart = mainSource.indexOf("window.webContents.on('render-process-gone'");
  const unresponsiveStart = mainSource.indexOf("window.on('unresponsive'");
  const closeStart = mainSource.indexOf("window.on('close'");

  assert.notEqual(rendererGoneStart, -1);
  assert.notEqual(unresponsiveStart, -1);
  assert.notEqual(closeStart, -1);
  assert.match(
    mainSource.slice(rendererGoneStart, unresponsiveStart),
    /if \(intentionalShutdownInProgress\(\)\) return;/
  );
  assert.match(
    mainSource.slice(unresponsiveStart, closeStart),
    /if \(intentionalShutdownInProgress\(\)\) return;/
  );
});
