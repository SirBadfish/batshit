// The Docker host operator's login item (2026-09-21, BL-59). Run with `node --test tools/docker/*.test.mjs`.
// It used to be `KeepAlive` true, so the operator ran from login forever; now launchd restarts it
// only after a crash, and the operator exits by itself once Docker Batshit stops.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { operatorIsCurrent, renderMacLaunchAgentPlist } from './start-docker.mjs'

const hasPlutil = process.platform === 'darwin'

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
    sandboxRevision: 6,
    watch: { enabled: true, launchAgent: plistPath, startedByOldLoginItem: false }
  }
  assert.equal(operatorIsCurrent(current, { platform: 'darwin', plistPath }), true)
  // Revision 6 code under a login item written before it: KeepAlive true, no file to remove.
  const underOldItem = { ...current, watch: { enabled: false, launchAgent: null, startedByOldLoginItem: true } }
  assert.equal(operatorIsCurrent(underOldItem, { platform: 'darwin', plistPath }), false)
  assert.equal(operatorIsCurrent({ ...current, sandboxRevision: 5 }, { platform: 'darwin', plistPath }), false)
  // No login items off a Mac: the operator there is a detached process `start-docker` starts.
  assert.equal(operatorIsCurrent({ ...current, watch: undefined }, { platform: 'linux', plistPath }), true)
})
