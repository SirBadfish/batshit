import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'prepare-managed-runtime-assets.mjs');
const version = '24.21.0';
const filename = `node-v${version}-darwin-arm64.tar.xz`;

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

async function fakeNodeDistribution(root, actualVersion) {
  const bin = join(root, 'bin');
  const npmBin = join(root, 'lib', 'node_modules', 'npm', 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(npmBin, { recursive: true });
  const executable = join(bin, 'node');
  await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'v${actualVersion}\\n'; exit 0; fi\nif [ "$2" = "--version" ]; then printf '11.0.0\\n'; exit 0; fi\nexit 1\n`);
  await chmod(executable, 0o755);
  await writeFile(join(npmBin, 'npm-cli.js'), 'fixture npm\n');
  await writeFile(join(npmBin, 'npx-cli.js'), 'fixture npx\n');
  await symlink('../lib/node_modules/npm/bin/npm-cli.js', join(bin, 'npm'));
  await symlink('../lib/node_modules/npm/bin/npx-cli.js', join(bin, 'npx'));
}

async function cachedArchive(root, actualVersion, validChecksum = true) {
  const staging = join(root, 'staging');
  const distribution = join(staging, `node-v${version}-darwin-arm64`);
  await fakeNodeDistribution(distribution, actualVersion);
  const downloads = join(root, 'downloads');
  await mkdir(downloads, { recursive: true });
  const archive = join(downloads, filename);
  const tar = run('tar', ['-cJf', archive, '-C', staging, `node-v${version}-darwin-arm64`]);
  assert.equal(tar.status, 0, tar.stderr);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(join(downloads, `node-v${version}-SHASUMS256.txt`),
    `${validChecksum ? sha256 : '0'.repeat(64)}  ${filename}\n`);
  return sha256;
}

function prepare(root) {
  return run(process.execPath, [script, '--only', 'node'], {
    ...process.env,
    BATSHIT_MAC_NODE_VERSION: version,
    BATSHIT_MAC_RUNTIME_ASSET_ROOT: root
  });
}

test('replaces a valid stale Node cache, reuses the requested version, and preserves checksum verification',
  { skip: process.platform !== 'darwin' }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'batshit-node-pin-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cached = join(root, 'assets', 'node');
    await fakeNodeDistribution(cached, '24.17.0');
    await writeFile(join(cached, 'SOURCE.txt'), 'Node.js 24.17.0 cached fixture\n');
    await writeFile(join(cached, 'old-marker'), 'old\n');
    const sha256 = await cachedArchive(root, version);

    const upgraded = prepare(root);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal(run(join(cached, 'bin', 'node'), ['--version']).stdout.trim(), `v${version}`);
    assert.match(await readFile(join(cached, 'SOURCE.txt'), 'utf8'), /Node\.js 24\.21\.0/);
    assert.equal(await readFile(join(cached, 'CHECKSUMS.txt'), 'utf8'), `${sha256}  ${filename}\n`);
    await assert.rejects(readFile(join(cached, 'old-marker')));

    await writeFile(join(cached, 'reuse-marker'), 'reuse\n');
    const reused = prepare(root);
    assert.equal(reused.status, 0, reused.stderr);
    assert.equal(await readFile(join(cached, 'reuse-marker'), 'utf8'), 'reuse\n');

    await writeFile(join(cached, 'SOURCE.txt'), 'Node.js 24.17.0 cached fixture\n');
    const staleSource = prepare(root);
    assert.equal(staleSource.status, 0, staleSource.stderr);
    await assert.rejects(readFile(join(cached, 'reuse-marker')));
  });

test('rejects a wrong Node archive checksum before replacing the stale cache',
  { skip: process.platform !== 'darwin' }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'batshit-node-shasum-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cached = join(root, 'assets', 'node');
    await fakeNodeDistribution(cached, '24.17.0');
    await writeFile(join(cached, 'SOURCE.txt'), 'Node.js 24.17.0 cached fixture\n');
    await cachedArchive(root, version, false);

    const result = prepare(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Node checksum mismatch/);
    assert.equal(run(join(cached, 'bin', 'node'), ['--version']).stdout.trim(), 'v24.17.0');
  });

test('rejects a checksum-valid archive with the wrong Node version before replacing the stale cache',
  { skip: process.platform !== 'darwin' }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'batshit-node-version-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cached = join(root, 'assets', 'node');
    await fakeNodeDistribution(cached, '24.17.0');
    await writeFile(join(cached, 'SOURCE.txt'), 'Node.js 24.17.0 cached fixture\n');
    await cachedArchive(root, '24.20.0');

    const result = prepare(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Downloaded Node runtime version mismatch: expected v24\.21\.0, got v24\.20\.0/);
    assert.equal(run(join(cached, 'bin', 'node'), ['--version']).stdout.trim(), 'v24.17.0');
  });
