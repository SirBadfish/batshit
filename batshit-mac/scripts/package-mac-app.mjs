import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldIgnoreNonCodeSigningPath } from './managed-runtime-portability.mjs';

import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { sign } from '@electron/osx-sign';
import { packager } from '@electron/packager';

const macRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronVersion = '43.3.0';
const entitlementsPath = join(macRoot, 'macos.entitlements');
const localEntitlementsPath = join(macRoot, 'macos.local.entitlements');
const childEntitlementsPath = join(macRoot, 'macos.child.entitlements');
const nodeRuntimeEntitlementsPath = join(macRoot, 'macos.node-runtime.entitlements');

export const ELECTRON_SOURCE_FILES = Object.freeze([
  'main.mjs',
  'backup-export-download.mjs',
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

async function stageElectronSource(stagingRoot) {
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  for (const file of ELECTRON_SOURCE_FILES) {
    await cp(join(macRoot, 'src-electron', file), join(stagingRoot, file));
  }
  await cp(join(macRoot, 'frontend', 'dist'), join(stagingRoot, 'shell'), { recursive: true });
  await writeFile(
    join(stagingRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'batshit-electron-shell',
        productName: 'Batshit',
        version: '0.1.0',
        private: true,
        type: 'module',
        main: 'main.mjs'
      },
      null,
      2
    )}\n`
  );
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
  const basename = packageBasename(artifactSuffix);
  const outputRoot = join(macRoot, 'zig-out');
  const output = join(outputRoot, 'package', `${basename}.app`);
  const stagingRoot = join(outputRoot, 'electron-staging', basename);
  const packagerRoot = join(outputRoot, 'electron-packager', basename);

  runChecked('npm', ['install', '--prefix', 'frontend']);
  runChecked('npm', ['--prefix', 'frontend', 'run', 'build']);
  await stageElectronSource(stagingRoot);
  await rm(packagerRoot, { recursive: true, force: true });
  await mkdir(packagerRoot, { recursive: true });

  const packagedPaths = await packager({
    dir: stagingRoot,
    name: 'Batshit',
    platform: 'darwin',
    arch: process.arch,
    out: packagerRoot,
    overwrite: true,
    asar: true,
    prune: true,
    electronVersion,
    icon: join(macRoot, 'assets', 'icon.icns'),
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
  if (packagedPaths.length !== 1) {
    throw new Error(`Electron Packager returned ${packagedPaths.length} package paths; expected exactly one.`);
  }

  const generatedApp = join(packagedPaths[0], 'Batshit.app');
  runChecked(process.execPath, ['scripts/clean-package-output.mjs', output]);
  await mkdir(dirname(output), { recursive: true });
  await rename(generatedApp, output);
  runChecked(process.execPath, ['scripts/prepare-package-resources.mjs', output]);
  await hardenElectronBinary(output);
  await signElectronApp(output);

  const packageJson = JSON.parse(await readFile(join(stagingRoot, 'package.json'), 'utf8'));
  if (packageJson.main !== 'main.mjs') throw new Error('Electron staging package lost its main entrypoint.');
  console.log(`Electron ${electronVersion} Batshit package ready: ${output}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await packageMacApp();
}
