import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
  macShellFolderEnv,
  normalizeLoopbackOrigin,
  resolveCustomCssPath,
  resolveDesktopControlsUrl,
  resolveDevToolsEnabled,
  resolveDevToolsOptInPath,
  resolveDesktopGoonUrl,
  resolveBackupExportUrl,
  resolveMacShellIdentity,
  resolveShellAssetPath,
  validateBackupExportOptions,
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

test('backup export bridge accepts only its boolean option and exact local app route', () => {
  assert.deepEqual(validateBackupExportOptions(), { includeSecrets: false });
  assert.deepEqual(validateBackupExportOptions({ includeSecrets: true }), { includeSecrets: true });
  assert.throws(() => validateBackupExportOptions({ url: 'http://localhost:9999' }), /Unsupported/);
  assert.throws(() => validateBackupExportOptions({ includeSecrets: 'yes' }), /must be a boolean/);

  const origins = collectAllowedOrigins({ BATSHIT_FRONTEND_PORT: '5650' });
  const desktopUrl = resolveDesktopGoonUrl({ BATSHIT_FRONTEND_PORT: '5650' });
  const controlsUrl = resolveDesktopControlsUrl({ BATSHIT_FRONTEND_PORT: '5650' });
  assert.equal(
    resolveBackupExportUrl(
      'http://127.0.0.1:5650/settings/admin?tab=backup',
      origins,
      desktopUrl,
      controlsUrl
    ),
    'http://127.0.0.1:5650/api/admin/backup/export'
  );
  assert.throws(
    () => resolveBackupExportUrl('http://localhost:9999/', origins, desktopUrl, controlsUrl),
    /authenticated main Batshit window/
  );
  assert.throws(
    () => resolveBackupExportUrl('batshit-shell://app/index.html', origins, desktopUrl, controlsUrl),
    /local Batshit app origin/
  );
});

// BL-378 Phase 1b: the partial option is bounded here as the app route bounds it, and copied.
test('backup export bridge accepts a bounded partial option and refuses every other shape', () => {
  const entry = { key: 'upload:images:a.png', relativePath: 'images/a.png', fingerprint: 'a'.repeat(64) };
  const input = { includeSecrets: false, partial: { acknowledged: [entry], confirmAllMissing: true } };
  const options = validateBackupExportOptions(input);
  assert.deepEqual(options, { includeSecrets: false, partial: { acknowledged: [entry], confirmAllMissing: true } });
  input.partial.acknowledged[0] = { ...entry, key: 'upload:changed' };
  assert.equal(options.partial.acknowledged[0].key, 'upload:images:a.png');
  assert.deepEqual(validateBackupExportOptions({ partial: { acknowledged: [entry] } }), {
    includeSecrets: false,
    partial: { acknowledged: [entry] }
  });
  // 4,096 UTF-16 code units, as targetPath is measured here, though 12,288 bytes.
  const cjk = '漢'.repeat(4096);
  assert.equal(validateBackupExportOptions({ partial: { acknowledged: [{ ...entry, relativePath: cjk }] } }).partial.acknowledged[0].relativePath, cjk);

  const refused = [
    [null, /partial must be an object/],
    [[entry], /partial must be an object/],
    [{ acknowledged: [entry], skip: true }, /Unsupported backup export partial option: skip/],
    [{ acknowledged: [entry], confirmAllMissing: false }, /confirmAllMissing may only be true/],
    [{ acknowledged: [] }, /1 to 10000/],
    [{ acknowledged: Array.from({ length: 10_001 }, () => entry) }, /1 to 10000/],
    [{ acknowledged: ['upload:images:a.png'] }, /entries must be objects/],
    [{ acknowledged: [{ ...entry, kind: 'missing' }] }, /exactly key, relativePath and fingerprint/],
    [{ acknowledged: [{ ...entry, key: 'k'.repeat(4097) }] }, /partial key is invalid/],
    [{ acknowledged: [{ ...entry, relativePath: 'images/a\0.png' }] }, /partial relativePath is invalid/],
    [{ acknowledged: [{ ...entry, relativePath: `${cjk}漢` }] }, /partial relativePath is invalid/],
    [{ acknowledged: [{ ...entry, fingerprint: 'A'.repeat(64) }] }, /fingerprint is invalid/]
  ];
  for (const [partial, message] of refused) {
    assert.throws(() => validateBackupExportOptions({ includeSecrets: false, partial }), message);
  }
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


test('Electron developer tools stay off unless the local opt-in marker or env flag is present', () => {
  const home = '/Users/tester';
  const marker = resolveDevToolsOptInPath({}, home);
  assert.equal(marker, join(home, 'Library', 'Application Support', 'Batshit', 'enable-devtools'));

  assert.equal(
    resolveDevToolsEnabled({ env: {}, homePath: home, fileExists: () => false }),
    false
  );
  assert.equal(
    resolveDevToolsEnabled({ env: {}, homePath: home, fileExists: (path) => path === marker }),
    true
  );
  assert.equal(
    resolveDevToolsEnabled({
      env: { BATSHIT_MAC_ENABLE_DEVTOOLS: '1' },
      homePath: home,
      fileExists: () => false
    }),
    true
  );
  assert.equal(
    resolveDevToolsEnabled({
      env: { BATSHIT_MAC_ENABLE_DEVTOOLS: '0' },
      homePath: home,
      fileExists: () => true
    }),
    false
  );
});

test('the developer tools opt-in marker follows an overridden Mac data root', () => {
  const env = { BATSHIT_MAC_DATA_DIR: '/tmp/batshit-test-lane' };
  const marker = resolveDevToolsOptInPath(env, '/Users/tester');
  assert.equal(marker, join('/tmp/batshit-test-lane', 'enable-devtools'));
  assert.equal(
    resolveDevToolsEnabled({ env, homePath: '/Users/tester', fileExists: (path) => path === marker }),
    true
  );
  assert.equal(
    resolveDevToolsEnabled({
      env,
      homePath: '/Users/tester',
      fileExists: (path) => path === join('/Users/tester', 'Library', 'Application Support', 'Batshit', 'enable-devtools')
    }),
    false
  );
});


test('the custom stylesheet sits beside the Mac data root and honours an explicit override', () => {
  assert.equal(
    resolveCustomCssPath({}, '/Users/tester'),
    join('/Users/tester', 'Library', 'Application Support', 'Batshit', 'custom.css')
  );
  assert.equal(
    resolveCustomCssPath({ BATSHIT_MAC_DATA_DIR: '/tmp/lane' }, '/Users/tester'),
    join('/tmp/lane', 'custom.css')
  );
  assert.equal(
    resolveCustomCssPath({ BATSHIT_MAC_CUSTOM_CSS: '  /tmp/explicit.css  ' }, '/Users/tester'),
    '/tmp/explicit.css'
  );
});


// BL-72: a test package (rebuild-mac-app.sh --artifact-suffix) names itself "Batshit <Label>" and keeps
// its data, logs, caches, Electron profile, and one-instance lock in "Batshit-<Label>" folders, even
// when it is opened from Finder or the Dock without the lane launcher's environment.
test('the real app and an unpackaged shell are "Batshit"; a test package is its own app', () => {
  const real = { appName: 'Batshit', dataFolderName: 'Batshit', testPackage: false };
  assert.deepEqual(resolveMacShellIdentity({ packaged: true, packagedName: 'Batshit' }), real);
  assert.deepEqual(resolveMacShellIdentity({ packaged: false, packagedName: 'batshit-mac' }), real);
  assert.deepEqual(resolveMacShellIdentity({ packaged: true, packagedName: 'Batshit FirstRunTest' }), {
    appName: 'Batshit FirstRunTest',
    dataFolderName: 'Batshit-FirstRunTest',
    testPackage: true
  });
  // A packaged name that is neither is not guessed at: acting as the real app would share its data.
  for (const name of ['batshit-electron-shell', 'Electron', 'Batshit ', 'Batshit ../x', 'Batshit Two Words', '']) {
    assert.throws(() => resolveMacShellIdentity({ packaged: true, packagedName: name }), /neither Batshit nor a Batshit test package/, name);
  }
});

test('a test package gets its own folders unless its launcher named them; the real app gets none', () => {
  const home = '/Users/tester';
  const lane = resolveMacShellIdentity({ packaged: true, packagedName: 'Batshit FirstRunTest' });
  assert.deepEqual(macShellFolderEnv(lane, {}, home), {
    BATSHIT_MAC_DATA_DIR: join(home, 'Library', 'Application Support', 'Batshit-FirstRunTest'),
    BATSHIT_MAC_LOG_DIR: join(home, 'Library', 'Logs', 'Batshit-FirstRunTest'),
    BATSHIT_MAC_CACHE_DIR: join(home, 'Library', 'Caches', 'Batshit-FirstRunTest')
  });
  // The lane launcher's own folders win.
  assert.deepEqual(macShellFolderEnv(lane, { BATSHIT_MAC_DATA_DIR: '/lane/data' }, home), {
    BATSHIT_MAC_LOG_DIR: join(home, 'Library', 'Logs', 'Batshit-FirstRunTest'),
    BATSHIT_MAC_CACHE_DIR: join(home, 'Library', 'Caches', 'Batshit-FirstRunTest')
  });
  // Opened from Finder, its developer-tools marker and stylesheet sit in its own folder too.
  const env = macShellFolderEnv(lane, {}, home);
  assert.equal(resolveDevToolsOptInPath(env, home), join(home, 'Library', 'Application Support', 'Batshit-FirstRunTest', 'enable-devtools'));
  assert.equal(resolveCustomCssPath(env, home), join(home, 'Library', 'Application Support', 'Batshit-FirstRunTest', 'custom.css'));

  const real = resolveMacShellIdentity({ packaged: true, packagedName: 'Batshit' });
  assert.deepEqual(macShellFolderEnv(real, {}, home), {});
});

test('the shell resolves who it is before anything reads the data folder, and names itself by it', () => {
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'main.mjs'), 'utf8');
  const identityAt = main.indexOf(
    '\nconst shellIdentity = resolveMacShellIdentity({ packaged: app.isPackaged, packagedName: app.getName() });\n'
  );
  const envAt = main.indexOf('\nObject.assign(process.env, macShellFolderEnv(shellIdentity, process.env, homedir()));\n');
  assert.ok(identityAt > 0 && envAt > identityAt);
  for (const reader of [
    '\nconst devToolsEnabled = resolveDevToolsEnabled(',
    '\nconst customCssPath = resolveCustomCssPath(',
    '\napp.setPath(\n  \'userData\','
  ]) {
    const at = main.indexOf(reader);
    assert.ok(at > envAt, `${reader.trim()} comes after the folders are set`);
  }
  assert.ok(main.includes('\napp.setName(shellIdentity.appName);\n'));
  assert.ok(!main.includes("app.setName('Batshit')"));
});
