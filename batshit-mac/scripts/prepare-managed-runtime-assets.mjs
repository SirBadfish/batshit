import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import {
  access,
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
const redisStackVersion = process.env.BATSHIT_MAC_REDIS_STACK_VERSION || '7.4.0-v8';
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
const redisFilename = `redis-stack-server-${redisStackVersion}.sonoma.arm64.zip`;
const redisArchiveUrl = `https://packages.redis.io/redis-stack/${redisFilename}`;
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
  BATSHIT_MAC_REDIS_STACK_VERSION=${redisStackVersion}
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

async function copyDir(source, dest) {
  await rm(dest, { recursive: true, force: true });
  await cp(source, dest, { recursive: true, dereference: true });
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
    log(`Node runtime already prepared: ${dest}`);
    return dest;
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
  await copyDir(sourceDir, dest);
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

async function prepareRedisStack() {
  const dest = join(assetsRoot, 'redis-stack');
  const openssl = await prepareOpenSsl();
  const required = [
    join(dest, 'bin', 'redis-server'),
    join(dest, 'lib', 'libssl.3.dylib'),
    join(dest, 'lib', 'libcrypto.3.dylib'),
    join(dest, 'share', 'openssl', 'LICENSE.txt'),
    join(dest, 'share', 'openssl', 'SOURCE.txt'),
    join(dest, 'SOURCE.txt')
  ];
  if (!options.force && (await Promise.all(required.map(exists))).every(Boolean)) {
    const portability = await inspectManagedRuntimePortability(dest, {
      maximumMinimumVersion: minimumMacosVersion
    });
    if (portability.ok) {
      log(`Redis Stack runtime already prepared: ${dest}`);
      return dest;
    }
    log(`Rebuilding non-portable cached Redis Stack runtime: ${portability.issues.join('; ')}`);
  }

  const archive = join(downloadsRoot, redisFilename);
  await download(redisArchiveUrl, archive);
  const archiveSha = await sha256(archive);

  const extractRoot = join(buildRoot, 'redis-stack-extract');
  await resetDir(extractRoot);
  run('unzip', ['-q', archive, '-d', extractRoot], { stdio: 'inherit' });
  const sourceDir = await findDirContaining(extractRoot, 'bin/redis-server');
  await copyDir(sourceDir, dest);
  await cp(join(openssl, 'lib', 'libssl.3.dylib'), join(dest, 'lib', 'libssl.3.dylib'));
  await cp(join(openssl, 'lib', 'libcrypto.3.dylib'), join(dest, 'lib', 'libcrypto.3.dylib'));
  const opensslShare = join(dest, 'share', 'openssl');
  await mkdir(opensslShare, { recursive: true });
  for (const filename of ['LICENSE.txt', 'SOURCE.txt', 'CHECKSUMS.txt']) {
    await cp(join(openssl, filename), join(opensslShare, filename));
  }

  for (const file of await collectMachOFiles(dest)) {
    const relativePath = file.slice(dest.length + 1);
    const bundledPrefix = relativePath.startsWith('bin/') ? '@loader_path/../lib' : '@loader_path';
    const installName = parseOtoolInstallName(runCaptured('otool', ['-D', file]));
    for (const dependency of parseOtoolLibraries(runCaptured('otool', ['-L', file]))) {
      if (dependency === installName) continue;
      for (const library of ['libssl.3.dylib', 'libcrypto.3.dylib']) {
        if (!dependency.endsWith(`/${library}`)) continue;
        run('install_name_tool', [
          '-change',
          dependency,
          `${bundledPrefix}/${library}`,
          file
        ]);
      }
    }
  }
  await adHocSignMachOFiles(dest);
  await assertPortableRuntime(dest, 'Redis Stack runtime');
  await writeText(
    join(dest, 'SOURCE.txt'),
    `
Redis Stack Server ${redisStackVersion} macOS arm64 runtime for Batshit.app.
Official archive: ${redisArchiveUrl}
Archive SHA256: ${archiveSha}
Bundled OpenSSL runtime: ${opensslVersion} LTS
Minimum macOS: ${minimumMacosVersion}
Prepared: ${new Date().toISOString()}
`
  );
  await writeText(
    join(dest, 'CHECKSUMS.txt'),
    `
${archiveSha}  ${redisFilename}
`
  );
  log(`Prepared Redis Stack runtime: ${dest}`);
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
  if (shouldRun('redis')) prepared.redisStack = await prepareRedisStack();
  if (shouldRun('ffmpeg')) prepared.ffmpeg = await prepareFfmpeg();

  await writeText(
    join(assetsRoot, 'managed-runtime-assets.env'),
    `
export BATSHIT_MAC_NODE_DIST_DIR=${shellQuote(join(assetsRoot, 'node'))}
export BATSHIT_MAC_REDIS_STACK_DIST_DIR=${shellQuote(join(assetsRoot, 'redis-stack'))}
export BATSHIT_MAC_FFMPEG_DIST_DIR=${shellQuote(join(assetsRoot, 'ffmpeg'))}
`
  );
  await writeText(
    join(assetsRoot, 'managed-runtime-assets.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        nodeVersion,
        redisStackVersion,
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
