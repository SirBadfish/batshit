// Redis 8 runtime steps shared by the Mac app's asset preparation
// (prepare-managed-runtime-assets.mjs) and the Pinokio launcher (pinokio/lib/redis-runtime.mjs),
// so both install the same pinned Redis the same way (SA-127 DL-03). The layout they build is
// bin/ (redis-server, redis-cli, ...) beside lib/ (the modules, flattened, plus any bundled
// libraries), which is what the probe below and both launchers expect.
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  isMachOFile,
  parseOtoolInstallName,
  parseOtoolLibraries
} from './managed-runtime-portability.mjs';

export const REDIS_PINNED_VERSION = '8.10.1';

// SA-101 / DL-101-03: the macOS archive is pinned by exact SHA-256, not merely recorded. This
// is the arm64 hash published by the official `redis/homebrew-redis` cask for this version.
export const REDIS_MACOS_PINNED_ARCHIVE_SHA256 =
  '3e7966a847255580f93fac2398d99c20d80583decf10f194b60fe20a7724e433';

export function redisMacosArchive(version = REDIS_PINNED_VERSION) {
  const filename = `redis-oss-${version}-arm64.zip`;
  return { filename, url: `https://packages.redis.io/homebrew/${filename}` };
}

// Only the modules Batshit actually needs are bundled. Batshit stores JSON records, and a
// data file written by any Redis Stack server carries a RediSearch AUX marker that Redis 8
// refuses to load without RediSearch present. Bloom and TimeSeries stamp no such marker and
// are not used, so they stay out of the signing and audit surface.
export const REDIS_BUNDLED_MODULES = ['rejson.so', 'redisearch.so'];
// redis-check-aof / redis-check-rdb are the documented repair path for the AOF-first Mac
// lane. redis-benchmark and redis-sentinel have no Batshit use and are not bundled.
export const REDIS_BUNDLED_BINARIES = ['redis-server', 'redis-cli', 'redis-check-aof', 'redis-check-rdb'];
// redisearch.so links libunwind from a Homebrew llvm@18 path that does not exist on a user's
// Mac. It needs exactly the 13 standard Itanium C++ ABI _Unwind_* symbols, all of which macOS
// exports from libSystem. Substituting leaves one unwinder in the process (Apple's, which the
// redis-server core already uses via libc++abi) rather than loading a second one.
export const REDIS_UNWINDER_SUBSTITUTIONS = new Map([['libunwind.1.dylib', '/usr/lib/libSystem.B.dylib']]);
// The macOS archive links OpenSSL from Homebrew's prefix. Both launchers put an OpenSSL 3 build
// beside the modules in lib/ and point every Redis binary and module at it.
export const REDIS_OPENSSL_LIBRARIES = ['libssl.3.dylib', 'libcrypto.3.dylib'];

function runTool(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.\n${output}`);
  }
  return result.stdout || '';
}

async function pathExists(path) {
  return access(path).then(
    () => true,
    () => false
  );
}

async function machOFilesIn(rootDir) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && (await isMachOFile(path))) files.push(path);
    }
  }
  await walk(rootDir);
  return files;
}

// Curate the bundle explicitly instead of copying the whole archive: only the binaries and
// modules Batshit runs are kept, and the modules are flattened into lib/ so every Mach-O sits
// at a known depth relative to the OpenSSL dylibs placed in lib/. `dest` must be empty.
export async function curateRedisMacosArchive(sourceDir, dest) {
  await mkdir(join(dest, 'bin'), { recursive: true });
  await mkdir(join(dest, 'lib'), { recursive: true });
  for (const name of REDIS_BUNDLED_BINARIES) {
    const source = join(sourceDir, 'bin', name);
    if (!(await pathExists(source))) {
      throw new Error(`Redis archive is missing bin/${name}: ${source}`);
    }
    await cp(source, join(dest, 'bin', name));
    await chmod(join(dest, 'bin', name), 0o755);
  }
  for (const name of REDIS_BUNDLED_MODULES) {
    const source = join(sourceDir, 'lib', 'redis', 'modules', name);
    if (!(await pathExists(source))) {
      throw new Error(`Redis archive is missing lib/redis/modules/${name}: ${source}`);
    }
    await cp(source, join(dest, 'lib', name));
    await chmod(join(dest, 'lib', name), 0o755);
  }
}

// Point every Mach-O under `dest` at the OpenSSL dylibs in lib/ and at Apple's unwinder, then
// ad-hoc sign them. Rewriting load commands invalidates the archive's own signature (hardened
// runtime, Redis's team), and an unsigned arm64 binary does not run, so signing is not optional.
export async function relinkAndSignRedisMacosRuntime(dest) {
  for (const file of await machOFilesIn(dest)) {
    const relativePath = file.slice(dest.length + 1);
    const bundledPrefix = relativePath.startsWith('bin/') ? '@loader_path/../lib' : '@loader_path';
    const installName = parseOtoolInstallName(runTool('otool', ['-D', file]));
    // A module whose own install name is a build-machine path would otherwise survive the
    // portability audit through the "dependency === installName" allowance. Rewrite it.
    if (installName && (installName.startsWith('/Users/') || installName.startsWith('/opt/homebrew/'))) {
      runTool('install_name_tool', ['-id', basename(file), file]);
    }
    for (const dependency of parseOtoolLibraries(runTool('otool', ['-L', file]))) {
      if (dependency === installName) continue;
      for (const library of REDIS_OPENSSL_LIBRARIES) {
        if (!dependency.endsWith(`/${library}`)) continue;
        runTool('install_name_tool', ['-change', dependency, `${bundledPrefix}/${library}`, file]);
      }
      for (const [library, replacement] of REDIS_UNWINDER_SUBSTITUTIONS) {
        if (!dependency.endsWith(`/${library}`)) continue;
        runTool('install_name_tool', ['-change', dependency, replacement, file]);
      }
    }
  }
  for (const file of await machOFilesIn(dest)) {
    runTool('codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
  }
}

// A prepared runtime that cannot actually start is worse than a missing one, because every
// later step would pass on bytes that fail on the user's machine. Boot the prepared server
// with its modules and prove RedisJSON and Search answer. Works for any bin/ + lib/ runtime
// (macOS or Linux). `probeDir` is emptied and removed; keep its path short, since a unix
// socket path must stay under 104 bytes on macOS. `env` is the environment for the Redis
// processes (the Linux runtime finds its bundled libraries through LD_LIBRARY_PATH).
export async function assertRedisRuntimeUsable(dest, probeDir, log = () => {}, { env = process.env } = {}) {
  await rm(probeDir, { recursive: true, force: true });
  await mkdir(probeDir, { recursive: true });
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
  const server = spawn(serverBin, args, { stdio: 'ignore', detached: true, env });
  server.unref();
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ping = spawnSync(cliBin, ['-s', socketPath, 'PING'], { encoding: 'utf8', env });
      if (ping.stdout?.trim() === 'PONG') { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) {
      const logText = await readFile(join(probeDir, 'redis.log'), 'utf8').catch(() => '');
      throw new Error(`Prepared Redis runtime did not start.\n${logText}`);
    }
    const check = (cmdArgs, label, predicate) => {
      const result = spawnSync(cliBin, ['-s', socketPath, ...cmdArgs], { encoding: 'utf8', env });
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
    spawnSync(cliBin, ['-s', socketPath, 'SHUTDOWN', 'NOSAVE'], { encoding: 'utf8', env });
    await rm(probeDir, { recursive: true, force: true });
  }
}
