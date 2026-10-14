// Live proof of BL-111: Docker Batshit's Redis keeps its data in an append-only file, so a save
// survives a hard kill, and a volume from before that (a snapshot, dump.rdb, and nothing else) is
// switched once without losing a key. It runs the real `redis-init` and `redis` services from
// compose.yaml as a throwaway Compose project and removes its containers and volume afterwards.
// Skipped unless run deliberately on a computer where Docker is running:
//
//   BATSHIT_LIVE_DOCKER_REDIS=1 node --test tools/docker/compose-redis-persistence.live.test.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const LIVE = process.env.BATSHIT_LIVE_DOCKER_REDIS === '1'
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const COMPOSE_FILE = path.join(REPO_ROOT, 'compose.yaml')
const SWITCHED = /Redis now uses append-only persistence: (\d+) keys without an expiry kept\./

// One Compose project per test, with its own volume. The env file holds only the values Compose
// requires before it will read the file; no container here reads them.
async function project(t, name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'batshit-redis-persistence-'))
  const envFile = path.join(dir, '.env.docker')
  await writeFile(
    envFile,
    ['BATSHIT_TOKEN', 'ENCRYPTION_KEY', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].map((key) => `${key}=${'a'.repeat(64)}`).join('\n')
  )
  const projectName = `batshit-bl111-${name}-${process.pid}`
  const compose = (...args) =>
    execFileSync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, '--project-directory', REPO_ROOT, '--env-file', envFile, '--project-name', projectName, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BATSHIT_DOCKER_ENV_FILE: envFile } }
    )
  t.after(async () => {
    try {
      compose('down', '--remove-orphans')
    } finally {
      execFileSync('docker', ['volume', 'rm', '-f', `${projectName}_batshit_redis_data`], { stdio: 'ignore' })
      await rm(dir, { recursive: true, force: true })
    }
  })
  const redis = (...args) => compose('exec', '-T', 'redis', 'redis-cli', ...args).trim()
  const initLog = () => compose('logs', '--no-log-prefix', 'redis-init')
  return { compose, redis, initLog, container: `${projectName}-redis-1` }
}

// The state every Docker install had before BL-111: Redis's default config wrote only snapshots.
// Built through Compose, so the volume is the project's own, and with the image's own entrypoint,
// so it bypasses the redis service's refusal of a snapshot-only volume.
function seedSnapshotOnlyVolume({ compose }) {
  return compose(
    'run', '--rm', '--no-deps', '--entrypoint', 'sh', 'redis', '-c',
    [
      'docker-entrypoint.sh redis-server --appendonly no &',
      'until [ "$(redis-cli ping 2>/dev/null)" = PONG ]; do sleep 0.2; done',
      'redis-cli set seed:string kept >/dev/null',
      `redis-cli json.set seed:json '$' '{"kept":true}' >/dev/null`,
      'redis-cli hset seed:hash a 1 b 2 >/dev/null',
      'redis-cli sadd seed:set x y z >/dev/null',
      'redis-cli set seed:expiring soon EX 3600 >/dev/null',
      'redis-cli save >/dev/null',
      'redis-cli shutdown nosave >/dev/null 2>&1 || true',
      'wait',
      'ls /data'
    ].join('\n')
  )
}

const dumpHash = ({ compose }) =>
  compose('run', '--rm', '--no-deps', '--entrypoint', 'sha256sum', 'redis', '/data/dump.rdb').split(' ')[0]

test('a save survives a hard kill of Docker Redis (BL-111)', { skip: !LIVE }, async (t) => {
  const stack = await project(t, 'kill')
  stack.compose('up', '-d', '--wait', 'redis')
  assert.equal(stack.redis('config', 'get', 'appendonly').split('\n').at(-1), 'yes')
  assert.equal(stack.redis('config', 'get', 'appendfsync').split('\n').at(-1), 'everysec')
  assert.equal(stack.redis('set', 'proof:string', 'saved'), 'OK')
  assert.equal(stack.redis('json.set', 'proof:json', '$', '{"saved":true}'), 'OK')

  // SIGKILL: no shutdown save. Only the append-only file can bring these back.
  stack.compose('kill', '-s', 'SIGKILL', 'redis')
  stack.compose('up', '-d', '--wait', 'redis')

  assert.equal(stack.redis('get', 'proof:string'), 'saved')
  assert.equal(stack.redis('json.get', 'proof:json'), '{"saved":true}')
  assert.match(stack.redis('info', 'persistence'), /^aof_last_write_status:ok\r?$/m)
})

test('a snapshot-only volume switches to append-only once and keeps every key (BL-111)', { skip: !LIVE }, async (t) => {
  const stack = await project(t, 'switch')
  assert.match(seedSnapshotOnlyVolume(stack), /^dump\.rdb$/m)
  // What a switch killed part way leaves behind: its staging folder and Redis's rewrite temp file.
  stack.compose(
    'run', '--rm', '--no-deps', '--entrypoint', 'sh', 'redis', '-c',
    'mkdir -p /data/appendonlydir.switching && echo stale > /data/appendonlydir.switching/appendonly.aof.manifest && echo stale > /data/temp-rewriteaof-bg-99.aof'
  )
  const snapshot = dumpHash(stack)

  stack.compose('up', '-d', '--wait', 'redis')
  assert.equal(stack.initLog().match(SWITCHED)?.[1], '4', 'the four keys without an expiry are counted and kept')
  const dataFolder = stack.compose('run', '--rm', '--no-deps', '--entrypoint', 'ls', 'redis', '-A', '/data').split(/\s+/).filter(Boolean)
  assert.deepEqual(dataFolder.sort(), ['appendonlydir', 'dump.rdb'], 'the leftovers were removed and rebuilt')
  assert.equal(stack.redis('get', 'seed:string'), 'kept')
  assert.equal(stack.redis('json.get', 'seed:json'), '{"kept":true}')
  assert.equal(stack.redis('hget', 'seed:hash', 'b'), '2')
  assert.equal(stack.redis('scard', 'seed:set'), '3')
  assert.equal(stack.redis('get', 'seed:expiring'), 'soon')
  assert.ok(Number(stack.redis('ttl', 'seed:expiring')) > 0, 'the expiry is kept')
  assert.equal(stack.redis('dbsize'), '5')

  // The switch never writes dump.rdb (checked while Redis runs: a clean stop saves a new one).
  assert.equal(dumpHash(stack), snapshot)

  // A second start runs the same redis-init container again (its log keeps both runs). It finds
  // the append-only file and leaves it.
  stack.compose('up', '-d', '--force-recreate', '--wait', 'redis')
  const log = stack.initLog()
  assert.equal(log.match(/Redis data directory prepared/g)?.length, 2)
  assert.equal(log.match(/Switching Redis/g)?.length, 1)
  assert.equal(stack.redis('get', 'seed:string'), 'kept')

  stack.compose('kill', '-s', 'SIGKILL', 'redis')
  stack.compose('up', '-d', '--wait', 'redis')
  assert.equal(stack.redis('json.get', 'seed:json'), '{"kept":true}')
})

test('Docker Redis refuses a snapshot-only volume when redis-init is skipped (BL-111)', { skip: !LIVE }, async (t) => {
  const stack = await project(t, 'refuse')
  seedSnapshotOnlyVolume(stack)
  const snapshot = dumpHash(stack)

  // `--no-deps` starts redis without redis-init. With appendonly yes it would load nothing from
  // the snapshot and then overwrite it with the empty dataset, so it must refuse instead.
  stack.compose('up', '-d', '--no-deps', 'redis')
  const deadline = Date.now() + 30_000
  let exitCode = null
  while (Date.now() < deadline) {
    exitCode = execFileSync('docker', ['inspect', '-f', '{{.State.ExitCode}}', stack.container], { encoding: 'utf8' }).trim()
    if (exitCode === '1') break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.equal(exitCode, '1')
  const logs = spawnSync('docker', ['logs', stack.container], { encoding: 'utf8' })
  assert.match(logs.stdout + logs.stderr, /holds a Redis snapshot \(dump\.rdb\) but no append-only file yet/)
  stack.compose('stop', 'redis')
  assert.equal(dumpHash(stack), snapshot, 'the snapshot is untouched')

  // The normal start runs redis-init first and switches it.
  stack.compose('up', '-d', '--wait', 'redis')
  assert.equal(stack.initLog().match(SWITCHED)?.[1], '4')
  assert.equal(stack.redis('get', 'seed:string'), 'kept')
})

test('an append-only folder with no manifest is refused, not ignored (BL-111)', { skip: !LIVE }, async (t) => {
  const stack = await project(t, 'manifest')
  seedSnapshotOnlyVolume(stack)
  // Redis loads appendonlydir through its manifest. Without one it ignores the folder and starts
  // EMPTY even beside dump.rdb (measured on 8.10.1), so neither the switch nor Redis may proceed.
  stack.compose('run', '--rm', '--no-deps', '--entrypoint', 'mkdir', 'redis', '/data/appendonlydir')
  const snapshot = dumpHash(stack)

  assert.throws(() => stack.compose('up', '-d', '--wait', 'redis'))
  assert.match(stack.initLog(), /appendonlydir has no manifest, so Redis would ignore it and start empty/)
  assert.equal(dumpHash(stack), snapshot, 'the snapshot is untouched')
})
