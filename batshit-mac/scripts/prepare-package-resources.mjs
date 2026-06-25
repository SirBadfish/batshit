import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const macRoot = resolve(__dirname, '..');
const repoRoot = resolve(macRoot, '..');
const packagePath = resolve(process.argv[2] || join(macRoot, 'zig-out/package/Batshit-0.1.0-macos-ReleaseSafe.app'));
const resourcesPath = join(packagePath, 'Contents', 'Resources');
const runtimePath = join(resourcesPath, 'runtime');

const appSource = join(repoRoot, 'batshit-app');
const serverSource = join(repoRoot, 'batshit-server', 'server');
const liveKitSidecarSource = join(repoRoot, 'tools', 'livekit-agent-sidecar');
const appDest = join(runtimePath, 'batshit-app');
const serverDest = join(runtimePath, 'batshit-server', 'server');
const liveKitSidecarDest = join(runtimePath, 'tools', 'livekit-agent-sidecar');
const nodeRuntimeDest = join(runtimePath, 'vendor', 'node');
const redisStackRuntimeDest = join(runtimePath, 'vendor', 'redis-stack');
const ffmpegRuntimeDest = join(runtimePath, 'vendor', 'ffmpeg');
const entitlementsPath = join(macRoot, 'macos.entitlements');
const thirdPartyNoticesSource = join(repoRoot, 'THIRD_PARTY_NOTICES.md');

async function exists(path) {
  return Boolean(await stat(path).catch(() => null));
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function runCaptured(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 10000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    error: result.error
  };
}

function shouldSkipCopiedPath(relativePath) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === '.env' || segment.startsWith('.env.')) return true;
    if (['logs', '.vercel', '.svelte-kit', 'coverage', 'test-results'].includes(segment)) return true;
    if (['.cache', '.vite', '.vite-temp', '.tmp'].includes(segment)) return true;
  }
  return false;
}

function plistEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function ensureInfoPlistStringKey(plistPath, key, value) {
  let content = await readFile(plistPath, 'utf8');
  if (content.includes(`<key>${key}</key>`)) return;
  const insertion = `  <key>${key}</key>\n  <string>${plistEscape(value)}</string>\n`;
  if (!content.includes('</dict>')) {
    throw new Error(`Info.plist is missing closing </dict>: ${plistPath}`);
  }
  content = content.replace('</dict>', `${insertion}</dict>`);
  await writeFile(plistPath, content);
}

async function copyRequired(source, dest) {
  if (!(await exists(source))) throw new Error(`Missing package input: ${source}`);
  await cp(source, dest, {
    recursive: true,
    dereference: true,
    filter: (path) => {
      const relative = path.slice(source.length);
      if (shouldSkipCopiedPath(relative)) {
        return false;
      }
      if (/\.(log|pid|seed|pid\.lock)$/i.test(relative)) return false;
      return true;
    }
  });
}

async function copyRequiredFile(source, dest) {
  if (!(await exists(source))) throw new Error(`Missing package input: ${source}`);
  await mkdir(dirname(dest), { recursive: true });
  await cp(source, dest);
}

async function copyOptionalFile(source, dest) {
  if (!(await exists(source))) return;
  await mkdir(dirname(dest), { recursive: true });
  await cp(source, dest);
}

async function firstExistingPath(base, candidates) {
  for (const candidate of candidates) {
    const target = join(base, candidate);
    if (await exists(target)) return candidate;
  }
  return null;
}

async function requireFirstExistingPath(base, candidates, label) {
  const found = await firstExistingPath(base, candidates);
  if (found) return found;
  throw new Error(`${label} is required in ${base}. Checked: ${candidates.join(', ')}`);
}

async function runtimeProofFiles(base, label) {
  const sourceReference = await requireFirstExistingPath(
    base,
    ['SOURCE.txt', 'SOURCE.md', 'source.txt', 'share/SOURCE.txt', 'share/source.txt'],
    `${label} source reference`
  );
  const checksums = await requireFirstExistingPath(
    base,
    ['CHECKSUMS.txt', 'SHA256SUMS', 'SHASUMS256.txt', 'checksums.txt', 'share/CHECKSUMS.txt', 'share/checksums.txt'],
    `${label} checksum record`
  );
  return { sourceReference, checksums };
}

async function copyLiveKitSidecarSourcePackage() {
  if (!(await exists(liveKitSidecarSource))) {
    throw new Error(`Missing package input: ${liveKitSidecarSource}`);
  }

  await mkdir(liveKitSidecarDest, { recursive: true });
  await copyRequiredFile(
    join(liveKitSidecarSource, 'package.json'),
    join(liveKitSidecarDest, 'package.json')
  );
  await copyOptionalFile(
    join(liveKitSidecarSource, 'package-lock.json'),
    join(liveKitSidecarDest, 'package-lock.json')
  );
  await copyRequiredFile(
    join(liveKitSidecarSource, 'tsconfig.json'),
    join(liveKitSidecarDest, 'tsconfig.json')
  );
  await copyRequired(join(liveKitSidecarSource, 'src'), join(liveKitSidecarDest, 'src'));
}

async function copyManagedNodeRuntime() {
  const source = process.env.BATSHIT_MAC_NODE_DIST_DIR || process.env.BATSHIT_MAC_NODE_RUNTIME_DIR;
  if (!source) return null;

  const resolvedSource = resolve(source);
  const nodeBin = join(resolvedSource, 'bin', 'node');
  const licensePath = join(resolvedSource, 'LICENSE');
  if (!(await exists(nodeBin))) {
    throw new Error(`BATSHIT_MAC_NODE_DIST_DIR must point at an unpacked Node distribution with bin/node: ${resolvedSource}`);
  }
  if (!(await exists(licensePath))) {
    throw new Error(`BATSHIT_MAC_NODE_DIST_DIR must include Node license files: ${licensePath}`);
  }
  const proof = await runtimeProofFiles(resolvedSource, 'BATSHIT_MAC_NODE_DIST_DIR');

  await copyRequired(resolvedSource, nodeRuntimeDest);
  return {
    node: {
      distribution: 'Node.js official macOS arm64 runtime archive',
      appBundlePath: 'Contents/Resources/runtime/vendor/node',
      license: 'Contents/Resources/runtime/vendor/node/LICENSE',
      sourceReference: `Contents/Resources/runtime/vendor/node/${proof.sourceReference}`,
      checksums: `Contents/Resources/runtime/vendor/node/${proof.checksums}`
    }
  };
}

async function copyManagedRedisStackRuntime() {
  const source =
    process.env.BATSHIT_MAC_REDIS_STACK_DIST_DIR ||
    process.env.BATSHIT_MAC_REDIS_STACK_RUNTIME_DIR;
  if (!source) return null;

  const resolvedSource = resolve(source);
  const requiredFiles = [
    'bin/redis-server',
    'bin/redis-cli',
    'lib/redisearch.so',
    'lib/rejson.so',
    'share/RSALv2.txt',
    'share/SSPLv1.txt'
  ];
  for (const relative of requiredFiles) {
    if (!(await exists(join(resolvedSource, relative)))) {
      throw new Error(`BATSHIT_MAC_REDIS_STACK_DIST_DIR is missing ${relative}: ${resolvedSource}`);
    }
  }
  const proof = await runtimeProofFiles(resolvedSource, 'BATSHIT_MAC_REDIS_STACK_DIST_DIR');

  await copyRequired(resolvedSource, redisStackRuntimeDest);
  return {
    redisStack: {
      distribution: 'Redis Stack Server macOS arm64 runtime archive',
      appBundlePath: 'Contents/Resources/runtime/vendor/redis-stack',
      licenses: [
        'Contents/Resources/runtime/vendor/redis-stack/share/RSALv2.txt',
        'Contents/Resources/runtime/vendor/redis-stack/share/SSPLv1.txt'
      ],
      sourceReference: `Contents/Resources/runtime/vendor/redis-stack/${proof.sourceReference}`,
      checksums: `Contents/Resources/runtime/vendor/redis-stack/${proof.checksums}`
    }
  };
}

async function copyManagedFfmpegRuntime() {
  const source =
    process.env.BATSHIT_MAC_FFMPEG_DIST_DIR ||
    process.env.BATSHIT_MAC_FFMPEG_RUNTIME_DIR;
  if (!source) return null;

  const resolvedSource = resolve(source);
  const ffmpegBin = join(resolvedSource, 'bin', 'ffmpeg');
  const license = await firstExistingPath(resolvedSource, [
    'LICENSE',
    'LICENSE.md',
    'COPYING',
    'COPYING.LGPLv2.1',
    'COPYING.LGPLv3',
    'COPYING.GPLv2',
    'COPYING.GPLv3'
  ]);
  if (!(await exists(ffmpegBin))) {
    throw new Error(`BATSHIT_MAC_FFMPEG_DIST_DIR must point at a runtime with bin/ffmpeg: ${resolvedSource}`);
  }
  if (!license) {
    throw new Error(`BATSHIT_MAC_FFMPEG_DIST_DIR must include ffmpeg license files: ${resolvedSource}`);
  }
  const buildConfig = await requireFirstExistingPath(
    resolvedSource,
    [
      'BUILD-CONFIG.txt',
      'BUILD_CONFIG.txt',
      'build-config.txt',
      'share/ffmpeg/BUILD-CONFIG.txt',
      'share/ffmpeg/build-config.txt'
    ],
    'BATSHIT_MAC_FFMPEG_DIST_DIR build configuration'
  );
  const proof = await runtimeProofFiles(resolvedSource, 'BATSHIT_MAC_FFMPEG_DIST_DIR');
  const versionResult = runCaptured(ffmpegBin, ['-hide_banner', '-version']);
  if (!versionResult.ok) {
    throw new Error(
      `BATSHIT_MAC_FFMPEG_DIST_DIR bin/ffmpeg must run successfully: ${
        versionResult.stderr || versionResult.stdout || versionResult.error?.message || 'unknown error'
      }`
    );
  }
  const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`;
  const configLine = versionOutput
    .split(/\r?\n/)
    .find((line) => line.startsWith('configuration:')) || '';
  if (!configLine) {
    throw new Error('BATSHIT_MAC_FFMPEG_DIST_DIR bin/ffmpeg must report its configure flags in `ffmpeg -version` output.');
  }
  if (configLine.includes(resolvedSource) || configLine.includes(repoRoot)) {
    throw new Error(
      'BATSHIT_MAC_FFMPEG_DIST_DIR uses a local build-machine path in its FFmpeg configure prefix. Rebuild it with the managed runtime asset prep script so the packaged app does not expose local source paths.'
    );
  }
  if (configLine.includes('--enable-nonfree')) {
    throw new Error('BATSHIT_MAC_FFMPEG_DIST_DIR must not use an FFmpeg build configured with --enable-nonfree.');
  }
  const gplEnabled = configLine.includes('--enable-gpl');
  if (gplEnabled && process.env.BATSHIT_MAC_ALLOW_GPL_FFMPEG !== '1') {
    throw new Error(
      'BATSHIT_MAC_FFMPEG_DIST_DIR uses --enable-gpl. Use an LGPL-compatible FFmpeg build for the Mac app, or set BATSHIT_MAC_ALLOW_GPL_FFMPEG=1 only after release owners accept the GPL notice/source obligations.'
    );
  }
  const encodersResult = runCaptured(ffmpegBin, ['-hide_banner', '-encoders']);
  if (!encodersResult.ok || !/\bh264_videotoolbox\b/.test(`${encodersResult.stdout}\n${encodersResult.stderr}`)) {
    throw new Error(
      'BATSHIT_MAC_FFMPEG_DIST_DIR must include the h264_videotoolbox encoder so the Mac app can avoid a bundled libx264/GPL dependency.'
    );
  }

  await copyRequired(resolvedSource, ffmpegRuntimeDest);
  return {
    ffmpeg: {
      distribution: 'FFmpeg official source build prepared for Batshit.app',
      appBundlePath: 'Contents/Resources/runtime/vendor/ffmpeg',
      version: versionOutput.split(/\r?\n/).find(Boolean) || null,
      licenseMode: gplEnabled ? 'GPL-enabled' : 'LGPL-compatible',
      h264Encoder: 'h264_videotoolbox',
      license: `Contents/Resources/runtime/vendor/ffmpeg/${license}`,
      buildConfig: `Contents/Resources/runtime/vendor/ffmpeg/${buildConfig}`,
      sourceReference: `Contents/Resources/runtime/vendor/ffmpeg/${proof.sourceReference}`,
      checksums: `Contents/Resources/runtime/vendor/ffmpeg/${proof.checksums}`
    }
  };
}

async function main() {
  if (!(await exists(resourcesPath))) {
    throw new Error(`Package resources path does not exist: ${resourcesPath}`);
  }

  const appBuild = join(appSource, 'build');
  if (process.env.BATSHIT_MAC_SKIP_APP_BUILD !== '1') {
    runChecked('npm', ['--prefix', appSource, 'run', 'build'], {
      env: { ...process.env, BATSHIT_SVELTE_ADAPTER: 'node' }
    });
  }
  if (!(await exists(appBuild))) {
    throw new Error(`Missing SvelteKit node build at ${appBuild}`);
  }

  await mkdir(join(resourcesPath, 'scripts'), { recursive: true });
  await cp(join(macRoot, 'scripts', 'mac-runtime-supervisor.mjs'), join(resourcesPath, 'scripts', 'mac-runtime-supervisor.mjs'));
  await copyRequiredFile(thirdPartyNoticesSource, join(resourcesPath, 'THIRD_PARTY_NOTICES.md'));

  await rm(runtimePath, { recursive: true, force: true });
  await mkdir(appDest, { recursive: true });
  await mkdir(serverDest, { recursive: true });

  await copyRequired(join(appSource, 'build'), join(appDest, 'build'));
  await copyRequired(join(appSource, 'node_modules'), join(appDest, 'node_modules'));
  await copyRequired(join(appSource, 'scripts'), join(appDest, 'scripts'));
  await cp(join(appSource, 'package.json'), join(appDest, 'package.json'));
  if (await exists(join(appSource, 'package-lock.json'))) {
    await cp(join(appSource, 'package-lock.json'), join(appDest, 'package-lock.json'));
  }

  await copyRequired(join(serverSource, 'src'), join(serverDest, 'src'));
  await copyRequired(join(serverSource, 'node_modules'), join(serverDest, 'node_modules'));
  await cp(join(serverSource, 'package.json'), join(serverDest, 'package.json'));
  if (await exists(join(serverSource, 'package-lock.json'))) {
    await cp(join(serverSource, 'package-lock.json'), join(serverDest, 'package-lock.json'));
  }

  runChecked('npm', ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: appDest
  });
  runChecked('npm', ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: serverDest
  });

  const systemPrompts = join(repoRoot, 'docs', 'batshit_System_Prompts');
  if (await exists(systemPrompts)) {
    await copyRequired(systemPrompts, join(runtimePath, 'docs', 'batshit_System_Prompts'));
  }
  const n8nTemplates = join(repoRoot, 'docs', 'user-docs', 'user-templates', 'batshit-official-n8n-workflow-templates');
  if (await exists(n8nTemplates)) {
    await copyRequired(n8nTemplates, join(runtimePath, 'docs', 'user-docs', 'user-templates', 'batshit-official-n8n-workflow-templates'));
  }
  await copyLiveKitSidecarSourcePackage();
  const managedRuntimeEntries = await Promise.all([
    copyManagedNodeRuntime(),
    copyManagedRedisStackRuntime(),
    copyManagedFfmpegRuntime()
  ]);
  const managedRuntimes = Object.assign({}, ...managedRuntimeEntries.filter(Boolean));

  await writeFile(
    join(runtimePath, 'runtime-manifest.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: 'local Batshit checkout',
        app: 'batshit-app/build plus runtime node_modules',
        server: 'batshit-server/server/src plus runtime node_modules',
        n8n: 'not bundled',
        liveKitSidecar: 'tools/livekit-agent-sidecar source package for native runtime install',
        managedRuntimes
      },
      null,
      2
    )}\n`
  );

  await ensureInfoPlistStringKey(
    join(packagePath, 'Contents', 'Info.plist'),
    'NSMicrophoneUsageDescription',
    'Batshit uses your microphone for speech-to-text, voice mode, and LiveKit voice sessions when you turn voice features on.'
  );
  await ensureInfoPlistStringKey(
    join(packagePath, 'Contents', 'Info.plist'),
    'NSSpeechRecognitionUsageDescription',
    'Batshit uses speech recognition for Browser speech-to-text and Voice Mode when you choose the browser speech engine.'
  );

  if (process.platform === 'darwin') {
    const args = ['--force', '--deep', '--sign', '-'];
    if (await exists(entitlementsPath)) {
      args.push('--entitlements', entitlementsPath);
    }
    args.push(packagePath);
    runChecked('codesign', args);
  }
}

await main();
