import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import {
  access,
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const macRoot = resolve(__dirname, '..');
const repoRoot = resolve(macRoot, '..');

const nodeVersion = process.env.BATSHIT_MAC_NODE_VERSION || '24.17.0';
const redisStackVersion = process.env.BATSHIT_MAC_REDIS_STACK_VERSION || '7.4.0-v8';
const ffmpegVersion = process.env.BATSHIT_MAC_FFMPEG_VERSION || '8.1.2';
const ffmpegInstallPrefix = process.env.BATSHIT_MAC_FFMPEG_INSTALL_PREFIX || '/opt/batshit/ffmpeg';
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

const options = parseArgs(process.argv.slice(2));

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
      if (!value) throw new Error('--only requires node, redis, ffmpeg, or all.');
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
  console.log(`Usage: node scripts/prepare-managed-runtime-assets.mjs [--force] [--only node,redis,ffmpeg]

Prepares redistributable Mac runtime asset folders under:
  ${assetsRoot}

Environment overrides:
  BATSHIT_MAC_NODE_VERSION=${nodeVersion}
  BATSHIT_MAC_REDIS_STACK_VERSION=${redisStackVersion}
  BATSHIT_MAC_FFMPEG_VERSION=${ffmpegVersion}
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

async function prepareRedisStack() {
  const dest = join(assetsRoot, 'redis-stack');
  if (!options.force && (await exists(join(dest, 'bin', 'redis-server'))) && (await exists(join(dest, 'SOURCE.txt')))) {
    log(`Redis Stack runtime already prepared: ${dest}`);
    return dest;
  }

  const archive = join(downloadsRoot, redisFilename);
  await download(redisArchiveUrl, archive);
  const archiveSha = await sha256(archive);

  const extractRoot = join(buildRoot, 'redis-stack-extract');
  await resetDir(extractRoot);
  run('unzip', ['-q', archive, '-d', extractRoot], { stdio: 'inherit' });
  const sourceDir = await findDirContaining(extractRoot, 'bin/redis-server');
  await copyDir(sourceDir, dest);
  await writeText(
    join(dest, 'SOURCE.txt'),
    `
Redis Stack Server ${redisStackVersion} macOS arm64 runtime for Batshit.app.
Official archive: ${redisArchiveUrl}
Archive SHA256: ${archiveSha}
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
    log(`FFmpeg runtime already prepared: ${dest}`);
    return dest;
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
    '--disable-debug',
    '--disable-doc',
    '--disable-ffplay',
    '--disable-ffprobe',
    '--disable-x86asm',
    '--enable-audiotoolbox',
    '--enable-avfoundation',
    '--enable-videotoolbox'
  ];
  log(`Configuring FFmpeg ${ffmpegVersion}`);
  run('./configure', configureArgs, { cwd: sourceDir, stdio: 'inherit' });
  log('Building FFmpeg. This can take a few minutes.');
  run('make', ['-j', String(Math.max(1, Math.min(cpus().length, 8)))], { cwd: sourceDir, stdio: 'inherit' });
  run('make', ['install', `DESTDIR=${stageRoot}`], { cwd: sourceDir, stdio: 'inherit' });
  const stagedInstallRoot = join(stageRoot, ...ffmpegInstallPrefix.split('/').filter(Boolean));
  await copyDir(stagedInstallRoot, dest);
  await rm(join(dest, 'include'), { recursive: true, force: true });
  await rm(join(dest, 'lib', 'pkgconfig'), { recursive: true, force: true });
  await rm(join(dest, 'share', 'man'), { recursive: true, force: true });
  await copyFfmpegLicenseFiles(sourceDir, dest);

  const ffmpegBin = join(dest, 'bin', 'ffmpeg');
  const { versionOutput, configLine } = await assertCleanFfmpegBuild(ffmpegBin);
  const binarySha = await sha256(ffmpegBin);
  await writeText(
    join(dest, 'SOURCE.txt'),
    `
FFmpeg ${ffmpegVersion} runtime for Batshit.app.
Official source archive: ${ffmpegArchiveUrl}
Archive SHA256: ${archiveSha}
Binary SHA256: ${binarySha}
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
  for (const command of ['curl', 'shasum', 'tar', 'unzip', 'make', 'xcrun']) {
    await ensureTool(command);
  }
  run('xcrun', ['--find', 'clang']);
  await mkdir(downloadsRoot, { recursive: true });
  await mkdir(buildRoot, { recursive: true });
  await mkdir(assetsRoot, { recursive: true });

  const prepared = {};
  if (shouldRun('node')) prepared.node = await prepareNode();
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
        ffmpegVersion,
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
