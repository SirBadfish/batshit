import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readlink, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inspectManagedRuntimePortability,
  MAC_RUNTIME_MINIMUM_VERSION
} from './managed-runtime-portability.mjs';
import {
  HAIR_CATALOG_PACKAGE_CONTRACT,
  validateHairCatalogPackageDefinition
} from './hair-catalog-package-contract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const macRoot = resolve(__dirname, '..');
const repoRoot = resolve(macRoot, '..');
const packagePath = resolve(process.argv[2] || join(macRoot, 'zig-out/package/Batshit.app'));
const resourcesPath = join(packagePath, 'Contents', 'Resources');
const runtimePath = join(resourcesPath, 'runtime');

const appSource = join(repoRoot, 'batshit-app');
const serverSource = join(repoRoot, 'batshit-server', 'server');
const liveKitSidecarSource = join(repoRoot, 'tools', 'livekit-agent-sidecar');
const facialArtworkSource = join(appSource, 'static', 'goons', 'facial-artwork', 'v6');
const lipArtworkSource = join(appSource, 'static', 'goons', 'lip-artwork', 'v2');
const nailSurfaceSource = join(appSource, 'static', 'goons', 'nail-surface', 'v1');
const skinAppearanceSource = join(appSource, 'static', 'goons', 'skin-appearance', 'v1');
const hairCatalogSource = join(repoRoot, ...HAIR_CATALOG_PACKAGE_CONTRACT.runtimeRoot.split('/'));
const clothingCatalogSource = join(appSource, 'static', 'goon-assets', 'clothing', 'v1');
const appDest = join(runtimePath, 'batshit-app');
const serverDest = join(runtimePath, 'batshit-server', 'server');
const liveKitSidecarDest = join(runtimePath, 'tools', 'livekit-agent-sidecar');
const facialArtworkDest = join(runtimePath, 'assets', 'goons', 'facial-artwork', 'v6');
const FACIAL_ARTWORK_RUNTIME_FILE_COUNT = 161;
const lipArtworkDest = join(runtimePath, 'assets', 'goons', 'lip-artwork', 'v2');
const nailSurfaceDest = join(runtimePath, 'assets', 'goons', 'nail-surface', 'v1');
const skinAppearanceDest = join(runtimePath, 'assets', 'goons', 'skin-appearance', 'v1');
const hairCatalogDest = join(runtimePath, ...HAIR_CATALOG_PACKAGE_CONTRACT.runtimeRoot.split('/'));
const clothingCatalogDest = join(appDest, 'static', 'goon-assets', 'clothing', 'v1');
const nodeRuntimeDest = join(runtimePath, 'vendor', 'node');
const redisRuntimeDest = join(runtimePath, 'vendor', 'redis');
const ffmpegRuntimeDest = join(runtimePath, 'vendor', 'ffmpeg');
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

function setInfoPlistStringKey(plistPath, key, value) {
  const replace = spawnSync('plutil', ['-replace', key, '-string', value, plistPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (replace.status === 0) return;
  runChecked('plutil', ['-insert', key, '-string', value, plistPath]);
}

async function copyRequired(source, dest, { dereference = true } = {}) {
  if (!(await exists(source))) throw new Error(`Missing package input: ${source}`);
  await cp(source, dest, {
    recursive: true,
    dereference,
    verbatimSymlinks: !dereference,
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

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function inventoryFiles(root, relativeRoot = '') {
  const directory = join(root, relativeRoot);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await inventoryFiles(root, relative)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Trusted Goon artwork assets may only contain regular files: ${join(root, relative)}`);
    }
    files.push({
      path: relative.split('\\').join('/'),
      sha256: await sha256File(join(root, relative))
    });
  }
  return files;
}

async function copyFacialArtworkAssets() {
  await copyRequired(facialArtworkSource, facialArtworkDest);
  const files = await inventoryFiles(facialArtworkSource);
  if (
    files.length !== FACIAL_ARTWORK_RUNTIME_FILE_COUNT ||
    !files.some((entry) => entry.path === 'facial-artwork-v6.json')
  ) {
    throw new Error(
      `Facial artwork package input is incomplete: expected the v6 definition plus retained r1/r2/r3/r4 and current r5 assets (${FACIAL_ARTWORK_RUNTIME_FILE_COUNT} files), found ${files.length}`
    );
  }
  return {
    contract: 'facial-artwork/v6',
    root: 'assets/goons/facial-artwork/v6',
    definition: 'facial-artwork-v6.json',
    files
  };
}

async function copyLipArtworkAssets() {
  await copyRequired(lipArtworkSource, lipArtworkDest);
  const files = await inventoryFiles(lipArtworkSource);
  if (files.length !== 5 || !files.some((entry) => entry.path === 'lip-artwork-v2.json')) {
    throw new Error(
      `Lip Artwork package input is incomplete: expected the v2 definition plus four template assets, found ${files.length}`
    );
  }
  return {
    contract: 'lip-artwork/v2',
    root: 'assets/goons/lip-artwork/v2',
    definition: 'lip-artwork-v2.json',
    files
  };
}

async function copyNailSurfaceAssets() {
  await copyRequired(nailSurfaceSource, nailSurfaceDest);
  const files = await inventoryFiles(nailSurfaceSource);
  if (files.length !== 9 || !files.some((entry) => entry.path === 'nail-surface-v1.json')) {
    throw new Error(
      `Nail Surface package input is incomplete: expected the v1 definition plus eight finger/toe template assets, found ${files.length}`
    );
  }
  return {
    contract: 'nail-surface/v1',
    root: 'assets/goons/nail-surface/v1',
    definition: 'nail-surface-v1.json',
    files
  };
}

async function copySkinAppearanceAssets() {
  await copyRequired(skinAppearanceSource, skinAppearanceDest);
  const files = await inventoryFiles(skinAppearanceSource);
  if (files.length !== 5 || !files.some((entry) => entry.path === 'skin-appearance-v1.json')) {
    throw new Error(
      `Skin Appearance package input is incomplete: expected the v1 definition plus four region masks, found ${files.length}`
    );
  }
  return {
    contract: 'skin-appearance/v1',
    root: 'assets/goons/skin-appearance/v1',
    definition: 'skin-appearance-v1.json',
    files
  };
}

async function copyHairCatalogAssets() {
  await copyRequired(hairCatalogSource, hairCatalogDest);
  const files = await inventoryFiles(hairCatalogSource);
  const catalog = files.find(
    (entry) => entry.path === HAIR_CATALOG_PACKAGE_CONTRACT.definition
  );
  if (!catalog) {
    throw new Error('Hair Asset package input is incomplete: expected the hair-catalog/v2 catalog.');
  }
  const parsed = JSON.parse(
    await readFile(join(hairCatalogSource, HAIR_CATALOG_PACKAGE_CONTRACT.definition), 'utf8')
  );
  validateHairCatalogPackageDefinition(parsed);
  return {
    contract: HAIR_CATALOG_PACKAGE_CONTRACT.contract,
    root: HAIR_CATALOG_PACKAGE_CONTRACT.runtimeRoot,
    definition: HAIR_CATALOG_PACKAGE_CONTRACT.definition,
    files
  };
}

async function copyClothingCatalogAssets() {
  await copyRequired(clothingCatalogSource, clothingCatalogDest);
  const files = await inventoryFiles(clothingCatalogSource);
  const catalog = files.find((entry) => entry.path === 'catalog.json');
  if (!catalog) {
    throw new Error(
      'Clothing Asset package input is incomplete: expected the clothing-catalog/v1 catalog.'
    );
  }
  const parsed = JSON.parse(await readFile(join(clothingCatalogSource, 'catalog.json'), 'utf8'));
  if (
    parsed?.schemaVersion !== 'clothing-catalog/v1' ||
    !Array.isArray(parsed?.assets) ||
    Object.keys(parsed).sort().join(',') !== 'assets,schemaVersion'
  ) {
    throw new Error('Clothing Asset package input contains an invalid clothing-catalog/v1 catalog.');
  }
  return {
    contract: 'clothing-catalog/v1',
    root: 'batshit-app/static/goon-assets/clothing/v1',
    definition: 'catalog.json',
    files
  };
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
  if (!source) {
    throw new Error(
      'BATSHIT_MAC_NODE_DIST_DIR is required because the packaged Electron shell cannot start Batshit services without its app-owned Node.js runtime. Run npm run prepare:managed-runtimes, source the generated environment file it reports, then run npm run package:mac.'
    );
  }

  const resolvedSource = resolve(source);
  const nodeBin = join(resolvedSource, 'bin', 'node');
  const licensePath = join(resolvedSource, 'LICENSE');
  if (!(await exists(nodeBin))) {
    throw new Error(`BATSHIT_MAC_NODE_DIST_DIR must point at an unpacked Node distribution with bin/node: ${resolvedSource}`);
  }
  if (!(await exists(licensePath))) {
    throw new Error(`BATSHIT_MAC_NODE_DIST_DIR must include Node license files: ${licensePath}`);
  }
  const portability = await inspectManagedRuntimePortability(resolvedSource);
  if (!portability.ok) {
    throw new Error(
      `BATSHIT_MAC_NODE_DIST_DIR is not clean-machine portable:\n- ${portability.issues.join('\n- ')}`
    );
  }
  const proof = await runtimeProofFiles(resolvedSource, 'BATSHIT_MAC_NODE_DIST_DIR');

  await copyRequired(resolvedSource, nodeRuntimeDest, { dereference: false });
  for (const command of ['npm', 'npx']) {
    const commandPath = join(nodeRuntimeDest, 'bin', command);
    const commandInfo = await lstat(commandPath).catch(() => null);
    if (!commandInfo?.isSymbolicLink()) {
      throw new Error(`Packaged Node runtime must preserve the official bin/${command} symlink.`);
    }
    const target = await readlink(commandPath);
    const relativeTarget = relative(nodeRuntimeDest, resolve(dirname(commandPath), target));
    if (
      isAbsolute(target) ||
      relativeTarget === '' ||
      relativeTarget.startsWith('..') ||
      isAbsolute(relativeTarget)
    ) {
      throw new Error(
        `Packaged Node runtime bin/${command} must remain a relative link inside the app-owned Node runtime.`
      );
    }
  }
  const npmProbe = runCaptured(
    join(nodeRuntimeDest, 'bin', 'node'),
    [join(nodeRuntimeDest, 'bin', 'npm'), '--version']
  );
  if (!npmProbe.ok) {
    throw new Error(
      `Packaged Node runtime npm launcher failed: ${npmProbe.stderr.trim() || npmProbe.error?.message || 'unknown error'}`
    );
  }
  return {
    node: {
      distribution: 'Node.js official macOS arm64 runtime archive',
      appBundlePath: 'Contents/Resources/runtime/vendor/node',
      minimumMacosVersion: MAC_RUNTIME_MINIMUM_VERSION,
      license: 'Contents/Resources/runtime/vendor/node/LICENSE',
      sourceReference: `Contents/Resources/runtime/vendor/node/${proof.sourceReference}`,
      checksums: `Contents/Resources/runtime/vendor/node/${proof.checksums}`
    }
  };
}

async function copyManagedRedisRuntime() {
  const source = process.env.BATSHIT_MAC_REDIS_DIST_DIR || process.env.BATSHIT_MAC_REDIS_RUNTIME_DIR;
  if (!source) return null;

  const resolvedSource = resolve(source);
  // Every binary and module the supervisor actually launches must be present at packaging
  // time. The previous list covered only two of the six modules it loaded, so a missing
  // module reached users as a runtime failure instead of a build failure.
  const requiredFiles = [
    'bin/redis-server',
    'bin/redis-cli',
    'bin/redis-check-aof',
    'bin/redis-check-rdb',
    'lib/redisearch.so',
    'lib/rejson.so',
    'lib/libssl.3.dylib',
    'lib/libcrypto.3.dylib',
    'share/redis/LICENSE.txt',
    'share/redis/REDISCONTRIBUTIONS.txt',
    'share/openssl/LICENSE.txt',
    'share/openssl/SOURCE.txt',
    'share/openssl/CHECKSUMS.txt'
  ];
  for (const relative of requiredFiles) {
    if (!(await exists(join(resolvedSource, relative)))) {
      throw new Error(`BATSHIT_MAC_REDIS_DIST_DIR is missing ${relative}: ${resolvedSource}`);
    }
  }
  const portability = await inspectManagedRuntimePortability(resolvedSource);
  if (!portability.ok) {
    throw new Error(
      `BATSHIT_MAC_REDIS_DIST_DIR is not clean-machine portable:\n- ${portability.issues.join('\n- ')}`
    );
  }
  const proof = await runtimeProofFiles(resolvedSource, 'BATSHIT_MAC_REDIS_DIST_DIR');

  await copyRequired(resolvedSource, redisRuntimeDest);
  return {
    redis: {
      distribution: 'Redis Open Source macOS arm64 runtime archive',
      appBundlePath: 'Contents/Resources/runtime/vendor/redis',
      // Redis 8 is tri-licensed (RSALv2 / SSPLv1 / AGPLv3) in a single LICENSE.txt, replacing
      // the separate RSALv2.txt + SSPLv1.txt the retired Redis Stack archive shipped.
      licenses: [
        'Contents/Resources/runtime/vendor/redis/share/redis/LICENSE.txt',
        'Contents/Resources/runtime/vendor/redis/share/redis/REDISCONTRIBUTIONS.txt',
        'Contents/Resources/runtime/vendor/redis/share/openssl/LICENSE.txt'
      ],
      bundledOpenSslSource: 'Contents/Resources/runtime/vendor/redis/share/openssl/SOURCE.txt',
      bundledOpenSslChecksums: 'Contents/Resources/runtime/vendor/redis/share/openssl/CHECKSUMS.txt',
      minimumMacosVersion: MAC_RUNTIME_MINIMUM_VERSION,
      sourceReference: `Contents/Resources/runtime/vendor/redis/${proof.sourceReference}`,
      checksums: `Contents/Resources/runtime/vendor/redis/${proof.checksums}`
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
  const portability = await inspectManagedRuntimePortability(resolvedSource);
  if (!portability.ok) {
    throw new Error(
      `BATSHIT_MAC_FFMPEG_DIST_DIR is not clean-machine portable:\n- ${portability.issues.join('\n- ')}`
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
      minimumMacosVersion: MAC_RUNTIME_MINIMUM_VERSION,
      license: `Contents/Resources/runtime/vendor/ffmpeg/${license}`,
      buildConfig: `Contents/Resources/runtime/vendor/ffmpeg/${buildConfig}`,
      sourceReference: `Contents/Resources/runtime/vendor/ffmpeg/${proof.sourceReference}`,
      checksums: `Contents/Resources/runtime/vendor/ffmpeg/${proof.checksums}`
    }
  };
}

async function pruneOnnxRuntimeDeadWeight(packageRoot) {
  // The built-in memory embedder dependency (@huggingface/transformers) installs
  // onnxruntime binaries for every platform plus a browser/wasm build; the packaged
  // app only ever loads darwin/arm64 onnxruntime-node. The rest is ~300MB of dead
  // weight and package-audit noise.
  const onnxNodeBin = join(packageRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  await rm(join(packageRoot, 'node_modules', 'onnxruntime-web'), { recursive: true, force: true });
  await rm(join(onnxNodeBin, 'win32'), { recursive: true, force: true });
  await rm(join(onnxNodeBin, 'linux'), { recursive: true, force: true });
  const keptBinding = join(onnxNodeBin, 'darwin', 'arm64', 'onnxruntime_binding.node');
  if (!(await exists(keptBinding))) {
    throw new Error(
      `onnxruntime prune expected the darwin/arm64 binding to remain at ${keptBinding}; ` +
        'the onnxruntime-node layout changed - re-verify the prune before packaging'
    );
  }
}

export async function pruneForeignBcryptPrebuilds(packageRoot, targetArch = process.arch) {
  const prebuildsRoot = join(packageRoot, 'node_modules', 'bcrypt', 'prebuilds');
  const target = `darwin-${targetArch}`;
  for (const candidate of ['darwin-arm64', 'darwin-x64']) {
    if (candidate !== target) {
      await rm(join(prebuildsRoot, candidate), { recursive: true, force: true });
    }
  }
  const keptBinding = join(prebuildsRoot, target, 'bcrypt.node');
  if (!(await exists(keptBinding))) {
    throw new Error(
      `bcrypt prune expected the ${target} binding to remain at ${keptBinding}; ` +
        'the bcrypt prebuild layout changed - re-verify the prune before packaging'
    );
  }
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
  await cp(
    join(macRoot, 'scripts', 'managed-runtime-portability.mjs'),
    join(resourcesPath, 'scripts', 'managed-runtime-portability.mjs')
  );
  await cp(
    join(macRoot, 'scripts', 'hair-catalog-package-contract.mjs'),
    join(resourcesPath, 'scripts', 'hair-catalog-package-contract.mjs')
  );
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
  await pruneOnnxRuntimeDeadWeight(appDest);
  await pruneForeignBcryptPrebuilds(appDest);

  const systemPrompts = join(repoRoot, 'docs', 'batshit_System_Prompts');
  if (await exists(systemPrompts)) {
    await copyRequired(systemPrompts, join(runtimePath, 'docs', 'batshit_System_Prompts'));
  }
  const n8nTemplates = join(repoRoot, 'docs', 'user-docs', 'user-templates', 'batshit-official-n8n-workflow-templates');
  if (await exists(n8nTemplates)) {
    await copyRequired(n8nTemplates, join(runtimePath, 'docs', 'user-docs', 'user-templates', 'batshit-official-n8n-workflow-templates'));
  }
  const facialArtworkAssets = await copyFacialArtworkAssets();
  const lipArtworkAssets = await copyLipArtworkAssets();
  const nailSurfaceAssets = await copyNailSurfaceAssets();
  const skinAppearanceAssets = await copySkinAppearanceAssets();
  const hairCatalogAssets = await copyHairCatalogAssets();
  const clothingCatalogAssets = await copyClothingCatalogAssets();
  await copyLiveKitSidecarSourcePackage();
  const managedRuntimeEntries = await Promise.all([
    copyManagedNodeRuntime(),
    copyManagedRedisRuntime(),
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
        assets: {
          facialArtwork: facialArtworkAssets,
          lipArtwork: lipArtworkAssets,
          nailSurface: nailSurfaceAssets,
          skinAppearance: skinAppearanceAssets,
          hairCatalog: hairCatalogAssets,
          clothingCatalog: clothingCatalogAssets
        },
        managedRuntimes
      },
      null,
      2
    )}\n`
  );

  setInfoPlistStringKey(
    join(packagePath, 'Contents', 'Info.plist'),
    'NSMicrophoneUsageDescription',
    'Batshit uses your microphone for speech-to-text, voice mode, and LiveKit voice sessions when you turn voice features on.'
  );
  setInfoPlistStringKey(
    join(packagePath, 'Contents', 'Info.plist'),
    'NSSpeechRecognitionUsageDescription',
    'Batshit uses speech recognition for Browser speech-to-text and Voice Mode when you choose the browser speech engine.'
  );
  setInfoPlistStringKey(
    join(packagePath, 'Contents', 'Info.plist'),
    'LSMinimumSystemVersion',
    MAC_RUNTIME_MINIMUM_VERSION
  );

}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
