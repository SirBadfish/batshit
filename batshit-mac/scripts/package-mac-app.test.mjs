import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';

import {
  ELECTRON_SOURCE_FILES,
  GOON_PACKAGE_UTI_DECLARATION,
  applyTestPackageInfoPlistNames,
  electronPackagerOptions,
  electronVersion,
  macPackageIdentity,
  packageBasename,
  parsePackageArgs,
  signingOptionsForFile,
  stagedShellPackageJson
} from './package-mac-app.mjs';
import { resolveMacShellIdentity } from '../src-electron/electron-shell-policy.mjs';
import {
  HAIR_CATALOG_PACKAGE_CONTRACT,
  validateHairCatalogPackageDefinition
} from './hair-catalog-package-contract.mjs';

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
    'backup-export-download.mjs',
    'main-window-policy.mjs',
    'main-window-state.mjs',
    'preload.cjs',
    'electron-shell-policy.mjs',
    'local-style-overrides.mjs',
    'desktop-controls-contract.mjs',
    'desktop-controls-window-policy.mjs',
    'desktop-controls-window-state.mjs',
    'desktop-controls-window-controller.mjs',
    'desktop-goon-contract.mjs',
    'desktop-goon-window-policy.mjs',
    'desktop-goon-window-state.mjs',
    'desktop-goon-window-controller.mjs',
    'shutdown-lifecycle.mjs'
  ]);
  for (const file of ELECTRON_SOURCE_FILES) {
    assert.equal(fs.existsSync(path.join(scriptsRoot, '..', 'src-electron', file)), true, file);
  }
});

test('the Mac package declares the proprietary .bgoon archive type', () => {
  assert.deepEqual(GOON_PACKAGE_UTI_DECLARATION, {
    UTTypeIdentifier: 'ai.batshit.goon-package',
    UTTypeDescription: 'Batshit Goon Package',
    UTTypeConformsTo: ['public.zip-archive'],
    UTTypeTagSpecification: {
      'public.filename-extension': ['bgoon'],
      'public.mime-type': ['application/vnd.batshit.goon+zip']
    }
  });
});

test('the Mac package contract carries the complete Hair v2 revision lineage', () => {
  assert.deepEqual(HAIR_CATALOG_PACKAGE_CONTRACT, {
    contract: 'hair-catalog/v2',
    runtimeRoot: 'batshit-app/static/goon-assets/hair',
    definition: 'v2/catalog.json',
    schemaVersion: 'hair-catalog/v2'
  });

  const catalogPath = path.join(
    scriptsRoot,
    '..',
    '..',
    ...HAIR_CATALOG_PACKAGE_CONTRACT.runtimeRoot.split('/'),
    'v2',
    'catalog.json'
  );
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.equal(validateHairCatalogPackageDefinition(catalog), catalog);
  assert.equal(catalog.currentRevisions.length, 2);
  assert.equal(catalog.successorEdges.length, 2);
  assert.deepEqual(
    new Set(catalog.assets.map((asset) => asset.revision)),
    new Set([1, 2])
  );

  assert.throws(
    () =>
      validateHairCatalogPackageDefinition({
        schemaVersion: 'hair-catalog/v1',
        assets: []
      }),
    /invalid hair-catalog\/v2 catalog/
  );
});

test('release packaging honors the configured Developer ID signing identity', () => {
  const source = fs.readFileSync(path.join(scriptsRoot, 'package-mac-app.mjs'), 'utf8');
  const main = fs.readFileSync(path.join(scriptsRoot, '..', 'src-electron', 'main.mjs'), 'utf8');
  const entitlements = fs.readFileSync(path.join(scriptsRoot, '..', 'macos.entitlements'), 'utf8');
  const localEntitlements = fs.readFileSync(
    path.join(scriptsRoot, '..', 'macos.local.entitlements'),
    'utf8'
  );
  const nodeRuntimeEntitlements = fs.readFileSync(
    path.join(scriptsRoot, '..', 'macos.node-runtime.entitlements'),
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
  assert.match(nodeRuntimeEntitlements, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.match(nodeRuntimeEntitlements, /com\.apple\.security\.device\.audio-input/);
});

test('release signing grants third-party native-module loading only to managed Node', () => {
  const appPath = '/tmp/Batshit.app';
  const mainExecutable = `${appPath}/Contents/MacOS/Batshit`;
  const managedNodeExecutable =
    `${appPath}/Contents/Resources/runtime/vendor/node/bin/node`;
  const packagedRedisExecutable =
    `${appPath}/Contents/Resources/runtime/vendor/redis/bin/redis-server`;
  const anchoredReaderExecutable =
    `${appPath}/Contents/Resources/runtime/batshit-app/scripts/anchored-project-reader`;

  const nodeOptions = signingOptionsForFile(managedNodeExecutable, {
    appPath,
    mainExecutable,
    adHoc: false
  });
  const redisOptions = signingOptionsForFile(packagedRedisExecutable, {
    appPath,
    mainExecutable,
    adHoc: false
  });
  const readerOptions = signingOptionsForFile(anchoredReaderExecutable, {
    appPath,
    mainExecutable,
    adHoc: false
  });

  assert.equal(path.basename(nodeOptions.entitlements), 'macos.node-runtime.entitlements');
  assert.equal(path.basename(redisOptions.entitlements), 'macos.child.entitlements');
  assert.equal(path.basename(readerOptions.entitlements), 'macos.child.entitlements');
  assert.equal(nodeOptions.hardenedRuntime, true);
  assert.equal(readerOptions.hardenedRuntime, true);
});

test('local signing gives every Electron process the same library-loading exception', () => {
  const appPath = '/tmp/Batshit.app';
  const mainExecutable = `${appPath}/Contents/MacOS/Batshit`;
  const helperExecutable =
    `${appPath}/Contents/Frameworks/Batshit Helper (Renderer).app/Contents/MacOS/` +
    'Batshit Helper (Renderer)';
  const packagedRedisExecutable =
    `${appPath}/Contents/Resources/runtime/vendor/redis/bin/redis-server`;

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


test('every module the shell imports is staged into the package', () => {
  // A module missing from ELECTRON_SOURCE_FILES is not caught by any build step:
  // packaging succeeds, the audit passes, and the app throws ERR_MODULE_NOT_FOUND
  // on launch. Walk the real import graph from the entrypoint instead.
  const sourceRoot = path.join(scriptsRoot, '..', 'src-electron');
  const staged = new Set(ELECTRON_SOURCE_FILES);
  const seen = new Set();
  const queue = ['main.mjs', 'preload.cjs'];
  const missing = [];

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const filePath = path.join(sourceRoot, file);
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(/(?:from|import|require)\s*\(?\s*['"]\.\/([^'"]+)['"]/g)) {
      const imported = match[1];
      if (!staged.has(imported)) missing.push(`${file} imports ./${imported}`);
      queue.push(imported);
    }
  }

  assert.deepEqual(missing, [], 'these imports would be absent from the packaged app');
});


// BL-72: a package built with --artifact-suffix is its own app. It kept bundle id ai.batshit.mac and
// the name "Batshit", so the first-run lane showed as a second "Batshit" in the Dock, and a quit or
// `open -a Batshit` reached whichever one ran. The real app's identity must not move by a byte.
test('the real app keeps its identity; a test package gets its own', () => {
  assert.deepEqual(macPackageIdentity(''), {
    suffix: '',
    bundleId: 'ai.batshit.mac',
    displayName: 'Batshit',
    dataFolderName: 'Batshit'
  });
  assert.deepEqual(macPackageIdentity('-FirstRunTest'), {
    suffix: '-FirstRunTest',
    bundleId: 'ai.batshit.mac.firstruntest',
    displayName: 'Batshit FirstRunTest',
    dataFolderName: 'Batshit-FirstRunTest'
  });
  assert.equal(macPackageIdentity('-SA090-R7').bundleId, 'ai.batshit.mac.sa090-r7');
  // A bundle id may hold letters, digits, dashes and dots only.
  assert.deepEqual(macPackageIdentity('-my_lane'), {
    suffix: '-my_lane',
    bundleId: 'ai.batshit.mac.my-lane',
    displayName: 'Batshit my_lane',
    dataFolderName: 'Batshit-my_lane'
  });
  for (const bad of ['-', '--x', '-.x', '-x.', '-x..y', 'FirstRunTest']) {
    assert.throws(() => macPackageIdentity(bad), /cannot name a test package/, bad);
  }
});

function packagerOptionsFor(suffix) {
  return electronPackagerOptions(macPackageIdentity(suffix), {
    stagingRoot: '/stage',
    packagerRoot: '/out',
    arch: 'arm64'
  });
}

test('Electron Packager options: the real app exactly as before, a test package only moves its bundle id', () => {
  const macRoot = path.resolve(scriptsRoot, '..');
  const realApp = packagerOptionsFor('');
  assert.deepEqual(realApp, {
    dir: '/stage',
    name: 'Batshit',
    platform: 'darwin',
    arch: 'arm64',
    out: '/out',
    overwrite: true,
    asar: true,
    prune: true,
    electronVersion,
    icon: path.join(macRoot, 'assets', 'icon.icns'),
    appBundleId: 'ai.batshit.mac',
    appCategoryType: 'public.app-category.productivity',
    extendInfo: {
      CFBundleDisplayName: 'Batshit',
      CFBundleName: 'Batshit',
      LSApplicationCategoryType: 'public.app-category.productivity',
      UTExportedTypeDeclarations: [GOON_PACKAGE_UTI_DECLARATION],
      NSMicrophoneUsageDescription:
        'Batshit uses your microphone for speech-to-text, voice mode, and LiveKit voice sessions when you turn voice features on.',
      NSSpeechRecognitionUsageDescription:
        'Batshit uses speech recognition for Browser speech-to-text and Voice Mode when you choose the browser speech engine.'
    }
  });

  const lane = packagerOptionsFor('-FirstRunTest');
  assert.equal(lane.appBundleId, 'ai.batshit.mac.firstruntest');
  // The executable and helper names stay "Batshit": signing, the fuses, and the package audit find them by it.
  assert.equal(lane.name, 'Batshit');
  assert.deepEqual({ ...lane, appBundleId: 'ai.batshit.mac' }, realApp);
});

test('the package is built with the Electron installed here', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(scriptsRoot, '..', 'package.json'), 'utf8'));
  assert.equal(electronVersion, manifest.devDependencies.electron);
  assert.equal(packagerOptionsFor('').electronVersion, electronVersion);
});

test('the staged shell names the app Electron runs as (its Keychain entry and one-instance lock follow it)', () => {
  assert.deepEqual(stagedShellPackageJson(macPackageIdentity('')), {
    name: 'batshit-electron-shell',
    productName: 'Batshit',
    version: '0.1.0',
    private: true,
    type: 'module',
    main: 'main.mjs'
  });
  assert.equal(stagedShellPackageJson(macPackageIdentity('-FirstRunTest')).productName, 'Batshit FirstRunTest');
});

test('the shell reads back the identity the package gave it: same name, same folders', () => {
  for (const suffix of ['', '-FirstRunTest', '-SA090-R7', '-my_lane', '-v1.2']) {
    const identity = macPackageIdentity(suffix);
    const shell = resolveMacShellIdentity({ packaged: true, packagedName: stagedShellPackageJson(identity).productName });
    assert.equal(shell.appName, identity.displayName, suffix);
    assert.equal(shell.dataFolderName, identity.dataFolderName, suffix);
    assert.equal(shell.dataFolderName, packageBasename(suffix), `${suffix}: the folders are named like the .app`);
  }
});

function plistValue(plistPath, key) {
  const result = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', plistPath], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function writeInfoPlist(dir) {
  // What Electron Packager writes for `name: 'Batshit'`: both name keys come from it.
  const plistPath = path.join(dir, 'Contents', 'Info.plist');
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Batshit</string>
  <key>CFBundleExecutable</key>
  <string>Batshit</string>
  <key>CFBundleIdentifier</key>
  <string>ai.batshit.mac.firstruntest</string>
  <key>CFBundleName</key>
  <string>Batshit</string>
</dict>
</plist>
`
  );
  return plistPath;
}

test('a test package changes its display name without breaking Electron helper lookup; the real app is left alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batshit-bl72-plist-'));
  try {
    const lanePlist = writeInfoPlist(path.join(root, 'lane'));
    const helperExecutable = path.join(root, 'lane', 'Contents', 'Frameworks', 'Batshit Helper.app', 'Contents', 'MacOS', 'Batshit Helper');
    fs.mkdirSync(path.dirname(helperExecutable), { recursive: true });
    fs.writeFileSync(helperExecutable, 'packaged helper');
    applyTestPackageInfoPlistNames(path.join(root, 'lane'), macPackageIdentity('-FirstRunTest'));
    assert.equal(plistValue(lanePlist, 'CFBundleDisplayName'), 'Batshit FirstRunTest');
    assert.equal(plistValue(lanePlist, 'CFBundleName'), 'Batshit');
    assert.equal(plistValue(lanePlist, 'CFBundleExecutable'), 'Batshit');
    // Electron 43 resolves this path from CFBundleName before the shell can run.
    const helperName = `${plistValue(lanePlist, 'CFBundleName')} Helper`;
    assert.ok(fs.existsSync(path.join(root, 'lane', 'Contents', 'Frameworks', `${helperName}.app`, 'Contents', 'MacOS', helperName)));

    const realPlist = writeInfoPlist(path.join(root, 'real'));
    const before = createHash('sha256').update(fs.readFileSync(realPlist)).digest('hex');
    applyTestPackageInfoPlistNames(path.join(root, 'real'), macPackageIdentity(''));
    assert.equal(createHash('sha256').update(fs.readFileSync(realPlist)).digest('hex'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packaging applies the identity: options, staged shell, and Info.plist names all come from one', () => {
  const source = fs.readFileSync(path.join(scriptsRoot, 'package-mac-app.mjs'), 'utf8');
  assert.match(source, /\n  const identity = macPackageIdentity\(artifactSuffix\);\n/);
  assert.match(source, /\n  await stageElectronSource\(stagingRoot, identity\);\n/);
  assert.match(source, /\n  const packagedPaths = await packager\(\n    electronPackagerOptions\(identity, \{ stagingRoot, packagerRoot \}\)\n  \);\n/);
  // The names go in before anything signs the bundle.
  const namesAt = source.indexOf('\n  applyTestPackageInfoPlistNames(output, identity);\n');
  assert.ok(namesAt > 0);
  assert.ok(namesAt < source.indexOf('\n  await signElectronApp(output);\n'));
});
