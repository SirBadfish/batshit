import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  MAX_GOON_PACKAGE_READ_CHUNK_BYTES,
  MAX_GOON_PACKAGE_SELECTION_BYTES,
  SUPERVISOR_COMMANDS,
  collectAllowedOrigins,
  isAllowedAppUrl,
  isAllowedElectronMediaPermission,
  isAllowedMainWindowUrl,
  isExactDesktopControlsUrl,
  isExactDesktopGoonUrl,
  isSafeExternalUrl,
  normalizeLoopbackOrigin,
  resolveDesktopControlsUrl,
  resolveDesktopGoonUrl,
  resolveShellAssetPath,
  validateElectronIpcSender,
  validateGoonPackageFileSelection,
  validateGoonPackageHandleId,
  validateGoonPackageReadRequest,
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

test('Goon package picker accepts only bounded regular .bgoon and .zip files', () => {
  const regular = (size) => ({ size, isFile: () => true });
  assert.deepEqual(
    validateGoonPackageFileSelection('/tmp/Batshit Base.bgoon', regular(224_700_000)),
    {
      name: 'Batshit Base.bgoon',
      size: 224_700_000,
      mimeType: 'application/zip'
    }
  );
  assert.equal(
    validateGoonPackageFileSelection('/tmp/source.ZIP', regular(100)).name,
    'source.ZIP'
  );
  assert.throws(
    () => validateGoonPackageFileSelection('/tmp/source.glb', regular(100)),
    /must be a \.bgoon or \.zip/
  );
  assert.throws(
    () => validateGoonPackageFileSelection('relative.bgoon', regular(100)),
    /path is invalid/
  );
  assert.throws(
    () => validateGoonPackageFileSelection('/tmp/folder.bgoon', { size: 100, isFile: () => false }),
    /not a regular file/
  );
  assert.throws(
    () => validateGoonPackageFileSelection('/tmp/large.bgoon', regular(MAX_GOON_PACKAGE_SELECTION_BYTES + 1)),
    /exceeds the 1 GB limit/
  );
});

test('Goon package chunk reads are exact, bounded, and tied to opaque handles', () => {
  const handleId = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(validateGoonPackageHandleId(handleId), handleId);
  assert.deepEqual(
    validateGoonPackageReadRequest({ handleId, offset: 4, length: 8 }, 12),
    { handleId, offset: 4, length: 8 }
  );
  assert.throws(() => validateGoonPackageHandleId('/tmp/source.bgoon'), /Invalid/);
  assert.throws(
    () => validateGoonPackageReadRequest({ handleId, offset: 0, length: MAX_GOON_PACKAGE_READ_CHUNK_BYTES + 1 }, 8_000_000),
    /read length/
  );
  assert.throws(
    () => validateGoonPackageReadRequest({ handleId, offset: 5, length: 8 }, 12),
    /exceeds the selected file/
  );
  assert.throws(
    () => validateGoonPackageReadRequest({ handleId, offset: 0, length: 1, path: '/tmp/secret' }, 12),
    /Unsupported/
  );
});

test('external links are limited to browser and email protocols', () => {
  assert.equal(isSafeExternalUrl('https://docs.batshit.ai/'), true);
  assert.equal(isSafeExternalUrl('mailto:help@batshit.ai'), true);
  assert.equal(isSafeExternalUrl('file:///tmp/secret'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
});

test('Desktop Goon URL resolution is exact and never grants its route to the main role', () => {
  const origins = collectAllowedOrigins({ BATSHIT_FRONTEND_PORT: '5650' });
  const desktopUrl = resolveDesktopGoonUrl({ BATSHIT_FRONTEND_PORT: '5650' });
  assert.equal(desktopUrl, 'http://127.0.0.1:5650/desktop-goon');
  assert.equal(isExactDesktopGoonUrl(desktopUrl, desktopUrl), true);
  assert.equal(isExactDesktopGoonUrl(`${desktopUrl}?command=open`, desktopUrl), false);
  assert.equal(isExactDesktopGoonUrl('http://localhost:5650/desktop-goon', desktopUrl), false);
  assert.equal(isAllowedMainWindowUrl('http://127.0.0.1:5650/settings', origins, desktopUrl), true);
  assert.equal(isAllowedMainWindowUrl(desktopUrl, origins, desktopUrl), false);
});

test('Desktop Controls use the exact authenticated app route and never enter main-window authority', () => {
  const origins = collectAllowedOrigins({ BATSHIT_FRONTEND_PORT: '5650' });
  const goonUrl = resolveDesktopGoonUrl({ BATSHIT_FRONTEND_PORT: '5650' });
  const controlsUrl = resolveDesktopControlsUrl({ BATSHIT_FRONTEND_PORT: '5650' });
  assert.equal(controlsUrl, 'http://127.0.0.1:5650/desktop-controls');
  assert.equal(isExactDesktopControlsUrl(controlsUrl, controlsUrl), true);
  assert.equal(isExactDesktopControlsUrl(`${controlsUrl}?intent=return`, controlsUrl), false);
  assert.equal(isExactDesktopControlsUrl('http://localhost:5650/desktop-controls', controlsUrl), false);
  assert.equal(isAllowedMainWindowUrl(controlsUrl, origins, goonUrl, controlsUrl), false);
});

test('native sender validation pins top frame, exact webContents identity, role, and route', () => {
  const origins = collectAllowedOrigins({ BATSHIT_FRONTEND_PORT: '5650' });
  const desktopUrl = resolveDesktopGoonUrl({ BATSHIT_FRONTEND_PORT: '5650' });
  const controlsUrl = resolveDesktopControlsUrl({ BATSHIT_FRONTEND_PORT: '5650' });
  const mainFrame = { url: 'http://127.0.0.1:5650/settings' };
  const mainContents = { id: 10, mainFrame, getURL: () => mainFrame.url };
  const desktopFrame = { url: desktopUrl };
  const desktopContents = { id: 11, mainFrame: desktopFrame, getURL: () => desktopFrame.url };
  const controlsFrame = { url: controlsUrl };
  const controlsContents = { id: 12, mainFrame: controlsFrame, getURL: () => controlsFrame.url };
  const roleRegistry = new Map([
    [10, { role: 'main', webContents: mainContents }],
    [11, { role: 'desktop', webContents: desktopContents }],
    [12, { role: 'controls', webContents: controlsContents }]
  ]);
  assert.equal(
    validateElectronIpcSender(
      { sender: mainContents, senderFrame: mainFrame },
      { allowedOrigins: origins, roleRegistry, allowedRoles: ['main'], desktopUrl, controlsUrl }
    ).role,
    'main'
  );
  assert.equal(
    validateElectronIpcSender(
      { sender: desktopContents, senderFrame: desktopFrame },
      { allowedOrigins: origins, roleRegistry, allowedRoles: ['desktop'], desktopUrl, controlsUrl }
    ).role,
    'desktop'
  );
  assert.equal(
    validateElectronIpcSender(
      { sender: controlsContents, senderFrame: controlsFrame },
      { allowedOrigins: origins, roleRegistry, allowedRoles: ['controls'], desktopUrl, controlsUrl }
    ).role,
    'controls'
  );
  assert.throws(
    () =>
      validateElectronIpcSender(
        { sender: mainContents, senderFrame: { url: mainFrame.url } },
        { allowedOrigins: origins, roleRegistry, allowedRoles: ['main'], desktopUrl, controlsUrl }
      ),
    /non-top-frame/
  );
  desktopFrame.url = 'http://127.0.0.1:5650/settings';
  assert.throws(
    () =>
      validateElectronIpcSender(
        { sender: desktopContents, senderFrame: desktopFrame },
        { allowedOrigins: origins, roleRegistry, allowedRoles: ['desktop'], desktopUrl, controlsUrl }
      ),
    /untrusted sender URL/
  );
});

test('only the registered main window receives audio media permission', () => {
  const origins = collectAllowedOrigins({ BATSHIT_FRONTEND_PORT: '5650' });
  const desktopUrl = resolveDesktopGoonUrl({ BATSHIT_FRONTEND_PORT: '5650' });
  const controlsUrl = resolveDesktopControlsUrl({ BATSHIT_FRONTEND_PORT: '5650' });
  const mainContents = { id: 20, getURL: () => 'http://127.0.0.1:5650/' };
  const desktopContents = { id: 21, getURL: () => desktopUrl };
  const controlsContents = { id: 22, getURL: () => controlsUrl };
  const roleRegistry = new Map([
    [20, { role: 'main', webContents: mainContents }],
    [21, { role: 'desktop', webContents: desktopContents }],
    [22, { role: 'controls', webContents: controlsContents }]
  ]);
  const check = (webContents, permission, mediaTypes) =>
    isAllowedElectronMediaPermission({
      webContents,
      permission,
      details: { mediaTypes },
      roleRegistry,
      allowedOrigins: origins,
      desktopUrl,
      controlsUrl
    });
  assert.equal(check(mainContents, 'media', ['audio']), true);
  assert.equal(check(mainContents, 'media', ['audio', 'video']), false);
  assert.equal(check(mainContents, 'geolocation', []), false);
  assert.equal(check(desktopContents, 'media', ['audio']), false);
  assert.equal(check(controlsContents, 'media', ['audio']), false);
});
