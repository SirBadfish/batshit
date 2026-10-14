// Installs the pinned Redis 8.10.1, with the JSON and search modules Batshit needs, into the
// launcher's runtime folder without root (SA-127 DL-03, DL-07). The result is always the same
// layout, bin/ beside lib/, and it is proven to start and answer JSON and search commands
// before it replaces anything.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  assertRedisRuntimeUsable,
  curateRedisMacosArchive,
  REDIS_BUNDLED_MODULES,
  REDIS_MACOS_PINNED_ARCHIVE_SHA256,
  REDIS_OPENSSL_LIBRARIES,
  REDIS_PINNED_VERSION,
  redisMacosArchive,
  relinkAndSignRedisMacosRuntime
} from '../../batshit-mac/scripts/redis-runtime.mjs';
import {
  inspectManagedRuntimePortability,
  MAC_RUNTIME_MINIMUM_VERSION
} from '../../batshit-mac/scripts/managed-runtime-portability.mjs';
import { readDebFiles } from './deb.mjs';

export { REDIS_BUNDLED_MODULES, REDIS_PINNED_VERSION };

// Linux uses Redis's own Ubuntu 22.04 ("jammy") packages from packages.redis.io: redis-server
// carries the server and the modules, redis-tools carries redis-cli. The jammy build is used on
// every Linux because its packages are zstd-compressed, which Node reads without any system
// tool (the Debian 12 packages use xz). The SHA-256 values come from Redis's signed apt index
// (key 5431 8FA4 052D 1E61 A6B6 F7BB 5F43 49D6 BF53 AA0C), checked 2026-09-26.
//
// Its search module links libcrypt.so.1, which Fedora, RHEL 9 and its rebuilds, and Arch do not
// install by default (they ship libcrypt.so.2), so the runtime carries Ubuntu 22.04's own
// libcrypt1 (libxcrypt 4.4.27, which needs only glibc), pinned from Ubuntu's signed index (key
// "Ubuntu Archive Automatic Signing Key (2018)"), checked 2026-09-26. OpenSSL 3 and the C++
// runtime (the search module needs GCC 12's libstdc++, newer than RHEL 9's) come from Pinokio's
// base environment, as OpenSSL does on macOS, so neither depends on what the system installed.
// What the system must still provide: glibc 2.34 or newer and libsystemd.
const REDIS_POOL_URL = 'https://packages.redis.io/deb/pool/jammy/r/re';
const LINUX_ARCHES = {
  x64: {
    deb: 'amd64',
    triplet: 'x86_64-linux-gnu',
    ubuntuPool: 'https://archive.ubuntu.com/ubuntu/pool/main/libx/libxcrypt',
    sha256: {
      'redis-server': '893a7ef3f48649fd655c5ff59d9f00309761f7c745257f18965f7283065aa43f',
      'redis-tools': 'f6906d5d68a06a45d343ec1a4f4d53b145a6c08e76f542af9f01cefad87d8219',
      libcrypt1: '3fa566e9f861a08736cbc5a97562d9d6e4f0c00450fbeafcb6d7583423b04a98'
    }
  },
  arm64: {
    deb: 'arm64',
    triplet: 'aarch64-linux-gnu',
    ubuntuPool: 'https://ports.ubuntu.com/ubuntu-ports/pool/main/libx/libxcrypt',
    sha256: {
      'redis-server': '0e64e97934dd8e20351b6e0fa1193f5c78d7e00d87af3984100573eca327f1c1',
      'redis-tools': '1348cd407c04dac9eb0e49b2f02860d85f066080162ce7c9411d0a71dd7d348b',
      libcrypt1: 'fb5f8d59de95bbb118a635e83e2a92077e13c6d297980dae3119df057bf88111'
    }
  }
};

// The libraries the runtime takes from Pinokio's base environment, by platform.
const BASE_LIBRARIES = {
  darwin: REDIS_OPENSSL_LIBRARIES,
  linux: ['libssl.so.3', 'libcrypto.so.3', 'libstdc++.so.6', 'libgcc_s.so.1']
};

// Each download: where it comes from, its pinned checksum, and (Linux packages) which of its
// files land where in the runtime. The macOS archive is curated by the shared Mac code.
export function redisRuntimeDownloads({ platform, arch }) {
  if (platform === 'darwin') {
    if (arch !== 'arm64') {
      throw new Error(
        'Batshit needs a Mac with Apple silicon (M1 or newer). Redis publishes its macOS build with the JSON and search modules for Apple silicon only.'
      );
    }
    const archive = redisMacosArchive(REDIS_PINNED_VERSION);
    return [
      { name: 'redis-macos', file: archive.filename, url: archive.url, sha256: REDIS_MACOS_PINNED_ARCHIVE_SHA256 }
    ];
  }
  if (platform === 'linux') {
    const target = LINUX_ARCHES[arch];
    if (!target) throw new Error(`Batshit runs on Linux on x64 or arm64 computers; this one is ${arch}.`);
    const redisFile = (pkg) => `${pkg}_8.10.1-1rl1~jammy1_${target.deb}.deb`;
    const libcryptFile = `libcrypt1_4.4.27-1_${target.deb}.deb`;
    return [
      {
        name: 'redis-server',
        file: redisFile('redis-server'),
        url: `${REDIS_POOL_URL}/${redisFile('redis-server')}`,
        sha256: target.sha256['redis-server'],
        files: [
          ['usr/bin/redis-server', 'bin/redis-server'],
          ...REDIS_BUNDLED_MODULES.map((name) => [`usr/lib/redis/modules/${name}`, `lib/${name}`])
        ]
      },
      {
        name: 'redis-tools',
        file: redisFile('redis-tools'),
        url: `${REDIS_POOL_URL}/${redisFile('redis-tools')}`,
        sha256: target.sha256['redis-tools'],
        files: [['usr/bin/redis-cli', 'bin/redis-cli']]
      },
      {
        name: 'libcrypt1',
        file: libcryptFile,
        url: `${target.ubuntuPool}/${libcryptFile}`,
        sha256: target.sha256.libcrypt1,
        files: [[`lib/${target.triplet}/libcrypt.so.1.1.0`, 'lib/libcrypt.so.1']]
      }
    ];
  }
  throw new Error(
    `The Pinokio launcher supports macOS and Linux. On ${platform}, install Batshit with Docker (see the Batshit docs).`
  );
}

// The environment Redis processes (redis-server, redis-cli) need on top of their parent's. On
// Linux the libraries in the runtime's lib/ are found through LD_LIBRARY_PATH, and only there;
// on macOS every binary already names its libraries by path.
export function redisProcessEnv(runtimeDir, platform = process.platform) {
  return platform === 'linux' ? { LD_LIBRARY_PATH: join(runtimeDir, 'lib') } : {};
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false
  );
}

async function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

// Downloads `entry` into `downloadsDir` unless a copy with the pinned checksum is already
// there. A file with any other checksum is deleted and is an error, never used.
export async function fetchPinned(entry, downloadsDir, { fetchImpl = fetch, log = () => {} } = {}) {
  await mkdir(downloadsDir, { recursive: true });
  const target = join(downloadsDir, entry.file);
  if ((await exists(target)) && (await sha256File(target)) === entry.sha256) {
    log(`Using the verified download ${entry.file}`);
    return target;
  }
  log(`Downloading ${entry.url}`);
  const response = await fetchImpl(entry.url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${entry.url} (HTTP ${response.status}).`);
  }
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const actual = await sha256File(partial);
  if (actual !== entry.sha256) {
    await rm(partial, { force: true });
    throw new Error(
      `${entry.file} failed its checksum: expected ${entry.sha256}, got ${actual}. The download was deleted; nothing was installed.`
    );
  }
  await rename(partial, target);
  log(`Verified ${entry.file} (SHA-256 ${entry.sha256.slice(0, 12)}...)`);
  return target;
}

export async function unpackLinuxPackages(downloads, downloadedPaths, stage) {
  await mkdir(join(stage, 'bin'), { recursive: true });
  await mkdir(join(stage, 'lib'), { recursive: true });
  for (const entry of downloads) {
    const found = readDebFiles(await readFile(downloadedPaths[entry.name]), entry.files.map(([from]) => from));
    for (const [from, to] of entry.files) {
      await writeFile(join(stage, to), found.get(from).data);
      await chmod(join(stage, to), 0o755);
    }
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.\n${output}`);
  }
  return result.stdout || '';
}

// Pinokio's base environment is a conda-forge install whose Node is the one running this file;
// its lib/ holds the OpenSSL 3 (and, on Linux, the C++ runtime) that Pinokio's own tools use.
export function pinokioBaseLibDir(nodePath = process.execPath) {
  return join(dirname(dirname(nodePath)), 'lib');
}

async function copyPinokioBaseLibraries(baseLibDir, stage, platform) {
  for (const library of BASE_LIBRARIES[platform]) {
    const source = join(baseLibDir, library);
    if (!(await exists(source))) {
      throw new Error(
        `${library} was not found in Pinokio's base environment at ${baseLibDir}. Batshit's Redis needs it; update Pinokio and try again.`
      );
    }
    await copyFile(source, join(stage, 'lib', library));
    await chmod(join(stage, 'lib', library), 0o755);
  }
  const metaDir = join(dirname(baseLibDir), 'conda-meta');
  const meta = (await readdir(metaDir).catch(() => [])).find((name) => /^openssl-\d.*\.json$/.test(name));
  return meta ? `Pinokio's base environment (conda-forge ${meta.replace(/\.json$/, '')})` : baseLibDir;
}

async function curateMacosArchive(archivePath, stage) {
  const extract = `${stage}-extract`;
  await rm(extract, { recursive: true, force: true });
  await mkdir(extract, { recursive: true });
  try {
    run('/usr/bin/unzip', ['-q', archivePath, '-d', extract]);
    await curateRedisMacosArchive(extract, stage);
  } finally {
    await rm(extract, { recursive: true, force: true });
  }
}

// Installs Redis into `dest`, replacing it only after the new copy passed its probe.
export async function installRedisRuntime({
  dest,
  downloadsDir,
  platform = process.platform,
  arch = process.arch,
  baseLibDir = pinokioBaseLibDir(),
  fetchImpl = fetch,
  log = () => {}
}) {
  const downloads = redisRuntimeDownloads({ platform, arch });
  const downloaded = {};
  for (const entry of downloads) {
    downloaded[entry.name] = await fetchPinned(entry, downloadsDir, { fetchImpl, log });
  }

  const stage = `${dest}.new`;
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  if (platform === 'darwin') {
    await curateMacosArchive(downloaded['redis-macos'], stage);
  } else {
    await unpackLinuxPackages(downloads, downloaded, stage);
  }
  const openssl = await copyPinokioBaseLibraries(baseLibDir, stage, platform);
  if (platform === 'darwin') {
    log('Linking Redis to OpenSSL and signing it for this Mac');
    await relinkAndSignRedisMacosRuntime(stage);
    const portability = await inspectManagedRuntimePortability(stage, {
      maximumMinimumVersion: MAC_RUNTIME_MINIMUM_VERSION
    });
    if (!portability.ok) {
      throw new Error(`The prepared Redis still depends on files outside its folder: ${portability.issues.join('; ')}`);
    }
  }

  // A short socket path: macOS refuses unix sockets longer than 104 bytes.
  const probeDir = await mkdtemp(join(tmpdir(), 'bs-redis-'));
  await assertRedisRuntimeUsable(stage, probeDir, log, {
    env: { ...process.env, ...redisProcessEnv(stage, platform) }
  });

  await writeFile(
    join(stage, 'SOURCE.json'),
    `${JSON.stringify(
      {
        redis: REDIS_PINNED_VERSION,
        platform,
        arch,
        downloads: downloads.map(({ url, sha256 }) => ({ url, sha256 })),
        modules: REDIS_BUNDLED_MODULES,
        openssl,
        preparedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
  await rm(dest, { recursive: true, force: true });
  await rename(stage, dest);
  log(`Redis ${REDIS_PINNED_VERSION} with RedisJSON and Search is ready.`);
  return dest;
}
