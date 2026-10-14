import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldIgnoreNonCodeSigningPath } from './managed-runtime-portability.mjs';

import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { sign } from '@electron/osx-sign';
import { packager } from '@electron/packager';

const macRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Electron the package is built with; it must be the `electron` devDependency installed here.
export const electronVersion = '43.7.10';
const entitlementsPath = join(macRoot, 'macos.entitlements');
const localEntitlementsPath = join(macRoot, 'macos.local.entitlements');
const childEntitlementsPath = join(macRoot, 'macos.child.entitlements');
const nodeRuntimeEntitlementsPath = join(macRoot, 'macos.node-runtime.entitlements');

export const ELECTRON_SOURCE_FILES = Object.freeze([
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

export const GOON_PACKAGE_UTI_DECLARATION = Object.freeze({
  UTTypeIdentifier: 'ai.batshit.goon-package',
  UTTypeDescription: 'Batshit Goon Package',
  UTTypeConformsTo: ['public.zip-archive'],
  UTTypeTagSpecification: {
    'public.filename-extension': ['bgoon'],
    'public.mime-type': ['application/vnd.batshit.goon+zip']
  }
});

export function parsePackageArgs(argv) {
  let artifactSuffix = '';
  for (const argument of argv) {
    if (argument.startsWith('-Dartifact-suffix=')) {
      artifactSuffix = argument.slice('-Dartifact-suffix='.length);
      continue;
    }
    if (argument.startsWith('--artifact-suffix=')) {
      artifactSuffix = argument.slice('--artifact-suffix='.length);
      continue;
    }
    throw new Error(`Unknown Mac package argument: ${argument}`);
  }
  if (artifactSuffix && !/^-[-A-Za-z0-9._]+$/.test(artifactSuffix)) {
    throw new Error('The artifact suffix must begin with - and contain only letters, numbers, dots, underscores, or hyphens.');
  }
  return { artifactSuffix };
}

export function packageBasename(artifactSuffix = '') {
  return `Batshit${artifactSuffix}`;
}

export const MAC_BUNDLE_ID = 'ai.batshit.mac';
// The real app's name, and the executable and helper names of every package (signing, the fuses,
// and the package audit find the bundle's binaries by it).
export const MAC_APP_NAME = 'Batshit';

/**
 * The app a package is (BL-72). The real app is `ai.batshit.mac`, named "Batshit". A test package
 * built with `--artifact-suffix -<Label>` is its own app: `ai.batshit.mac.<label>` (lower case, `_`
 * as `-`, since a bundle id holds only letters, digits, dashes, and dots), named "Batshit <Label>",
 * with "Batshit-<Label>" folders (`resolveMacShellIdentity` in electron-shell-policy.mjs reads the
 * same rule back from the name). It used to keep the real app's bundle id and name, so it showed as a
 * second "Batshit" in the Dock and a quit or `open -a Batshit` reached whichever one ran.
 */
export function macPackageIdentity(artifactSuffix = '') {
  if (!artifactSuffix) {
    return { suffix: '', bundleId: MAC_BUNDLE_ID, displayName: MAC_APP_NAME, dataFolderName: MAC_APP_NAME };
  }
  const label = artifactSuffix.startsWith('-') ? artifactSuffix.slice(1) : '';
  const bundleSegment = label.toLowerCase().replace(/_/g, '-');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label) || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(bundleSegment)) {
    throw new Error(
      `The artifact suffix ${artifactSuffix} cannot name a test package: use a dash, then letters and numbers (for example -FirstRunTest).`
    );
  }
  return {
    suffix: artifactSuffix,
    bundleId: `${MAC_BUNDLE_ID}.${bundleSegment}`,
    displayName: `${MAC_APP_NAME} ${label}`,
    dataFolderName: `${MAC_APP_NAME}${artifactSuffix}`
  };
}

/** The Electron Packager options for a package. Only the bundle id differs for a test package. */
export function electronPackagerOptions(identity, { stagingRoot, packagerRoot, arch = process.arch }) {
  return {
    dir: stagingRoot,
    name: MAC_APP_NAME,
    platform: 'darwin',
    arch,
    out: packagerRoot,
    overwrite: true,
    asar: true,
    prune: true,
    electronVersion,
    icon: join(macRoot, 'assets', 'icon.icns'),
    appBundleId: identity.bundleId,
    appCategoryType: 'public.app-category.productivity',
    extendInfo: {
      // Packager rewrites these from `name`. Apply the test display name after packaging,
      // keeping CFBundleName fixed: Electron uses it to locate the Batshit Helper executable.
      CFBundleDisplayName: MAC_APP_NAME,
      CFBundleName: MAC_APP_NAME,
      LSApplicationCategoryType: 'public.app-category.productivity',
      UTExportedTypeDeclarations: [GOON_PACKAGE_UTI_DECLARATION],
      NSMicrophoneUsageDescription:
        'Batshit uses your microphone for speech-to-text, voice mode, and LiveKit voice sessions when you turn voice features on.',
      NSSpeechRecognitionUsageDescription:
        'Batshit uses speech recognition for Browser speech-to-text and Voice Mode when you choose the browser speech engine.'
    }
  };
}

/**
 * The shell's package.json. Electron runs as its `productName`: that names the app's menus and its
 * Keychain entry ("<name> Safe Storage"), and main.mjs picks the app's folders (and so its
 * one-instance lock) by it.
 */
export function stagedShellPackageJson(identity) {
  return {
    name: 'batshit-electron-shell',
    productName: identity.displayName,
    version: '0.1.0',
    private: true,
    type: 'module',
    main: 'main.mjs'
  };
}

/** A test package's display name; CFBundleName must match Packager's helper prefix (BL-226). */
export function applyTestPackageInfoPlistNames(appPath, identity) {
  if (identity.bundleId === MAC_BUNDLE_ID) return;
  const plistPath = join(appPath, 'Contents', 'Info.plist');
  runChecked('plutil', ['-replace', 'CFBundleDisplayName', '-string', identity.displayName, plistPath]);
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || macRoot,
    env: options.env || process.env,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

async function stageElectronSource(stagingRoot, identity) {
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  for (const file of ELECTRON_SOURCE_FILES) {
    await cp(join(macRoot, 'src-electron', file), join(stagingRoot, file));
  }
  await cp(join(macRoot, 'frontend', 'dist'), join(stagingRoot, 'shell'), { recursive: true });
  await writeFile(join(stagingRoot, 'package.json'), `${JSON.stringify(stagedShellPackageJson(identity), null, 2)}\n`);
}

export function signingOptionsForFile(filePath, { appPath, mainExecutable, adHoc }) {
  const timestamp = adHoc ? 'none' : undefined;
  if (adHoc) {
    return {
      entitlements: localEntitlementsPath,
      hardenedRuntime: true,
      timestamp
    };
  }
  if (filePath === appPath || filePath === mainExecutable) {
    return {
      entitlements: entitlementsPath,
      hardenedRuntime: true,
      timestamp
    };
  }
  const managedNodeExecutable = join(
    appPath,
    'Contents',
    'Resources',
    'runtime',
    'vendor',
    'node',
    'bin',
    'node'
  );
  if (filePath === managedNodeExecutable) {
    return {
      entitlements: nodeRuntimeEntitlementsPath,
      hardenedRuntime: true,
      timestamp
    };
  }
  if (/\((?:GPU|Plugin|Renderer)\)\.app(?:\/|$)/.test(filePath)) {
    return timestamp ? { timestamp } : null;
  }
  return { entitlements: childEntitlementsPath, hardenedRuntime: true, timestamp };
}

export async function signElectronApp(appPath) {
  appPath = resolve(appPath);
  const identity =
    process.env.MACOS_CODESIGN_IDENTITY?.trim() ||
    process.env.BATSHIT_MAC_SIGN_IDENTITY?.trim() ||
    '-';
  const adHoc = identity === '-';
  const mainExecutable = join(appPath, 'Contents', 'MacOS', 'Batshit');
  await sign({
    app: appPath,
    platform: 'darwin',
    identity,
    identityValidation: !adHoc,
    ignore: [shouldIgnoreNonCodeSigningPath],
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    version: electronVersion,
    optionsForFile(filePath) {
      return signingOptionsForFile(filePath, { appPath, mainExecutable, adHoc });
    }
  });
}

async function hardenElectronBinary(appPath) {
  const executable = join(appPath, 'Contents', 'MacOS', 'Batshit');
  await flipFuses(executable, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true
  });
}

export async function packageMacApp(argv = process.argv.slice(2)) {
  if (process.platform !== 'darwin') throw new Error('The Batshit Mac package must be built on macOS.');
  if (!['arm64', 'x64'].includes(process.arch)) {
    throw new Error(`Unsupported Mac package architecture: ${process.arch}`);
  }

  const { artifactSuffix } = parsePackageArgs(argv);
  const identity = macPackageIdentity(artifactSuffix);
  const basename = packageBasename(artifactSuffix);
  const outputRoot = join(macRoot, 'electron-out');
  const output = join(outputRoot, 'package', `${basename}.app`);
  const stagingRoot = join(outputRoot, 'electron-staging', basename);
  const packagerRoot = join(outputRoot, 'electron-packager', basename);

  runChecked('npm', ['install', '--prefix', 'frontend']);
  runChecked('npm', ['--prefix', 'frontend', 'run', 'build']);
  await stageElectronSource(stagingRoot, identity);
  await rm(packagerRoot, { recursive: true, force: true });
  await mkdir(packagerRoot, { recursive: true });

  const packagedPaths = await packager(
    electronPackagerOptions(identity, { stagingRoot, packagerRoot })
  );
  if (packagedPaths.length !== 1) {
    throw new Error(`Electron Packager returned ${packagedPaths.length} package paths; expected exactly one.`);
  }

  const generatedApp = join(packagedPaths[0], 'Batshit.app');
  runChecked(process.execPath, ['scripts/clean-package-output.mjs', output]);
  await mkdir(dirname(output), { recursive: true });
  await rename(generatedApp, output);
  applyTestPackageInfoPlistNames(output, identity);
  runChecked(process.execPath, ['scripts/prepare-package-resources.mjs', output]);
  await hardenElectronBinary(output);
  await signElectronApp(output);

  const packageJson = JSON.parse(await readFile(join(stagingRoot, 'package.json'), 'utf8'));
  if (packageJson.main !== 'main.mjs') throw new Error('Electron staging package lost its main entrypoint.');
  console.log(`Electron ${electronVersion} Batshit package ready: ${output}`);
}

// Run only when started directly, not when imported. Node gives this module its REAL path, so the
// start path is compared as a real path too: a start through a link (or macOS's /var, a link to
// /private/var) used to exit 0 having done nothing (BL-148).
function startedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (startedDirectly()) {
  await packageMacApp();
}
