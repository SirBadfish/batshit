// The operator's copy of batshit-app's `dockerSandboxSbx.ts` must keep the same rules as the
// app copy (whose suite is the fuller one). Run with `node --test tools/docker/*.test.mjs`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildSbxSandboxName,
  buildSbxSessionMarker,
  classifySbxFailure,
  describeSbxFailure,
  isAbandonedSbxSandbox,
  isReusableSbxSandbox,
  parseSbxSandboxList,
  sbxCommandEndArgs,
  sbxCreateArgs,
  sbxDenyAllNetworkArgs,
  sbxExecArgs,
  sbxSandboxHasWorkspace,
  toSbxSandboxPath
} from './sbx-cli.mjs'
import { sandboxCommandEndArgv } from './command-end.mjs'

test('names have no underscores and keep the session marker', () => {
  const name = buildSbxSandboxName({ userId: 'Josh_Alt.', workspaceRoot: '/w', sessionId: 'session_1' })
  assert.match(name, /^batshit-josh-alt-s[0-9a-f]{8}-[0-9a-f]{10}$/)
  assert.ok(name.includes(buildSbxSessionMarker('session_1')))
})

test('create denies all network from the start, and the deny rule is scoped with --sandbox', () => {
  assert.deepEqual(sbxCreateArgs({ sandboxName: 'batshit-x', workspaceRoot: '/w' }), [
    'create',
    '--name',
    'batshit-x',
    '--deny-network',
    '**',
    'shell',
    '/w'
  ])
  assert.deepEqual(sbxDenyAllNetworkArgs('batshit-x'), ['policy', 'deny', 'network', '--sandbox', 'batshit-x', '**'])
})

test('the list is read from JSON, and anything else is refused', () => {
  assert.deepEqual(
    parseSbxSandboxList('{"sandboxes":[{"name":"a","status":"Stopped","last_used_at":"2026-09-18T08:00:00Z","workspaces":["/w"]}]}'),
    [{ name: 'a', status: 'stopped', workspaces: ['/w'], lastUsedAt: '2026-09-18T08:00:00Z' }]
  )
  assert.deepEqual(parseSbxSandboxList('{"sandboxes":[]}'), [])
  assert.throws(() => parseSbxSandboxList('SANDBOX AGENT STATUS'), /printed no JSON/)
})

test('the list is read after the daemon-start lines the Windows build prints to stdout', () => {
  const output = [
    'Starting sandboxd daemon...',
    'Daemon started (PID: 55276, socket: \\\\.\\pipe\\docker_kaname_sandboxd)',
    'Logs: C:\\Users\\user\\AppData\\Local\\DockerSandboxes\\sandboxes\\state\\sandboxd\\daemon.log',
    '{"sandboxes":[{"name":"copilot-test","status":"stopped","workspaces":["C:\\\\Users\\\\user\\\\Git\\\\copilot-test"]}]}'
  ].join('\n')
  assert.deepEqual(parseSbxSandboxList(output), [
    { name: 'copilot-test', status: 'stopped', workspaces: ['C:\\Users\\user\\Git\\copilot-test'], lastUsedAt: null }
  ])
  assert.throws(() => parseSbxSandboxList('Starting sandboxd daemon...'), /printed no JSON/)
})

test('a Windows folder is /<drive>/… inside the sandbox, and matches its workspace in any case', () => {
  assert.equal(toSbxSandboxPath('C:\\Users\\me\\work'), '/c/Users/me/work')
  assert.equal(toSbxSandboxPath('C:\\c\\Users\\aua\\Documents\\repos'), '/c/c/Users/aua/Documents/repos')
  assert.equal(toSbxSandboxPath('D:/data/ws/'), '/d/data/ws')
  assert.equal(toSbxSandboxPath('C:\\'), '/c')
  assert.equal(toSbxSandboxPath('/Users/example/project'), '/Users/example/project')
  assert.deepEqual(
    sbxExecArgs({ sandboxName: 'batshit-x', cwd: 'C:\\Users\\me\\work\\src', command: 'pwd', tag: 't' }).slice(0, 3),
    ['exec', '--workdir', '/c/Users/me/work/src']
  )
  const windows = { name: 'batshit-x', status: 'running', workspaces: ['C:\\Users\\Example\\ws'], lastUsedAt: null }
  assert.equal(sbxSandboxHasWorkspace(windows, 'c:\\users\\example\\ws\\'), true)
  assert.equal(sbxSandboxHasWorkspace(windows, 'C:\\Users\\Example\\other'), false)
  const mac = { ...windows, workspaces: ['/Users/example/ws'] }
  assert.equal(sbxSandboxHasWorkspace(mac, '/Users/example/ws'), true)
  assert.equal(sbxSandboxHasWorkspace(mac, '/private/Users/example/ws'), false)
})

test('stopped is idle, and only an hour of disuse is abandoned', () => {
  const now = Date.parse('2026-09-18T12:00:00Z')
  const entry = (status, minutesAgo) => ({
    name: 'batshit-x',
    status,
    workspaces: [],
    lastUsedAt: new Date(now - minutesAgo * 60_000).toISOString()
  })
  assert.equal(isReusableSbxSandbox(entry('stopped', 1)), true)
  assert.equal(isReusableSbxSandbox(entry('error', 1)), false)
  assert.equal(isAbandonedSbxSandbox(entry('stopped', 5), now), false)
  assert.equal(isAbandonedSbxSandbox(entry('stopped', 61), now), true)
  assert.equal(isAbandonedSbxSandbox(entry('running', 600), now), false)
})

test('setup failures name the step to take', () => {
  assert.equal(classifySbxFailure('ERROR: Not authenticated to Docker'), 'not_signed_in')
  assert.equal(classifySbxFailure('ERROR: global network policy has not been initialized'), 'network_policy_not_initialized')
  assert.equal(classifySbxFailure('spawn sbx ENOENT'), 'not_installed')
  assert.match(describeSbxFailure('ERROR: Not authenticated to Docker', 'x'), /Run `sbx login`/)
  assert.equal(describeSbxFailure('ERROR: something new', 'x'), 'ERROR: something new')
})

test('a command carries its tag last, and a Stop or timeout ends what carries it with one short command', () => {
  assert.deepEqual(
    sbxExecArgs({
      sandboxName: 'batshit-x',
      cwd: '/w',
      env: { A: 'one', BATSHIT_COMMAND_ID: 'forged' },
      command: 'pwd',
      tag: 'tag-1'
    }),
    ['exec', '--workdir', '/w', '--env', 'A=one', '--env', 'BATSHIT_COMMAND_ID=tag-1', 'batshit-x', '/bin/bash', '-lc', 'pwd']
  )
  assert.throws(() => sbxExecArgs({ sandboxName: 'batshit-x', cwd: '/w', command: 'pwd' }), /tag/)
  assert.deepEqual(sbxCommandEndArgs({ sandboxName: 'batshit-x', tag: 'tag-1' }), [
    'exec',
    'batshit-x',
    ...sandboxCommandEndArgv('tag-1')
  ])
})
