import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readlink,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inspectManagedRuntimePortability,
  isMachOFile,
  MAC_RUNTIME_MINIMUM_VERSION,
  parseOtoolInstallName,
  parseOtoolLibraries
} from './managed-runtime-portability.mjs';
import { inspectFfmpegRuntimeCapabilities } from './ffmpeg-runtime-capabilities.mjs';
import {
  assertRedisRuntimeUsable,
  curateRedisMacosArchive,
  REDIS_BUNDLED_BINARIES,
  REDIS_BUNDLED_MODULES,
  REDIS_MACOS_PINNED_ARCHIVE_SHA256,
  REDIS_PINNED_VERSION,
  redisMacosArchive,
  relinkAndSignRedisMacosRuntime
} from './redis-runtime.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const macRoot = resolve(__dirname, '..');
const repoRoot = resolve(macRoot, '..');

const nodeVersion = process.env.BATSHIT_MAC_NODE_VERSION || '24.21.0';
const redisVersion = process.env.BATSHIT_MAC_REDIS_VERSION || '8.10.1';
const ffmpegVersion = process.env.BATSHIT_MAC_FFMPEG_VERSION || '8.1.2';
const dav1dVersion = '1.5.4';
const dav1dArchiveSha256 = '686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5';
const dav1dInstallPrefix = '/opt/batshit/dav1d';
const opensslVersion = process.env.BATSHIT_MAC_OPENSSL_VERSION || '3.5.7';
const minimumMacosVersion =
  process.env.BATSHIT_MAC_MINIMUM_VERSION || MAC_RUNTIME_MINIMUM_VERSION;
const ffmpegInstallPrefix = process.env.BATSHIT_MAC_FFMPEG_INSTALL_PREFIX || '/opt/batshit/ffmpeg';
const opensslInstallPrefix =
  process.env.BATSHIT_MAC_OPENSSL_INSTALL_PREFIX || '/opt/batshit/openssl';
const root = resolve(process.env.BATSHIT_MAC_RUNTIME_ASSET_ROOT || join(repoRoot, '_local', 'mac-managed-runtimes'));
const downloadsRoot = resolve(process.env.BATSHIT_MAC_RUNTIME_DOWNLOADS_DIR || join(root, 'downloads'));
const buildRoot = resolve(process.env.BATSHIT_MAC_RUNTIME_BUILD_DIR || join(root, 'build'));
const assetsRoot = resolve(process.env.BATSHIT_MAC_RUNTIME_ASSETS_DIR || join(root, 'assets'));

const nodeFilename = `node-v${nodeVersion}-darwin-arm64.tar.xz`;
const nodeBaseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
const nodeArchiveUrl = `${nodeBaseUrl}/${nodeFilename}`;
const nodeShasumsUrl = `${nodeBaseUrl}/SHASUMS256.txt`;
// SA-101 / DL-101-03: the Redis archive is pinned by exact SHA-256 (redis-runtime.mjs, shared
// with the Pinokio launcher). Bumping BATSHIT_MAC_REDIS_VERSION without also supplying the
// matching BATSHIT_MAC_REDIS_ARCHIVE_SHA256 is refused rather than silently unpinned.
const { filename: redisFilename, url: redisArchiveUrl } = redisMacosArchive(redisVersion);
// Redis 8's macOS archive ships no licence files, so the tri-licence text and the retained
// BSD-3-Clause contributions notice are fetched from the matching immutable release tag.
const redisLicenseBaseUrl = `https://raw.githubusercontent.com/redis/redis/${redisVersion}`;
const REDIS_LICENSE_FILES = [
  { filename: 'LICENSE.txt', sha256: '4a0e416b9537688f30dfe69ddaceb2ca64d96b7df02a0a6760d376890ddc4e40' },
  { filename: 'REDISCONTRIBUTIONS.txt', sha256: 'aa6a56234e5ca27f09010693d1c31ca83988d7a0dc80fb253603e052d1d7f0d1' }
];
const ffmpegFilename = `ffmpeg-${ffmpegVersion}.tar.xz`;
const ffmpegArchiveUrl = `https://ffmpeg.org/releases/${ffmpegFilename}`;
const dav1dFilename = `dav1d-${dav1dVersion}.tar.xz`;
const dav1dArchiveUrl = `https://download.videolan.org/pub/videolan/dav1d/${dav1dVersion}/${dav1dFilename}`;
const opensslFilename = `openssl-${opensslVersion}.tar.gz`;
const opensslArchiveUrl = `https://www.openssl.org/source/${opensslFilename}`;
const opensslSha256Url = `${opensslArchiveUrl}.sha256`;

const options = parseArgs(process.argv.slice(2));
let preparedOpenSslPath = null;

function parseArgs(args) {
  const parsed = {
    force: false,
    only: new Set()
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--only') {
      const value = args[index + 1];
      if (!value) throw new Error('--only requires node, redis, openssl, ffmpeg, or all.');
      index += 1;
      for (const item of value.split(',').map((entry) => entry.trim()).filter(Boolean)) {
        parsed.only.add(item);
      }
    } else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage: node scripts/prepare-managed-runtime-assets.mjs [--force] [--only node,redis,openssl,ffmpeg]

Prepares redistributable Mac runtime asset folders under:
  ${assetsRoot}

Environment overrides:
  BATSHIT_MAC_NODE_VERSION=${nodeVersion}
  BATSHIT_MAC_REDIS_VERSION=${redisVersion}
  BATSHIT_MAC_REDIS_ARCHIVE_SHA256=<pinned for ${REDIS_PINNED_VERSION}; required when overriding the version>
  BATSHIT_MAC_OPENSSL_VERSION=${opensslVersion}
  BATSHIT_MAC_FFMPEG_VERSION=${ffmpegVersion}
  BATSHIT_MAC_MINIMUM_VERSION=${minimumMacosVersion}
  BATSHIT_MAC_FFMPEG_INSTALL_PREFIX=${ffmpegInstallPrefix}
  BATSHIT_MAC_RUNTIME_ASSET_ROOT=${root}
`);
}

async function exists(path) {
  return Boolean(await stat(path).catch(() => null));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.\n${output}`);
  }
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function log(message) {
  console.log(`[managed-runtimes] ${message}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function ensureTool(command) {
  const result = spawnSync('/bin/sh', ['-lc', `command -v ${shellQuote(command)}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    throw new Error(`Required command is missing: ${command}`);
  }
}

async function sha256(filePath) {
  const result = run('shasum', ['-a', '256', filePath]);
  return result.stdout.trim().split(/\s+/)[0];
}

async function download(url, dest) {
  await mkdir(dirname(dest), { recursive: true });
  if ((await exists(dest)) && !options.force) {
    log(`Using cached download: ${dest}`);
    return;
  }
  const temp = `${dest}.tmp`;
  await rm(temp, { force: true });
  log(`Downloading ${url}`);
  run('curl', ['-L', '--fail', '--show-error', '--output', temp, url], {
    stdio: ['ignore', 'inherit', 'inherit']
  });
  await rm(dest, { force: true });
  await cp(temp, dest);
  await rm(temp, { force: true });
}

async function resetDir(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

async function copyDir(source, dest, { dereference = true } = {}) {
  await rm(dest, { recursive: true, force: true });
  await cp(source, dest, {
    recursive: true,
    dereference,
    verbatimSymlinks: !dereference
  });
}

async function hasPortableSymlink(rootDir, command) {
  const commandPath = join(rootDir, 'bin', command);
  const commandInfo = await lstat(commandPath).catch(() => null);
  if (!commandInfo?.isSymbolicLink()) return false;
  const target = await readlink(commandPath).catch(() => '');
  if (!target || isAbsolute(target)) return false;
  const relativeTarget = relative(rootDir, resolve(dirname(commandPath), target));
  return relativeTarget !== '' && !relativeTarget.startsWith('..') && !isAbsolute(relativeTarget);
}

async function findDirContaining(base, relativeFile) {
  if (await exists(join(base, relativeFile))) return base;
  const entries = await readdir(base, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(base, entry.name);
    if (await exists(join(candidate, relativeFile))) return candidate;
  }
  throw new Error(`Could not find ${relativeFile} under ${base}`);
}

async function writeText(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${content.trim()}\n`);
}

function shouldRun(name) {
  return options.only.size === 0 || options.only.has('all') || options.only.has(name);
}

async function assertNodeShasum(shasumsPath, archivePath) {
  const expectedLine = (await readFile(shasumsPath, 'utf8'))
    .split(/\r?\n/)
    .find((line) => line.endsWith(`  ${nodeFilename}`) || line.endsWith(` *${nodeFilename}`));
  if (!expectedLine) {
    throw new Error(`Node SHASUMS256.txt does not include ${nodeFilename}`);
  }
  const expected = expectedLine.trim().split(/\s+/)[0];
  const actual = await sha256(archivePath);
  if (expected !== actual) {
    throw new Error(`Node checksum mismatch for ${nodeFilename}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

async function assertSingleFileShasum(shasumsPath, archivePath, filename) {
  const expectedLine = (await readFile(shasumsPath, 'utf8'))
    .split(/\r?\n/)
    .find((line) => line.includes(filename));
  const expected = expectedLine?.match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase();
  if (!expected) throw new Error(`Checksum file does not include ${filename}`);
  const actual = await sha256(archivePath);
  if (expected !== actual) {
    throw new Error(`Checksum mismatch for ${filename}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

function runCaptured(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}.\n${
        result.stderr || result.stdout || result.error?.message || ''
      }`.trim()
    );
  }
  return result.stdout || '';
}

async function collectMachOFiles(rootDir) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && (await isMachOFile(path))) {
        files.push(path);
      }
    }
  }
  await walk(rootDir);
  return files;
}

async function adHocSignMachOFiles(rootDir) {
  for (const file of await collectMachOFiles(rootDir)) {
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
  }
}

async function assertPortableRuntime(rootDir, label) {
  const result = await inspectManagedRuntimePortability(rootDir, {
    maximumMinimumVersion: minimumMacosVersion
  });
  if (!result.ok) {
    throw new Error(`${label} is not clean-machine portable:\n- ${result.issues.join('\n- ')}`);
  }
  return result;
}

async function prepareNode() {
  const dest = join(assetsRoot, 'node');
  if (!options.force && (await exists(join(dest, 'bin', 'node'))) && (await exists(join(dest, 'SOURCE.txt')))) {
    let npmReady = false;
    let versionReady = false;
    const source = await readFile(join(dest, 'SOURCE.txt'), 'utf8');
    const sourceReady = source.includes(`Node.js ${nodeVersion} macOS arm64 runtime for Batshit.app.\n`) &&
      source.includes(`Official archive: ${nodeArchiveUrl}\n`);
    try {
      versionReady = runCaptured(join(dest, 'bin', 'node'), ['--version']).trim() === `v${nodeVersion}`;
    } catch {
      versionReady = false;
    }
    if ((await hasPortableSymlink(dest, 'npm')) && (await hasPortableSymlink(dest, 'npx'))) {
      try {
        npmReady = Boolean(
          runCaptured(join(dest, 'bin', 'node'), [join(dest, 'bin', 'npm'), '--version']).trim()
        );
      } catch {
        npmReady = false;
      }
    }
    if (sourceReady && versionReady && npmReady) {
      log(`Node runtime already prepared: ${dest}`);
      return dest;
    }
    log('Rebuilding cached Node runtime because its source, version, or npm/npx launcher links are invalid.');
  }

  const archive = join(downloadsRoot, nodeFilename);
  const shasums = join(downloadsRoot, `node-v${nodeVersion}-SHASUMS256.txt`);
  await download(nodeArchiveUrl, archive);
  await download(nodeShasumsUrl, shasums);
  const archiveSha = await assertNodeShasum(shasums, archive);

  const extractRoot = join(buildRoot, 'node-extract');
  await resetDir(extractRoot);
  run('tar', ['-xJf', archive, '-C', extractRoot], { stdio: 'inherit' });
  const sourceDir = await findDirContaining(extractRoot, 'bin/node');
  const sourceVersion = runCaptured(join(sourceDir, 'bin', 'node'), ['--version']).trim();
  if (sourceVersion !== `v${nodeVersion}`) {
    throw new Error(`Downloaded Node runtime version mismatch: expected v${nodeVersion}, got ${sourceVersion || '(empty)'}.`);
  }
  await copyDir(sourceDir, dest, { dereference: false });
  const preparedVersion = runCaptured(join(dest, 'bin', 'node'), ['--version']).trim();
  if (preparedVersion !== `v${nodeVersion}`) {
    throw new Error(`Prepared Node runtime version mismatch: expected v${nodeVersion}, got ${preparedVersion || '(empty)'}.`);
  }
  if (!(await hasPortableSymlink(dest, 'npm')) || !(await hasPortableSymlink(dest, 'npx'))) {
    throw new Error('Prepared Node runtime must preserve the official relative npm and npx symlinks.');
  }
  const npmVersion = runCaptured(join(dest, 'bin', 'node'), [join(dest, 'bin', 'npm'), '--version']).trim();
  if (!npmVersion) {
    throw new Error('Prepared Node runtime npm launcher did not report a version.');
  }
  await cp(shasums, join(dest, 'SHASUMS256.txt'));
  await writeText(
    join(dest, 'SOURCE.txt'),
    `
Node.js ${nodeVersion} macOS arm64 runtime for Batshit.app.
Official archive: ${nodeArchiveUrl}
Official checksum list: ${nodeShasumsUrl}
Archive SHA256: ${archiveSha}
Prepared: ${new Date().toISOString()}
`
  );
  await writeText(
    join(dest, 'CHECKSUMS.txt'),
    `
${archiveSha}  ${nodeFilename}
`
  );
  log(`Prepared Node runtime: ${dest}`);
  return dest;
}

async function prepareOpenSsl() {
  const dest = join(assetsRoot, 'openssl');
  if (preparedOpenSslPath === dest) return dest;
  const required = [
    join(dest, 'lib', 'libssl.3.dylib'),
    join(dest, 'lib', 'libcrypto.3.dylib'),
    join(dest, 'LICENSE.txt'),
    join(dest, 'SOURCE.txt')
  ];
  if (!options.force && (await Promise.all(required.map(exists))).every(Boolean)) {
    const portability = await inspectManagedRuntimePortability(dest, {
      maximumMinimumVersion: minimumMacosVersion
    });
    if (portability.ok) {
      log(`OpenSSL runtime already prepared: ${dest}`);
      preparedOpenSslPath = dest;
      return dest;
    }
    log(`Rebuilding non-portable cached OpenSSL runtime: ${portability.issues.join('; ')}`);
  }

  const archive = join(downloadsRoot, opensslFilename);
  const shasums = join(downloadsRoot, `${opensslFilename}.sha256`);
  await download(opensslArchiveUrl, archive);
  await download(opensslSha256Url, shasums);
  const archiveSha = await assertSingleFileShasum(shasums, archive, opensslFilename);

  const extractRoot = join(buildRoot, 'openssl-extract');
  await resetDir(extractRoot);
  run('tar', ['-xzf', archive, '-C', extractRoot], { stdio: 'inherit' });
  const sourceDir = await findDirContaining(extractRoot, 'Configure');
  const buildEnv = { ...process.env, MACOSX_DEPLOYMENT_TARGET: minimumMacosVersion };
  const configureArgs = [
    'darwin64-arm64-cc',
    'shared',
    'no-tests',
    'no-docs',
    `--prefix=${opensslInstallPrefix}`,
    `--openssldir=${opensslInstallPrefix}/ssl`
  ];
  log(`Configuring OpenSSL ${opensslVersion} for macOS ${minimumMacosVersion}+`);
  run('./Configure', configureArgs, { cwd: sourceDir, env: buildEnv, stdio: 'inherit' });
  log('Building the Batshit-owned OpenSSL runtime.');
  run('make', ['-j', String(Math.max(1, Math.min(cpus().length, 8)))], {
    cwd: sourceDir,
    env: buildEnv,
    stdio: 'inherit'
  });

  await resetDir(dest);
  await mkdir(join(dest, 'lib'), { recursive: true });
  for (const library of ['libssl.3.dylib', 'libcrypto.3.dylib']) {
    const target = join(dest, 'lib', library);
    await cp(join(sourceDir, library), target);
    await chmod(target, 0o755);
    run('install_name_tool', ['-id', `@rpath/${library}`, target]);
  }
  const sslPath = join(dest, 'lib', 'libssl.3.dylib');
  const sslInstallName = parseOtoolInstallName(runCaptured('otool', ['-D', sslPath]));
  for (const dependency of parseOtoolLibraries(runCaptured('otool', ['-L', sslPath]))) {
    if (dependency === sslInstallName || !dependency.endsWith('/libcrypto.3.dylib')) continue;
    run('install_name_tool', [
      '-change',
      dependency,
      '@loader_path/libcrypto.3.dylib',
      sslPath
    ]);
  }
  await cp(join(sourceDir, 'LICENSE.txt'), join(dest, 'LICENSE.txt'));
  await adHocSignMachOFiles(dest);
  await assertPortableRuntime(dest, 'OpenSSL runtime');

  const sslSha = await sha256(sslPath);
  const cryptoSha = await sha256(join(dest, 'lib', 'libcrypto.3.dylib'));
  await writeText(
    join(dest, 'SOURCE.txt'),
    `
OpenSSL ${opensslVersion} LTS runtime for Batshit.app.
Official source archive: ${opensslArchiveUrl}
Official checksum: ${opensslSha256Url}
Archive SHA256: ${archiveSha}
Minimum macOS: ${minimumMacosVersion}
Prepared: ${new Date().toISOString()}
`
  );
  await writeText(
    join(dest, 'CHECKSUMS.txt'),
    `
${archiveSha}  ${opensslFilename}
${sslSha}  lib/libssl.3.dylib
${cryptoSha}  lib/libcrypto.3.dylib
`
  );
  log(`Prepared OpenSSL runtime: ${dest}`);
  preparedOpenSslPath = dest;
  return dest;
}

function resolveRedisArchiveSha256() {
  const override = process.env.BATSHIT_MAC_REDIS_ARCHIVE_SHA256?.trim().toLowerCase();
  if (override) {
    if (!/^[a-f0-9]{64}$/.test(override)) {
      throw new Error('BATSHIT_MAC_REDIS_ARCHIVE_SHA256 must be a 64-character hex SHA-256.');
    }
    return override;
  }
  if (redisVersion !== REDIS_PINNED_VERSION) {
    throw new Error(
      `Redis ${redisVersion} has no pinned checksum. The pinned version is ${REDIS_PINNED_VERSION}. ` +
        'Set BATSHIT_MAC_REDIS_ARCHIVE_SHA256 to the arm64 hash published by the redis/homebrew-redis ' +
        'cask for that version, or update REDIS_PINNED_VERSION/REDIS_PINNED_ARCHIVE_SHA256 together.'
    );
  }
  return REDIS_MACOS_PINNED_ARCHIVE_SHA256;
}

async function assertExpectedSha256(filePath, expected, label) {
  const actual = await sha256(filePath);
  if (actual !== expected.toLowerCase()) {
    // Remove the bad file so a retry re-downloads rather than failing on the same cached
    // bytes forever. The throw is still the loud part.
    await rm(filePath, { force: true });
    throw new Error(
      `${label} checksum mismatch: expected ${expected}, got ${actual}. The downloaded file was discarded.`
    );
  }
  return actual;
}

async function prepareRedis() {
  const dest = join(assetsRoot, 'redis');
  const openssl = await prepareOpenSsl();
  const required = [
    ...REDIS_BUNDLED_BINARIES.map((name) => join(dest, 'bin', name)),
    ...REDIS_BUNDLED_MODULES.map((name) => join(dest, 'lib', name)),
    join(dest, 'lib', 'libssl.3.dylib'),
    join(dest, 'lib', 'libcrypto.3.dylib'),
    ...REDIS_LICENSE_FILES.map((entry) => join(dest, 'share', 'redis', entry.filename)),
    join(dest, 'share', 'openssl', 'LICENSE.txt'),
    join(dest, 'share', 'openssl', 'SOURCE.txt'),
    join(dest, 'SOURCE.txt')
  ];
  if (!options.force && (await Promise.all(required.map(exists))).every(Boolean)) {
    // A cached asset must also be the version that was asked for. Without this, bumping
    // BATSHIT_MAC_REDIS_VERSION silently reuses the previously prepared build and the pin
    // means nothing.
    const cachedSource = await readFile(join(dest, 'SOURCE.txt'), 'utf8').catch(() => '');
    const cachedVersion = cachedSource.match(/^Redis Open Source (\S+)/m)?.[1];
    if (cachedVersion !== redisVersion) {
      log(
        `Rebuilding cached Redis runtime: prepared version ${cachedVersion || 'unknown'} does not match requested ${redisVersion}`
      );
    } else {
      const portability = await inspectManagedRuntimePortability(dest, {
        maximumMinimumVersion: minimumMacosVersion
      });
      if (portability.ok) {
        log(`Redis runtime already prepared: ${dest} (${cachedVersion})`);
        return dest;
      }
      log(`Rebuilding non-portable cached Redis runtime: ${portability.issues.join('; ')}`);
    }
  }

  // Resolve the pin before downloading, so a version bump without a matching checksum
  // fails immediately instead of after a 14 MB fetch.
  const expectedArchiveSha = resolveRedisArchiveSha256();
  const archive = join(downloadsRoot, redisFilename);
  await download(redisArchiveUrl, archive);
  const archiveSha = await assertExpectedSha256(archive, expectedArchiveSha, redisFilename);

  const extractRoot = join(buildRoot, 'redis-extract');
  await resetDir(extractRoot);
  run('unzip', ['-q', archive, '-d', extractRoot], { stdio: 'inherit' });
  const sourceDir = await findDirContaining(extractRoot, 'bin/redis-server');

  // Curate only the binaries and modules Batshit runs, with the modules flattened into lib/.
  await resetDir(dest);
  await curateRedisMacosArchive(sourceDir, dest);

  await cp(join(openssl, 'lib', 'libssl.3.dylib'), join(dest, 'lib', 'libssl.3.dylib'));
  await cp(join(openssl, 'lib', 'libcrypto.3.dylib'), join(dest, 'lib', 'libcrypto.3.dylib'));
  const opensslShare = join(dest, 'share', 'openssl');
  await mkdir(opensslShare, { recursive: true });
  for (const filename of ['LICENSE.txt', 'SOURCE.txt', 'CHECKSUMS.txt']) {
    await cp(join(openssl, filename), join(opensslShare, filename));
  }

  // The Redis 8 macOS archive ships no licence files at all, unlike the retired Redis Stack
  // archive that supplied RSALv2.txt and SSPLv1.txt. Fetch the tri-licence text from the
  // matching release tag so the packaged app still carries Redis's own notices.
  const redisShare = join(dest, 'share', 'redis');
  await mkdir(redisShare, { recursive: true });
  const licenseChecksums = [];
  for (const entry of REDIS_LICENSE_FILES) {
    const downloaded = join(downloadsRoot, `redis-${redisVersion}-${entry.filename}`);
    await download(`${redisLicenseBaseUrl}/${entry.filename}`, downloaded);
    const sha =
      redisVersion === REDIS_PINNED_VERSION
        ? await assertExpectedSha256(downloaded, entry.sha256, `Redis ${entry.filename}`)
        : await sha256(downloaded);
    await cp(downloaded, join(redisShare, entry.filename));
    licenseChecksums.push(`${sha}  share/redis/${entry.filename}`);
  }

  await relinkAndSignRedisMacosRuntime(dest);
  await assertPortableRuntime(dest, 'Redis runtime');
  await assertRedisRuntimeUsable(dest, join(buildRoot, 'redis-probe'), log);

  const binaryChecksums = [];
  for (const relative of [
    ...REDIS_BUNDLED_BINARIES.map((name) => `bin/${name}`),
    ...REDIS_BUNDLED_MODULES.map((name) => `lib/${name}`),
    'lib/libssl.3.dylib',
    'lib/libcrypto.3.dylib'
  ]) {
    binaryChecksums.push(`${await sha256(join(dest, relative))}  ${relative}`);
  }

  await writeText(
    join(dest, 'SOURCE.txt'),
    `
Redis Open Source ${redisVersion} macOS arm64 runtime for Batshit.app.
Official archive: ${redisArchiveUrl}
Archive SHA256: ${archiveSha} (pinned, verified at preparation time)
Bundled modules: ${REDIS_BUNDLED_MODULES.join(', ')} (flattened into lib/)
Bundled binaries: ${REDIS_BUNDLED_BINARIES.join(', ')}
Licence: tri-licensed RSALv2 / SSPLv1 / AGPLv3 - see share/redis/LICENSE.txt
Licence source: ${redisLicenseBaseUrl}
Bundled OpenSSL runtime: ${opensslVersion} LTS
Loader rewrites: Homebrew OpenSSL -> bundled @loader_path copies; llvm@18 libunwind -> /usr/lib/libSystem.B.dylib
Minimum macOS: ${minimumMacosVersion}
Prepared: ${new Date().toISOString()}
`
  );
  await writeText(
    join(dest, 'CHECKSUMS.txt'),
    `
${archiveSha}  ${redisFilename}
${licenseChecksums.join('\n')}
${binaryChecksums.join('\n')}
`
  );
  log(`Prepared Redis runtime: ${dest}`);
  return dest;
}

async function copyFfmpegLicenseFiles(sourceDir, dest) {
  const entries = await readdir(sourceDir);
  for (const entry of entries) {
    if (entry === 'LICENSE' || entry === 'LICENSE.md' || entry.startsWith('COPYING')) {
      await cp(join(sourceDir, entry), join(dest, entry));
    }
  }
}

async function assertCleanFfmpegBuild(runtimeRoot) {
  const capabilities = await inspectFfmpegRuntimeCapabilities(runtimeRoot);
  if (!capabilities.ok) {
    throw new Error(`Built FFmpeg does not satisfy the Mac media contract:\n- ${capabilities.issues.join('\n- ')}`);
  }
  return capabilities;
}

async function prepareDav1d() {
  for (const command of ['meson', 'ninja', 'pkg-config']) await ensureTool(command);
  const archive = join(downloadsRoot, dav1dFilename);
  await download(dav1dArchiveUrl, archive);
  const actualSha = await sha256(archive);
  if (actualSha !== dav1dArchiveSha256) {
    throw new Error(`dav1d ${dav1dVersion} archive checksum mismatch: expected ${dav1dArchiveSha256}, got ${actualSha}.`);
  }
  const extractRoot = join(buildRoot, 'dav1d-extract');
  const compileRoot = join(buildRoot, 'dav1d-compile');
  const stageRoot = join(buildRoot, 'dav1d-stage');
  for (const dir of [extractRoot, compileRoot, stageRoot]) await resetDir(dir);
  run('tar', ['-xJf', archive, '-C', extractRoot], { stdio: 'inherit' });
  const sourceDir = await findDirContaining(extractRoot, 'meson.build');
  const targetFlags = `-arch arm64 -mmacosx-version-min=${minimumMacosVersion}`;
  const buildEnv = {
    ...process.env,
    MACOSX_DEPLOYMENT_TARGET: minimumMacosVersion,
    CFLAGS: targetFlags,
    LDFLAGS: targetFlags
  };
  const configureArgs = [
    'setup', compileRoot, sourceDir,
    `--prefix=${dav1dInstallPrefix}`, '--libdir=lib',
    '--default-library=static', '--buildtype=release',
    '-Denable_tools=false', '-Denable_tests=false',
    '-Denable_examples=false', '-Denable_docs=false'
  ];
  log(`Building static dav1d ${dav1dVersion} for software AV1 decoding on macOS ${minimumMacosVersion}+`);
  run('meson', configureArgs, { env: buildEnv, stdio: 'inherit' });
  run('meson', ['compile', '-C', compileRoot, '-j', String(Math.max(1, Math.min(cpus().length, 8)))], {
    env: buildEnv, stdio: 'inherit'
  });
  run('meson', ['install', '-C', compileRoot, '--destdir', stageRoot], { env: buildEnv, stdio: 'inherit' });
  const installRoot = join(stageRoot, ...dav1dInstallPrefix.split('/').filter(Boolean));
  return { sourceDir, stageRoot, installRoot, buildEnv, configureArgs };
}

async function prepareFfmpeg() {
  const dest = join(assetsRoot, 'ffmpeg');
  if (!options.force && (await exists(join(dest, 'bin', 'ffmpeg'))) && (await exists(join(dest, 'bin', 'ffprobe'))) && (await exists(join(dest, 'BUILD-CONFIG.txt')))) {
    const portability = await inspectManagedRuntimePortability(dest, {
      maximumMinimumVersion: minimumMacosVersion
    });
    const buildConfig = await readFile(join(dest, 'BUILD-CONFIG.txt'), 'utf8').catch(() => '');
    const capabilities = await inspectFfmpegRuntimeCapabilities(dest);
    const dav1dSource = await readFile(join(dest, 'share', 'dav1d', 'SOURCE.txt'), 'utf8').catch(() => '');
    if (
      portability.ok &&
      capabilities.ok &&
      capabilities.versionOutput.startsWith(`ffmpeg version ${ffmpegVersion} `) &&
      dav1dSource.includes(`Archive SHA256: ${dav1dArchiveSha256}`) &&
      buildConfig.includes('--disable-autodetect') &&
      buildConfig.includes(`MACOSX_DEPLOYMENT_TARGET=${minimumMacosVersion}`)
    ) {
      log(`FFmpeg runtime already prepared: ${dest}`);
      return dest;
    }
    log(
      `Rebuilding stale or non-portable cached FFmpeg runtime: ${
        [...portability.issues, ...capabilities.issues].join('; ') || 'version or build flags are stale'
      }`
    );
  }

  const dav1d = await prepareDav1d();

  const archive = join(downloadsRoot, ffmpegFilename);
  await download(ffmpegArchiveUrl, archive);
  const archiveSha = await sha256(archive);

  const extractRoot = join(buildRoot, 'ffmpeg-extract');
  const stageRoot = join(buildRoot, 'ffmpeg-stage');
  await resetDir(extractRoot);
  await resetDir(stageRoot);
  run('tar', ['-xJf', archive, '-C', extractRoot], { stdio: 'inherit' });
  const sourceDir = await findDirContaining(extractRoot, 'configure');

  const configureArgs = [
    `--prefix=${ffmpegInstallPrefix}`,
    '--disable-autodetect',
    '--disable-debug',
    '--disable-doc',
    '--disable-ffplay',
    '--enable-ffprobe',
    '--disable-x86asm',
    '--disable-libxcb',
    '--disable-libxcb-shm',
    '--disable-libxcb-xfixes',
    '--disable-libxcb-shape',
    '--disable-xlib',
    '--enable-audiotoolbox',
    '--enable-avfoundation',
    '--enable-videotoolbox',
    '--enable-libdav1d',
    '--pkg-config-flags=--static'
  ];
  const buildEnv = {
    ...process.env,
    MACOSX_DEPLOYMENT_TARGET: minimumMacosVersion,
    PKG_CONFIG_PATH: '',
    PKG_CONFIG_LIBDIR: join(dav1d.installRoot, 'lib', 'pkgconfig'),
    PKG_CONFIG_SYSROOT_DIR: dav1d.stageRoot
  };
  log(`Configuring FFmpeg ${ffmpegVersion} for macOS ${minimumMacosVersion}+`);
  run('./configure', configureArgs, { cwd: sourceDir, env: buildEnv, stdio: 'inherit' });
  log('Building FFmpeg. This can take a few minutes.');
  run('make', ['-j', String(Math.max(1, Math.min(cpus().length, 8)))], {
    cwd: sourceDir,
    env: buildEnv,
    stdio: 'inherit'
  });
  run('make', ['install', `DESTDIR=${stageRoot}`], {
    cwd: sourceDir,
    env: buildEnv,
    stdio: 'inherit'
  });
  const stagedInstallRoot = join(stageRoot, ...ffmpegInstallPrefix.split('/').filter(Boolean));
  await copyDir(stagedInstallRoot, dest);
  await rm(join(dest, 'include'), { recursive: true, force: true });
  await rm(join(dest, 'lib'), { recursive: true, force: true });
  await rm(join(dest, 'share'), { recursive: true, force: true });
  await copyFfmpegLicenseFiles(sourceDir, dest);
  const dav1dProofRoot = join(dest, 'share', 'dav1d');
  await mkdir(dav1dProofRoot, { recursive: true });
  await cp(join(dav1d.sourceDir, 'COPYING'), join(dav1dProofRoot, 'COPYING'));
  await writeText(join(dav1dProofRoot, 'SOURCE.txt'), `
dav1d ${dav1dVersion}, statically linked into FFmpeg and FFprobe.
Official source archive: ${dav1dArchiveUrl}
Archive SHA256: ${dav1dArchiveSha256}
License: BSD-2-Clause; see COPYING.
Minimum macOS: ${minimumMacosVersion}

Build: MACOSX_DEPLOYMENT_TARGET=${minimumMacosVersion}
CFLAGS/LDFLAGS: -arch arm64 -mmacosx-version-min=${minimumMacosVersion}
meson setup <build> <source> ${dav1d.configureArgs.slice(3).map(shellQuote).join(' ')}
meson compile -C <build>
meson install -C <build> --destdir <stage>
FFmpeg pkg-config is isolated to <stage>${dav1dInstallPrefix}/lib/pkgconfig with PKG_CONFIG_SYSROOT_DIR=<stage>.
`);
  await writeText(join(dav1dProofRoot, 'CHECKSUMS.txt'), `
${dav1dArchiveSha256}  ${dav1dFilename}
${await sha256(join(dav1dProofRoot, 'COPYING'))}  COPYING
`);

  const ffmpegBin = join(dest, 'bin', 'ffmpeg');
  const ffprobeBin = join(dest, 'bin', 'ffprobe');
  await adHocSignMachOFiles(dest);
  await assertPortableRuntime(dest, 'FFmpeg runtime');
  const { versionOutput, configLine } = await assertCleanFfmpegBuild(dest);
  const binarySha = await sha256(ffmpegBin);
  run(ffprobeBin, ['-version']);
  const probeSha = await sha256(ffprobeBin);
  await writeText(
    join(dest, 'SOURCE.txt'),
    `
FFmpeg ${ffmpegVersion} runtime for Batshit.app.
Official source archive: ${ffmpegArchiveUrl}
Archive SHA256: ${archiveSha}
Binary SHA256: ${binarySha}
Minimum macOS: ${minimumMacosVersion}
Prepared: ${new Date().toISOString()}

The packaged Batshit Mac app uses h264_videotoolbox for MP4 preview encoding.
Software AV1 inspection uses statically linked dav1d ${dav1dVersion}; see share/dav1d for its license and verified source.
`
  );
  await writeText(
    join(dest, 'CHECKSUMS.txt'),
    `
${archiveSha}  ${ffmpegFilename}
${binarySha}  bin/ffmpeg
${probeSha}  bin/ffprobe
`
  );
  await writeText(
    join(dest, 'BUILD-CONFIG.txt'),
    `
Configure command:
MACOSX_DEPLOYMENT_TARGET=${minimumMacosVersion} \\
./configure ${configureArgs.map(shellQuote).join(' ')}

Resolved configuration:
${configLine}

Version output:
${versionOutput}
`
  );
  log(`Prepared FFmpeg runtime: ${dest}`);
  return dest;
}

async function main() {
  for (const command of [
    'codesign',
    'curl',
    'file',
    'install_name_tool',
    'make',
    'otool',
    'perl',
    'shasum',
    'tar',
    'unzip',
    'xcrun'
  ]) {
    await ensureTool(command);
  }
  run('xcrun', ['--find', 'clang']);
  await mkdir(downloadsRoot, { recursive: true });
  await mkdir(buildRoot, { recursive: true });
  await mkdir(assetsRoot, { recursive: true });

  const prepared = {};
  if (shouldRun('node')) prepared.node = await prepareNode();
  if (shouldRun('openssl')) prepared.openssl = await prepareOpenSsl();
  if (shouldRun('redis')) prepared.redis = await prepareRedis();
  if (shouldRun('ffmpeg')) prepared.ffmpeg = await prepareFfmpeg();

  await writeText(
    join(assetsRoot, 'managed-runtime-assets.env'),
    `
export BATSHIT_MAC_NODE_DIST_DIR=${shellQuote(join(assetsRoot, 'node'))}
export BATSHIT_MAC_REDIS_DIST_DIR=${shellQuote(join(assetsRoot, 'redis'))}
export BATSHIT_MAC_FFMPEG_DIST_DIR=${shellQuote(join(assetsRoot, 'ffmpeg'))}
`
  );
  await writeText(
    join(assetsRoot, 'managed-runtime-assets.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        nodeVersion,
        redisVersion,
        opensslVersion,
        ffmpegVersion,
        dav1dVersion,
        minimumMacosVersion,
        assetsRoot,
        prepared
      },
      null,
      2
    )
  );

  log('Managed runtime assets are ready.');
  log(`Use: source ${join(assetsRoot, 'managed-runtime-assets.env')}`);
}

main().catch((error) => {
  console.error(`[managed-runtimes] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
