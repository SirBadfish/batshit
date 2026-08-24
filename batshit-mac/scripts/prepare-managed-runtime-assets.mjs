import { spawn, spawnSync } from 'node:child_process';
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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inspectManagedRuntimePortability,
  isMachOFile,
  MAC_RUNTIME_MINIMUM_VERSION,
  parseOtoolInstallName,
  parseOtoolLibraries
} from './managed-runtime-portability.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const macRoot = resolve(__dirname, '..');
const repoRoot = resolve(macRoot, '..');

const nodeVersion = process.env.BATSHIT_MAC_NODE_VERSION || '24.17.0';
const redisVersion = process.env.BATSHIT_MAC_REDIS_VERSION || '8.10.1';
const ffmpegVersion = process.env.BATSHIT_MAC_FFMPEG_VERSION || '8.1.2';
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
const redisFilename = `redis-oss-${redisVersion}-arm64.zip`;
const redisArchiveUrl = `https://packages.redis.io/homebrew/${redisFilename}`;
// SA-101 / DL-101-03: the Redis archive is pinned by exact SHA-256, not merely recorded.
// This value is the arm64 hash published by the official `redis/homebrew-redis` cask for
// this exact version. Bumping BATSHIT_MAC_REDIS_VERSION without also supplying the matching
// BATSHIT_MAC_REDIS_ARCHIVE_SHA256 is refused rather than silently unpinned.
const REDIS_PINNED_VERSION = '8.10.1';
const REDIS_PINNED_ARCHIVE_SHA256 = '3e7966a847255580f93fac2398d99c20d80583decf10f194b60fe20a7724e433';
// Redis 8's macOS archive ships no licence files, so the tri-licence text and the retained
// BSD-3-Clause contributions notice are fetched from the matching immutable release tag.
const redisLicenseBaseUrl = `https://raw.githubusercontent.com/redis/redis/${redisVersion}`;
const REDIS_LICENSE_FILES = [
  { filename: 'LICENSE.txt', sha256: '4a0e416b9537688f30dfe69ddaceb2ca64d96b7df02a0a6760d376890ddc4e40' },
  { filename: 'REDISCONTRIBUTIONS.txt', sha256: 'aa6a56234e5ca27f09010693d1c31ca83988d7a0dc80fb253603e052d1d7f0d1' }
];
// Only the modules Batshit actually needs are bundled. Batshit stores JSON records, and a
// data file written by any Redis Stack server carries a RediSearch AUX marker that Redis 8
// refuses to load without RediSearch present. Bloom and TimeSeries stamp no such marker and
// are not used, so they stay out of the signing and audit surface.
const REDIS_BUNDLED_MODULES = ['rejson.so', 'redisearch.so'];
// redis-check-aof / redis-check-rdb are the documented repair path for the AOF-first Mac
// lane. redis-benchmark and redis-sentinel have no Batshit use and are not bundled.
const REDIS_BUNDLED_BINARIES = ['redis-server', 'redis-cli', 'redis-check-aof', 'redis-check-rdb'];
// redisearch.so links libunwind from a Homebrew llvm@18 path that does not exist on a user's
// Mac. It needs exactly the 13 standard Itanium C++ ABI _Unwind_* symbols, all of which macOS
// exports from libSystem. Substituting leaves one unwinder in the process (Apple's, which the
// redis-server core already uses via libc++abi) rather than loading a second one.
const REDIS_UNWINDER_SUBSTITUTIONS = new Map([['libunwind.1.dylib', '/usr/lib/libSystem.B.dylib']]);
const ffmpegFilename = `ffmpeg-${ffmpegVersion}.tar.xz`;
const ffmpegArchiveUrl = `https://ffmpeg.org/releases/${ffmpegFilename}`;
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
    if ((await hasPortableSymlink(dest, 'npm')) && (await hasPortableSymlink(dest, 'npx'))) {
      try {
        npmReady = Boolean(
          runCaptured(join(dest, 'bin', 'node'), [join(dest, 'bin', 'npm'), '--version']).trim()
        );
      } catch {
        npmReady = false;
      }
    }
    if (npmReady) {
      log(`Node runtime already prepared: ${dest}`);
      return dest;
    }
    log('Rebuilding cached Node runtime because its npm/npx launcher links are invalid.');
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
  await copyDir(sourceDir, dest, { dereference: false });
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
  return REDIS_PINNED_ARCHIVE_SHA256;
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

  // Curate the bundle explicitly instead of copying the whole archive: only the binaries and
  // modules Batshit runs are shipped, and the modules are flattened into lib/ so every bundled
  // Mach-O sits at a known depth relative to the bundled OpenSSL dylibs.
  await resetDir(dest);
  await mkdir(join(dest, 'bin'), { recursive: true });
  await mkdir(join(dest, 'lib'), { recursive: true });
  for (const name of REDIS_BUNDLED_BINARIES) {
    const source = join(sourceDir, 'bin', name);
    if (!(await exists(source))) {
      throw new Error(`Redis archive is missing bin/${name}: ${source}`);
    }
    await cp(source, join(dest, 'bin', name));
    await chmod(join(dest, 'bin', name), 0o755);
  }
  for (const name of REDIS_BUNDLED_MODULES) {
    const source = join(sourceDir, 'lib', 'redis', 'modules', name);
    if (!(await exists(source))) {
      throw new Error(`Redis archive is missing lib/redis/modules/${name}: ${source}`);
    }
    await cp(source, join(dest, 'lib', name));
    await chmod(join(dest, 'lib', name), 0o755);
  }

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

  for (const file of await collectMachOFiles(dest)) {
    const relativePath = file.slice(dest.length + 1);
    const bundledPrefix = relativePath.startsWith('bin/') ? '@loader_path/../lib' : '@loader_path';
    const installName = parseOtoolInstallName(runCaptured('otool', ['-D', file]));
    // A module whose own install name is a build-machine path would otherwise survive the
    // portability audit through the "dependency === installName" allowance. Rewrite it.
    if (installName && (installName.startsWith('/Users/') || installName.startsWith('/opt/homebrew/'))) {
      run('install_name_tool', ['-id', basename(file), file]);
    }
    for (const dependency of parseOtoolLibraries(runCaptured('otool', ['-L', file]))) {
      if (dependency === installName) continue;
      for (const library of ['libssl.3.dylib', 'libcrypto.3.dylib']) {
        if (!dependency.endsWith(`/${library}`)) continue;
        run('install_name_tool', ['-change', dependency, `${bundledPrefix}/${library}`, file]);
      }
      for (const [library, replacement] of REDIS_UNWINDER_SUBSTITUTIONS) {
        if (!dependency.endsWith(`/${library}`)) continue;
        run('install_name_tool', ['-change', dependency, replacement, file]);
      }
    }
  }
  await adHocSignMachOFiles(dest);
  await assertPortableRuntime(dest, 'Redis runtime');
  await assertRedisRuntimeUsable(dest);

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

// A prepared runtime that cannot actually start is worse than a missing one, because every
// later gate (packaging, audit, signing) would pass on bytes that fail on a user's Mac. Boot
// the prepared server with the bundled modules and prove RedisJSON and Search answer.
async function assertRedisRuntimeUsable(dest) {
  const probeDir = join(buildRoot, 'redis-probe');
  await resetDir(probeDir);
  // Listen on a unix socket only: no TCP port, so this can never collide with, or be mistaken
  // for, a Redis the developer is already running.
  const socketPath = join(probeDir, 'probe.sock');
  const serverBin = join(dest, 'bin', 'redis-server');
  const cliBin = join(dest, 'bin', 'redis-cli');
  const args = [
    '--port', '0',
    '--unixsocket', socketPath,
    '--dir', probeDir,
    '--save', '',
    '--daemonize', 'no',
    '--logfile', join(probeDir, 'redis.log')
  ];
  for (const module of REDIS_BUNDLED_MODULES) {
    args.push('--loadmodule', join(dest, 'lib', module));
  }
  const server = spawn(serverBin, args, { stdio: 'ignore', detached: true });
  server.unref();
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ping = spawnSync(cliBin, ['-s', socketPath, 'PING'], { encoding: 'utf8' });
      if (ping.stdout?.trim() === 'PONG') { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) {
      const logText = await readFile(join(probeDir, 'redis.log'), 'utf8').catch(() => '');
      throw new Error(`Prepared Redis runtime did not start.\n${logText}`);
    }
    const check = (cmdArgs, label, predicate) => {
      const result = spawnSync(cliBin, ['-s', socketPath, ...cmdArgs], { encoding: 'utf8' });
      const output = (result.stdout || '').trim();
      if (!predicate(output)) {
        throw new Error(`Prepared Redis runtime failed the ${label} probe: ${output || result.stderr}`);
      }
      return output;
    };
    check(['JSON.SET', 'batshit:probe', '$', '{"ok":true}'], 'RedisJSON write', (out) => out === 'OK');
    check(['JSON.GET', 'batshit:probe', '$'], 'RedisJSON read', (out) => out.includes('"ok":true'));
    check(['FT._LIST'], 'RediSearch', (out) => !/^ERR/i.test(out));
    const modules = check(['MODULE', 'LIST'], 'module list', () => true);
    for (const expected of ['ReJSON', 'search']) {
      if (!modules.includes(expected)) {
        throw new Error(`Prepared Redis runtime is missing the ${expected} module: ${modules}`);
      }
    }
    log('Verified the prepared Redis runtime starts with RedisJSON and Search.');
  } finally {
    spawnSync(cliBin, ['-s', socketPath, 'SHUTDOWN', 'NOSAVE'], { encoding: 'utf8' });
    await rm(probeDir, { recursive: true, force: true });
  }
}

async function copyFfmpegLicenseFiles(sourceDir, dest) {
  const entries = await readdir(sourceDir);
  for (const entry of entries) {
    if (entry === 'LICENSE' || entry === 'LICENSE.md' || entry.startsWith('COPYING')) {
      await cp(join(sourceDir, entry), join(dest, entry));
    }
  }
}

async function assertCleanFfmpegBuild(ffmpegBin) {
  const version = run(ffmpegBin, ['-hide_banner', '-version']);
  const versionOutput = `${version.stdout}\n${version.stderr}`;
  const configLine = versionOutput
    .split(/\r?\n/)
    .find((line) => line.startsWith('configuration:')) || '';
  if (!configLine) throw new Error('Built FFmpeg did not report a configuration line.');
  if (configLine.includes('--enable-gpl')) throw new Error('Built FFmpeg unexpectedly includes --enable-gpl.');
  if (configLine.includes('--enable-nonfree')) throw new Error('Built FFmpeg unexpectedly includes --enable-nonfree.');
  const encoders = run(ffmpegBin, ['-hide_banner', '-encoders']);
  if (!/\bh264_videotoolbox\b/.test(`${encoders.stdout}\n${encoders.stderr}`)) {
    throw new Error('Built FFmpeg does not expose h264_videotoolbox.');
  }
  return { versionOutput, configLine };
}

async function prepareFfmpeg() {
  const dest = join(assetsRoot, 'ffmpeg');
  if (!options.force && (await exists(join(dest, 'bin', 'ffmpeg'))) && (await exists(join(dest, 'BUILD-CONFIG.txt')))) {
    const portability = await inspectManagedRuntimePortability(dest, {
      maximumMinimumVersion: minimumMacosVersion
    });
    const buildConfig = await readFile(join(dest, 'BUILD-CONFIG.txt'), 'utf8').catch(() => '');
    if (
      portability.ok &&
      buildConfig.includes('--disable-autodetect') &&
      buildConfig.includes(`MACOSX_DEPLOYMENT_TARGET=${minimumMacosVersion}`)
    ) {
      log(`FFmpeg runtime already prepared: ${dest}`);
      return dest;
    }
    log(
      `Rebuilding non-portable cached FFmpeg runtime: ${
        portability.issues.join('; ') || 'build flags are stale'
      }`
    );
  }

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
    '--disable-ffprobe',
    '--disable-x86asm',
    '--disable-libxcb',
    '--disable-libxcb-shm',
    '--disable-libxcb-xfixes',
    '--disable-libxcb-shape',
    '--disable-xlib',
    '--enable-audiotoolbox',
    '--enable-avfoundation',
    '--enable-videotoolbox'
  ];
  const buildEnv = { ...process.env, MACOSX_DEPLOYMENT_TARGET: minimumMacosVersion };
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

  const ffmpegBin = join(dest, 'bin', 'ffmpeg');
  await adHocSignMachOFiles(dest);
  await assertPortableRuntime(dest, 'FFmpeg runtime');
  const { versionOutput, configLine } = await assertCleanFfmpegBuild(ffmpegBin);
  const binarySha = await sha256(ffmpegBin);
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
`
  );
  await writeText(
    join(dest, 'CHECKSUMS.txt'),
    `
${archiveSha}  ${ffmpegFilename}
${binarySha}  bin/ffmpeg
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
