import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appkitSource = fs.readFileSync(
  path.join(root, 'node_modules', 'zero-native', 'src', 'platform', 'macos', 'appkit_host.m'),
  'utf8'
);
const zigSource = fs.readFileSync(path.join(root, 'src', 'main.zig'), 'utf8');

test('AppKit termination remains responsive until the supervisor completion marker exists', () => {
  assert.match(appkitSource, /BATSHIT_QUIT_LIFECYCLE_ASYNC_V3/);
  assert.match(appkitSource, /return NSTerminateLater;/);
  assert.match(appkitSource, /timerWithTimeInterval:0\.1/);
  assert.match(appkitSource, /addTimer:self\.shutdownCompletionTimer forMode:NSRunLoopCommonModes/);
  assert.match(appkitSource, /replyToApplicationShouldTerminate:YES/);
  assert.match(appkitSource, /replyToApplicationShouldTerminate:NO/);
  assert.match(appkitSource, /timeIntervalSinceNow\] > 120\.0/);
  assert.match(appkitSource, /NSJSONSerialization JSONObjectWithData/);
  assert.match(appkitSource, /payload\[@"ok"\]/);
  assert.match(appkitSource, /shutdown-complete\.json/);
  assert.match(appkitSource, /disconnectWebViewsForShutdown/);
});

test('last-window closure enters the same terminate-later path', () => {
  assert.match(
    appkitSource,
    /if \(self\.host\.windows\.count == 0\) \{\s*\[NSApp terminate:nil\];\s*\}/
  );
  assert.doesNotMatch(appkitSource, /dispatch_async\(dispatch_get_main_queue\(\), \^\{\s*\[host emitShutdown\]/);
});

test('the Zig lifecycle callback starts supervisor stop on a joined background worker', () => {
  assert.match(zigSource, /std\.Thread\.spawn\(\.\{\}, stopSupervisorInBackground/);
  assert.doesNotMatch(zigSource, /thread\.detach\(\);/);
  assert.match(zigSource, /defer if \(app\.shutdown_thread\) \|thread\| thread\.join\(\);/);
  const stopBody = zigSource.slice(
    zigSource.indexOf('fn stop(context:'),
    zigSource.indexOf('fn stopSupervisorInBackground')
  );
  assert.doesNotMatch(stopBody, /runSupervisor\("stop"/);
});

test('patch upgrades a legacy delegate-based quit lifecycle source', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batshit-zero-native-upgrade-'));
  const fixtureHost = path.join(fixtureRoot, 'appkit_host.m');
  const fixtureHeader = path.join(fixtureRoot, 'appkit_host.h');
  const fixtureCef = path.join(fixtureRoot, 'cef_host.mm');
  fs.writeFileSync(
    fixtureHost,
    appkitSource.replace(
      'BATSHIT_QUIT_LIFECYCLE_ASYNC_V3',
      'BATSHIT_QUIT_LIFECYCLE: legacy fixture'
    )
  );
  fs.copyFileSync(
    path.join(root, 'node_modules', 'zero-native', 'src', 'platform', 'macos', 'appkit_host.h'),
    fixtureHeader
  );
  fs.copyFileSync(
    path.join(root, 'node_modules', 'zero-native', 'src', 'platform', 'macos', 'cef_host.mm'),
    fixtureCef
  );

  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'patch-zero-native.mjs')], {
    env: {
      ...process.env,
      BATSHIT_ZERO_NATIVE_APPKIT_HOST_PATH: fixtureHost,
      BATSHIT_ZERO_NATIVE_APPKIT_HEADER_PATH: fixtureHeader,
      BATSHIT_ZERO_NATIVE_CEF_HOST_PATH: fixtureCef
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(fs.readFileSync(fixtureHost, 'utf8'), /BATSHIT_QUIT_LIFECYCLE_ASYNC_V3/);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});
