import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  SUPERVISOR_COMMANDS,
  collectAllowedOrigins,
  isAllowedAppUrl,
  isSafeExternalUrl,
  normalizeLoopbackOrigin,
  resolveShellAssetPath,
  validateSaveFileOptions
} from './electron-shell-policy.mjs';

test('only explicit loopback HTTP origins enter the native bridge allowlist', () => {
  assert.equal(normalizeLoopbackOrigin('http://127.0.0.1:5650/path'), 'http://127.0.0.1:5650');
  assert.equal(normalizeLoopbackOrigin('http://localhost:5650'), 'http://localhost:5650');
  for (const value of [
    'https://127.0.0.1:5650',
    'http://evil.example:5650',
    'http://localhost',
    'http://user@localhost:5650',
    'not a url'
  ]) {
    assert.equal(normalizeLoopbackOrigin(value), null);
  }

  const origins = collectAllowedOrigins({
    BATSHIT_FRONTEND_PORT: '5650',
    BATSHIT_MAC_DIRECT_URL: 'http://127.0.0.1:5660/editor'
  });
  assert.equal(isAllowedAppUrl('batshit-shell://app/index.html', origins), true);
  assert.equal(isAllowedAppUrl('http://localhost:5650/settings', origins), true);
  assert.equal(isAllowedAppUrl('http://127.0.0.1:5660/', origins), true);
  assert.equal(isAllowedAppUrl('http://localhost:9999/', origins), false);
});

test('runtime bridge exposes only exact supervisor commands', () => {
  assert.deepEqual(SUPERVISOR_COMMANDS, {
    'batshit.runtime.status': 'status',
    'batshit.runtime.doctor': 'doctor',
    'batshit.runtime.start': 'start',
    'batshit.runtime.stop': 'stop',
    'batshit.runtime.restart': 'restart',
    'batshit.runtime.appleContainerStart': 'apple-container-start'
  });
});

test('packaged shell paths cannot leave the shell asset root', () => {
  const root = '/tmp/batshit-shell';
  assert.equal(resolveShellAssetPath(root, 'batshit-shell://app/'), join(root, 'index.html'));
  assert.equal(
    resolveShellAssetPath(root, 'batshit-shell://app/assets/index.js'),
    join(root, 'assets', 'index.js')
  );
  assert.throws(
    () => resolveShellAssetPath(root, 'batshit-shell://evil/index.html'),
    /only from batshit-shell:\/\/app/
  );
  assert.throws(
    () => resolveShellAssetPath(root, 'batshit-shell://app/assets/%2e%2e/secret'),
    /Invalid shell asset path/
  );
});

test('save dialog bridge rejects capability expansion and malformed values', () => {
  assert.deepEqual(validateSaveFileOptions({ title: 'Save', defaultName: 'backup.zip' }), {
    title: 'Save',
    defaultName: 'backup.zip'
  });
  assert.throws(() => validateSaveFileOptions({ properties: ['createDirectory'] }), /Unsupported/);
  assert.throws(() => validateSaveFileOptions([]), /must be an object/);
  assert.throws(() => validateSaveFileOptions({ title: 'bad\0title' }), /Invalid/);
});

test('external links are limited to browser and email protocols', () => {
  assert.equal(isSafeExternalUrl('https://docs.batshit.ai/'), true);
  assert.equal(isSafeExternalUrl('mailto:help@batshit.ai'), true);
  assert.equal(isSafeExternalUrl('file:///tmp/secret'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
});
