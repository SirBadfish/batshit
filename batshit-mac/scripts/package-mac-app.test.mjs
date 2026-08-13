import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ELECTRON_SOURCE_FILES,
  packageBasename,
  parsePackageArgs,
  signingOptionsForFile
} from './package-mac-app.mjs';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));

test('Electron is the one supported Mac package engine', () => {
  assert.deepEqual(parsePackageArgs([]), { artifactSuffix: '' });
  assert.equal(packageBasename(), 'Batshit');
});

test('the isolated review-lane suffix remains supported', () => {
  assert.deepEqual(parsePackageArgs(['-Dartifact-suffix=-SA090-R7']), {
    artifactSuffix: '-SA090-R7'
  });
  assert.equal(packageBasename('-SA090-R7'), 'Batshit-SA090-R7');
});

test('unsafe or unknown package arguments fail closed', () => {
  assert.throws(() => parsePackageArgs(['-Dartifact-suffix=../../bad']), /artifact suffix/);
  assert.throws(() => parsePackageArgs(['--web-engine=system']), /Unknown Mac package argument/);
  assert.throws(() => parsePackageArgs(['--mystery']), /Unknown Mac package argument/);
});

test('the immutable Electron staging inventory includes every required shell module', () => {
  assert.deepEqual(ELECTRON_SOURCE_FILES, [
    'main.mjs',
    'main-window-policy.mjs',
    'preload.cjs',
    'electron-shell-policy.mjs',
    'desktop-controls-contract.mjs',
    'desktop-controls-window-policy.mjs',
    'desktop-controls-window-state.mjs',
    'desktop-controls-window-controller.mjs',
    'desktop-goon-contract.mjs',
    'desktop-goon-window-policy.mjs',
    'desktop-goon-window-state.mjs',
    'desktop-goon-window-controller.mjs'
  ]);
  for (const file of ELECTRON_SOURCE_FILES) {
    assert.equal(fs.existsSync(path.join(scriptsRoot, '..', 'src-electron', file)), true, file);
  }
});

test('release packaging honors the configured Developer ID signing identity', () => {
  const source = fs.readFileSync(path.join(scriptsRoot, 'package-mac-app.mjs'), 'utf8');
  const main = fs.readFileSync(path.join(scriptsRoot, '..', 'src-electron', 'main.mjs'), 'utf8');
  const entitlements = fs.readFileSync(path.join(scriptsRoot, '..', 'macos.entitlements'), 'utf8');
  const localEntitlements = fs.readFileSync(
    path.join(scriptsRoot, '..', 'macos.local.entitlements'),
    'utf8'
  );
  assert.match(source, /process\.env\.MACOS_CODESIGN_IDENTITY/);
  assert.match(source, /process\.env\.BATSHIT_MAC_SIGN_IDENTITY/);
  assert.match(source, /EnableEmbeddedAsarIntegrityValidation/);
  assert.match(source, /OnlyLoadAppFromAsar/);
  assert.match(source, /\[FuseV1Options\.LoadBrowserProcessSpecificV8Snapshot\]: false/);
  assert.match(source, /preAutoEntitlements: false/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /corsEnabled: true/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.doesNotMatch(entitlements, /disable-library-validation/);
  assert.match(localEntitlements, /com\.apple\.security\.cs\.disable-library-validation/);
});

test('local signing gives every Electron process the same library-loading exception', () => {
  const appPath = '/tmp/Batshit.app';
  const mainExecutable = `${appPath}/Contents/MacOS/Batshit`;
  const helperExecutable =
    `${appPath}/Contents/Frameworks/Batshit Helper (Renderer).app/Contents/MacOS/` +
    'Batshit Helper (Renderer)';
  const packagedRedisExecutable =
    `${appPath}/Contents/Resources/runtime/vendor/redis-stack/bin/redis-server`;

  for (const filePath of [appPath, mainExecutable, helperExecutable, packagedRedisExecutable]) {
    const options = signingOptionsForFile(filePath, { appPath, mainExecutable, adHoc: true });
    assert.equal(path.basename(options.entitlements), 'macos.local.entitlements');
    assert.equal(options.hardenedRuntime, true);
    assert.equal(options.timestamp, 'none');
  }

  const releaseHelperOptions = signingOptionsForFile(helperExecutable, {
    appPath,
    mainExecutable,
    adHoc: false
  });
  assert.equal(releaseHelperOptions, null);
});
