import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldIgnoreNonCodeSigningPath } from './managed-runtime-portability.mjs';

import { sign } from '@electron/osx-sign';

const __dirname = dirname(fileURLToPath(import.meta.url));
const macRoot = resolve(__dirname, '..');
const packageRoot = resolve(macRoot, 'electron-out', 'package');
const defaultAppPath = join(packageRoot, 'Batshit.app');
const defaultDmgPath = join(packageRoot, 'Batshit-0.1.0-macos-ReleaseSafe.dmg');
const defaultStagingRoot = join(packageRoot, 'release-dmg-staging');
const entitlementsPath = join(macRoot, 'macos.entitlements');
const childEntitlementsPath = join(macRoot, 'macos.child.entitlements');
const nodeRuntimeEntitlementsPath = join(macRoot, 'macos.node-runtime.entitlements');

function usage() {
  console.log(`Usage: npm run package:dmg -- [options]

Create a signed, notarized Batshit DMG for public Mac distribution.

Options:
  --app <path>              Source .app bundle. Defaults to ReleaseSafe package output.
  --out <path>              Output .dmg path. Defaults to ReleaseSafe package output.
  --identity <name>         Developer ID Application signing identity.
                            Defaults to BATSHIT_MAC_SIGN_IDENTITY or auto-detect.
  --notary-profile <name>   xcrun notarytool keychain profile.
                            Defaults to BATSHIT_MAC_NOTARY_PROFILE.
  --volume-name <name>      DMG volume name. Defaults to "Batshit".
  --check                   Check release prerequisites without signing or creating a DMG.
  --skip-notarization       Create a signed DMG without notary/staple. Not public-release safe.
  -h, --help                Show this help.

Required public-release prerequisites:
  - Apple Developer Program membership.
  - A valid "Developer ID Application" certificate in this Mac keychain.
  - A stored notarytool keychain profile, for example:
    xcrun notarytool store-credentials "batshit-notary" --apple-id <email> --team-id <team> --password <app-specific-password>
`);
}

function parseArgs(argv) {
  const options = {
    appPath: defaultAppPath,
    dmgPath: defaultDmgPath,
    identity: process.env.BATSHIT_MAC_SIGN_IDENTITY || '',
    notaryProfile: process.env.BATSHIT_MAC_NOTARY_PROFILE || '',
    volumeName: 'Batshit',
    checkOnly: false,
    skipNotarization: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--check') {
      options.checkOnly = true;
    } else if (arg === '--skip-notarization') {
      options.skipNotarization = true;
    } else if (arg === '--app') {
      options.appPath = resolveRequiredValue(argv, ++index, arg);
    } else if (arg === '--out') {
      options.dmgPath = resolveRequiredValue(argv, ++index, arg);
    } else if (arg === '--identity') {
      options.identity = requiredValue(argv, ++index, arg);
    } else if (arg === '--notary-profile') {
      options.notaryProfile = requiredValue(argv, ++index, arg);
    } else if (arg === '--volume-name') {
      options.volumeName = requiredValue(argv, ++index, arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.appPath = resolve(macRoot, options.appPath);
  options.dmgPath = resolve(macRoot, options.dmgPath);
  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function resolveRequiredValue(argv, index, flag) {
  return resolve(macRoot, requiredValue(argv, index, flag));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || macRoot,
    env: options.env || process.env,
    encoding: options.encoding === false ? undefined : 'utf8',
    stdio: options.stdio || 'inherit',
    timeout: options.timeoutMs
  });
  if (result.status !== 0) {
    const suffix = result.error ? `: ${result.error.message}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${suffix}`);
  }
  return result;
}

function runCaptured(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || macRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs || 15000
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    error: result.error
  };
}

async function exists(path) {
  return Boolean(await lstat(path).catch(() => null));
}

async function assertInsidePackageRoot(path, label) {
  const resolved = resolve(path);
  if (resolved !== packageRoot && !resolved.startsWith(`${packageRoot}${sep}`)) {
    throw new Error(`Refusing to write ${label} outside ${packageRoot}: ${resolved}`);
  }
}

function requireExecutable(command) {
  const result = runCaptured('/usr/bin/which', [command]);
  if (!result.ok) {
    throw new Error(`Required command is unavailable: ${command}`);
  }
  return result.stdout.trim();
}

function requireXcrunTool(toolName) {
  const result = runCaptured('xcrun', ['--find', toolName]);
  if (!result.ok || !result.stdout.trim()) {
    throw new Error(`Required Apple tool is unavailable: xcrun ${toolName}`);
  }
  return result.stdout.trim();
}

function findDeveloperIdIdentity() {
  const result = runCaptured('security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!result.ok) {
    throw new Error(`Unable to inspect code-signing identities:\n${result.stderr.trim()}`);
  }
  const match = result.stdout.match(/"([^"]*Developer ID Application:[^"]+)"/);
  return match?.[1] || '';
}

function codesign(path, identity, extraArgs = []) {
  run('codesign', [
    '--force',
    '--options',
    'runtime',
    '--timestamp',
    '--sign',
    identity,
    ...extraArgs,
    path
  ]);
}

function verifyCodesign(path) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', path]);
}

async function signAppBundle(appPath, identity) {
  const mainExecutable = join(appPath, 'Contents', 'MacOS', 'Batshit');
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
  await sign({
    app: appPath,
    platform: 'darwin',
    identity,
    ignore: [shouldIgnoreNonCodeSigningPath],
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    version: '43.3.0',
    optionsForFile(filePath) {
      if (filePath === appPath || filePath === mainExecutable) {
        return { entitlements: entitlementsPath, hardenedRuntime: true };
      }
      if (filePath === managedNodeExecutable) {
        return { entitlements: nodeRuntimeEntitlementsPath, hardenedRuntime: true };
      }
      if (/\((?:GPU|Plugin|Renderer)\)\.app(?:\/|$)/.test(filePath)) return null;
      return { entitlements: childEntitlementsPath, hardenedRuntime: true };
    }
  });
  verifyCodesign(appPath);
}

async function stageApp(appPath) {
  await assertInsidePackageRoot(defaultStagingRoot, 'DMG staging folder');
  await rm(defaultStagingRoot, { recursive: true, force: true });
  await mkdir(defaultStagingRoot, { recursive: true });

  const stagedApp = join(defaultStagingRoot, 'Batshit.app');
  await cp(appPath, stagedApp, { recursive: true, verbatimSymlinks: true });
  await symlink('/Applications', join(defaultStagingRoot, 'Applications'));
  return stagedApp;
}

async function createDmg(stagingRoot, dmgPath, volumeName) {
  await assertInsidePackageRoot(dmgPath, 'DMG output');
  await rm(dmgPath, { force: true });
  await mkdir(dirname(dmgPath), { recursive: true });
  run('hdiutil', [
    'create',
    '-volname',
    volumeName,
    '-srcfolder',
    stagingRoot,
    '-ov',
    '-format',
    'UDZO',
    dmgPath
  ]);
}

function notarizeAndStaple(dmgPath, profile) {
  run('xcrun', [
    'notarytool',
    'submit',
    dmgPath,
    '--keychain-profile',
    profile,
    '--wait'
  ]);
  run('xcrun', ['stapler', 'staple', dmgPath]);
  run('xcrun', ['stapler', 'validate', dmgPath]);
  run('spctl', ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', dmgPath]);
}

function printReadiness(options, identity) {
  console.log('Mac release DMG readiness:');
  console.log(`  App: ${relative(macRoot, options.appPath)}`);
  console.log(`  DMG: ${relative(macRoot, options.dmgPath)}`);
  console.log(`  Signing identity: ${identity || 'missing'}`);
  console.log(`  Notary profile: ${options.skipNotarization ? 'skipped by flag' : options.notaryProfile || 'missing'}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  if (process.platform !== 'darwin') {
    throw new Error('Mac release DMG packaging must run on macOS.');
  }
  if (!(await exists(options.appPath))) {
    throw new Error(`App bundle is missing: ${options.appPath}`);
  }
  if (!(await exists(entitlementsPath))) {
    throw new Error(`Entitlements file is missing: ${entitlementsPath}`);
  }

  requireExecutable('codesign');
  requireExecutable('hdiutil');
  requireXcrunTool('notarytool');
  requireXcrunTool('stapler');

  const identity = options.identity || findDeveloperIdIdentity();
  printReadiness(options, identity);

  const missing = [];
  if (!identity) {
    missing.push('valid Developer ID Application certificate');
  }
  if (!options.skipNotarization && !options.notaryProfile) {
    missing.push('BATSHIT_MAC_NOTARY_PROFILE or --notary-profile');
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing Mac release prerequisite(s): ${missing.join(', ')}.\n` +
        'Create/import the Apple Developer ID Application certificate and store notarytool credentials before cutting the public DMG.'
    );
  }
  if (options.checkOnly) return;

  console.log('==> Staging Batshit.app for release signing');
  const stagedApp = await stageApp(options.appPath);

  console.log('==> Signing Batshit.app with Developer ID');
  await signAppBundle(stagedApp, identity);
  console.log('==> Signed Batshit.app and the complete Electron helper/framework graph');

  console.log('==> Creating DMG');
  await createDmg(defaultStagingRoot, options.dmgPath, options.volumeName);

  console.log('==> Signing DMG');
  codesign(options.dmgPath, identity);
  run('codesign', ['--verify', '--verbose=2', options.dmgPath]);

  if (options.skipNotarization) {
    console.warn('WARNING: --skip-notarization was used. This DMG is not public-release safe.');
  } else {
    console.log('==> Submitting DMG for Apple notarization');
    notarizeAndStaple(options.dmgPath, options.notaryProfile);
  }

  console.log(`==> Release DMG ready: ${options.dmgPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
