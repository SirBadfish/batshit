// The Docker host operator's login item (2026-09-21, BL-59). Run with `node --test tools/docker/*.test.mjs`.
// It used to be `KeepAlive` true, so the operator ran from login forever; now launchd restarts it
// only after a crash, and the operator exits by itself once Docker Batshit stops.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { hostIanaTimeZone, operatorIsCurrent, prepareEnvFile, prepareHostVoiceRecipeSigningKey, printOperatorStatus, renderMacLaunchAgentPlist } from './start-docker.mjs'

const hasPlutil = process.platform === 'darwin'

test('startup reports sbx checks without claiming sandbox creation succeeded (BL-429)', (t) => {
  const log = t.mock.method(console, 'log', () => {})
  const warn = t.mock.method(console, 'warn', () => {})

  for (const prefix of ['Docker Sandbox operator started.', 'Docker Sandbox operator is already running.']) {
    for (const status of [
      { available: true, version: 'sbx v0.46.0' },
      { available: true, cli: '/usr/local/bin/sbx' },
      { available: true }
    ]) {
      printOperatorStatus(status, prefix)
      const message = log.mock.calls.at(-1).arguments[0]
      assert.ok(message.startsWith(prefix))
      assert.ok(message.includes(`Docker Sandbox sbx checks passed (${status.version || status.cli || 'sbx'}).`))
      assert.ok(message.includes('Sandbox creation is checked on first use.'))
      assert.doesNotMatch(message, /Sandbox is ready/)
    }
  }
  assert.equal(log.mock.callCount(), 6)
  assert.equal(warn.mock.callCount(), 0)
})

test('unavailable sandbox startup keeps its reason visible (BL-429)', (t) => {
  const log = t.mock.method(console, 'log', () => {})
  const warn = t.mock.method(console, 'warn', () => {})
  const prefix = 'Docker Sandbox operator started.'
  printOperatorStatus({ available: false, reason: 'Run sbx login first.' }, prefix)

  assert.deepEqual(log.mock.calls.map((call) => call.arguments), [[prefix]])
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [['\nDocker Sandbox is not ready yet: Run sbx login first.\n']])
})

async function lint(t, plist) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'batshit-operator-plist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'ai.batshit.sandbox-operator.plist')
  await writeFile(file, plist)
  execFileSync('plutil', ['-lint', file])
  const value = (keyPath) => {
    try {
      return execFileSync('plutil', ['-extract', keyPath, 'raw', '-o', '-', file], { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }
  return value
}

test('the login item starts at login, and launchd restarts the operator only after a crash', { skip: !hasPlutil }, async (t) => {
  const plistPath = '/Users/x/Library/LaunchAgents/ai.batshit.sandbox-operator.plist'
  const value = await lint(t, renderMacLaunchAgentPlist({ plistPath }))

  assert.equal(value('Label'), 'ai.batshit.sandbox-operator')
  assert.equal(value('RunAtLoad'), 'true')
  assert.equal(value('KeepAlive.SuccessfulExit'), 'false')
  // The operator removes exactly this file when Docker Batshit was stopped on purpose.
  assert.equal(value('EnvironmentVariables.BATSHIT_RUNTIME_ADDON_OPERATOR_LAUNCH_AGENT'), plistPath)
  assert.equal(value('EnvironmentVariables.COMPOSE_PROJECT_NAME'), null)
})

test('a named Compose project reaches the operator, so its add-on commands use that project', { skip: !hasPlutil }, async (t) => {
  const value = await lint(
    t,
    renderMacLaunchAgentPlist({ plistPath: '/tmp/ai.batshit.sandbox-operator.plist', projectName: 'batshit-smoke' })
  )
  assert.equal(value('EnvironmentVariables.COMPOSE_PROJECT_NAME'), 'batshit-smoke')
})

test('an operator from an older login item is restarted, which rewrites the item', () => {
  const plistPath = '/Users/x/Library/LaunchAgents/ai.batshit.sandbox-operator.plist'
  const current = {
    hostVoiceControls: ['start', 'stop', 'write-reference-audio'],
    sandboxRevision: 12,
    watch: { enabled: true, launchAgent: plistPath, startedByOldLoginItem: false }
  }
  assert.equal(operatorIsCurrent(current, { platform: 'darwin', plistPath }), true)
  assert.equal(operatorIsCurrent({ ...current, sandboxRevision: 10 }, { platform: 'darwin', plistPath }), false)
  // BL-1277: an operator still running revision 11 keeps the policy list it started with.
  assert.equal(operatorIsCurrent({ ...current, sandboxRevision: 11 }, { platform: 'darwin', plistPath }), false)
  // Revision 6 code under a login item written before it: KeepAlive true, no file to remove.
  const underOldItem = { ...current, watch: { enabled: false, launchAgent: null, startedByOldLoginItem: true } }
  assert.equal(operatorIsCurrent(underOldItem, { platform: 'darwin', plistPath }), false)
  assert.equal(operatorIsCurrent({ ...current, sandboxRevision: 7 }, { platform: 'darwin', plistPath }), false)
  // No login items off a Mac: the operator there is a detached process `start-docker` starts.
  assert.equal(operatorIsCurrent({ ...current, watch: undefined }, { platform: 'linux', plistPath }), true)
})

// BL-109: the app tells agents the time, and memory's calendar-day search counts days, in the
// container's zone, and a container has none of its own. The example used to set New York for
// everyone; the launcher now fills this computer's zone when .env.docker has none, once.
test('a new .env.docker gets this computer’s time zone, and a zone already set wins (BL-109)', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'batshit-env-docker-tz-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const envFile = path.join(dir, '.env.docker')

  const first = prepareEnvFile([], { envFile, hostTimeZone: 'Europe/Paris' })
  assert.equal(first.env.has('BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY'), false)
  assert.equal(first.env.get('TZ'), 'Europe/Paris')
  assert.equal(first.env.get('GENERIC_TIMEZONE'), 'Europe/Paris')
  assert.ok(first.notes.some((note) => note.includes('TZ') && note.includes('Europe/Paris')))
  // The computer moved, or the user chose a zone: the value in .env.docker stays.
  const moved = prepareEnvFile([], { envFile, hostTimeZone: 'Asia/Tokyo' })
  assert.equal(moved.env.has('BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY'), false)
  assert.equal(moved.env.get('TZ'), 'Europe/Paris')
  assert.deepEqual(moved.notes.filter((note) => note.includes('time zone')), [])
  // A zone Node cannot name fills nothing: the containers run on UTC, never on a guess.
  const unnamed = prepareEnvFile([], { envFile: path.join(dir, 'unnamed.env.docker'), hostTimeZone: null })
  assert.equal(unnamed.env.get('TZ'), '')
})

test('the recipe key lives in a private host file and an old env-file key is removed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-voice-key-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const keyFile = path.join(root, 'private', 'voice-recipe.key')
  const first = prepareHostVoiceRecipeSigningKey(keyFile)
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.equal(prepareHostVoiceRecipeSigningKey(keyFile), first)
  const details = await import('node:fs/promises').then((fs) => fs.stat(keyFile))
  if (process.platform !== 'win32') assert.equal(details.mode & 0o077, 0)

  const envFile = path.join(root, '.env.docker')
  await writeFile(envFile, `BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY=old-workspace-secret\n`)
  const prepared = prepareEnvFile([], { envFile, hostTimeZone: 'UTC' })
  assert.equal(prepared.env.has('BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY'), false)
  assert.equal((await readFile(envFile, 'utf8')).includes('old-workspace-secret'), false)
  assert.throws(
    () => prepareHostVoiceRecipeSigningKey(path.join(root, 'workspace', 'private', 'key'), root),
    /outside the Docker workspace mount/
  )
})

test('the host zone is an IANA name or nothing (BL-109)', () => {
  assert.equal(hostIanaTimeZone(() => 'America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires')
  assert.equal(hostIanaTimeZone(() => 'Etc/GMT+5'), 'Etc/GMT+5')
  assert.equal(hostIanaTimeZone(() => 'UTC'), 'UTC')
  // What Node reports when it cannot name the zone, a Windows zone name, and nothing at all.
  assert.equal(hostIanaTimeZone(() => 'Etc/Unknown'), null)
  assert.equal(hostIanaTimeZone(() => 'W. Europe Standard Time'), null)
  assert.equal(hostIanaTimeZone(() => undefined), null)
  assert.equal(
    hostIanaTimeZone(() => {
      throw new Error('no ICU')
    }),
    null
  )
  // Whatever this machine is set to: its IANA name, or nothing when Node cannot name it.
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  assert.equal(hostIanaTimeZone(), here === 'Etc/Unknown' ? null : here)
})

// BL-18: several Docker Batshits can share one host operator (two Compose projects started from
// one .env.docker, which holds its token, or a copied one), and its voice records are one folder.
// Each app names itself to the operator by its Compose project, which is what makes two running
// Docker Batshits two, so compose.yaml sets the name, and Compose fills the project on every start
// (the launcher's, a raw `docker compose up`, Docker Desktop's).
const COMPOSE_FILE = fileURLToPath(new URL('../../compose.yaml', import.meta.url))
const hasDockerCompose = (() => {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test('compose.yaml names each Docker Batshit by its Compose project (BL-18)', async () => {
  const text = await readFile(COMPOSE_FILE, 'utf8')
  assert.equal(text.split('BATSHIT_VOICE_RUNTIME_OWNER: docker:${COMPOSE_PROJECT_NAME}').length - 1, 1)
})

test('two Compose projects from one .env.docker get two names (BL-18)', { skip: !hasDockerCompose }, async (t) => {
  // One env file for both, as `--project-name` with the default .env.docker does. Compose reads
  // only it, never a stray `.env` beside compose.yaml, and it carries every value Compose requires.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'batshit-compose-owner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const envFile = path.join(dir, '.env.docker')
  await writeFile(
    envFile,
    ['BATSHIT_TOKEN', 'ENCRYPTION_KEY', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].map((key) => `${key}=${'a'.repeat(64)}`).join('\n')
  )
  const composeEnv = { ...process.env, BATSHIT_DOCKER_ENV_FILE: envFile }
  delete composeEnv.BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY
  const owner = (project) =>
    JSON.parse(
      execFileSync(
        'docker',
        ['compose', '-f', COMPOSE_FILE, '--env-file', envFile, '--project-name', project, 'config', '--format', 'json'],
        { encoding: 'utf8', env: composeEnv }
      )
    ).services.app.environment.BATSHIT_VOICE_RUNTIME_OWNER
  assert.equal(owner('batshit'), 'docker:batshit')
  assert.equal(owner('batshit-test'), 'docker:batshit-test')
})

// The LiveKit server's keys never go on its command line, which `ps` on a Linux Docker host shows
// to every local user; livekit-server reads LIVEKIT_KEYS exactly like --keys. Compose renders the
// real file, so this also proves the quoted "<key>: <secret>" value survives YAML and interpolation.
test('the LiveKit server gets its keys from the environment, never its command line', { skip: !hasDockerCompose }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'batshit-compose-livekit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const envFile = path.join(dir, '.env.docker')
  const apiKey = 'batshit-local'
  const apiSecret = 'b'.repeat(64)
  await writeFile(
    envFile,
    [`BATSHIT_TOKEN=${'a'.repeat(64)}`, `ENCRYPTION_KEY=${'a'.repeat(64)}`, `LIVEKIT_API_KEY=${apiKey}`, `LIVEKIT_API_SECRET=${apiSecret}`].join('\n')
  )
  // Compose prefers the shell's values to the env file's; the caller's own keys must not stand in.
  const composeEnv = { ...process.env, BATSHIT_DOCKER_ENV_FILE: envFile }
  for (const key of ['BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) delete composeEnv[key]
  const { livekit } = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose', '-f', COMPOSE_FILE, '--env-file', envFile, '--project-name', 'batshit-livekit-keys',
        '--profile', 'livekit', 'config', '--format', 'json'
      ],
      { encoding: 'utf8', env: composeEnv }
    )
  ).services
  const onCommandLine = (livekit.command ?? []).some((arg) => arg.startsWith('--keys') || arg.includes(apiSecret))
  assert.equal(onCommandLine, false, 'a key or secret is on the command line')
  assert.equal(livekit.environment.LIVEKIT_KEYS, `${apiKey}: ${apiSecret}`)
})
