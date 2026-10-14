import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localRuntimeProcessTreeFromWindows } from '../../batshit-mac/scripts/local-voice-runtime-stop.mjs'
import { stopWindowsVoiceProcessTree, windowsMembersAtLaunch } from './windows-voice-process-stop.mjs'

const processRow = (pid, parentPid, startedAtMs) => ({ pid, parentPid, startedAtMs, commandLine: `engine ${pid}` })
const root = processRow(100, 1, 1000)
const child = processRow(101, 100, 1100)

function scripted({ initial, reads, known = [{ pid: 100, startedAtMs: 1000 }] }) {
  const killed = []
  const persisted = []
  let next = 0
  return {
    killed,
    persisted,
    run: () => stopWindowsVoiceProcessTree({
      rootPid: 100,
      knownMembers: known,
      initialProcesses: initial,
      readProcesses: async () => reads[Math.min(next++, reads.length - 1)],
      killProcess: async (pid) => { killed.push(pid) },
      persistMembers: async (members) => { persisted.push(members.map((member) => member.pid)) },
      settleMs: 0
    })
  }
}

test('kills only individually verified PIDs and persists descendants before the first kill', async () => {
  const fixture = scripted({ initial: [root, child], reads: [[root, child], [child], []] })
  const result = await fixture.run()
  assert.equal(result.ok, true)
  assert.deepEqual(fixture.persisted, [[100, 101]])
  assert.deepEqual(fixture.killed, [100, 101])
})

test('deduplicates one process named by two engine records', async () => {
  const fixture = scripted({
    initial: [root],
    known: [{ pid: 100, startedAtMs: 1000 }, { pid: 100, startedAtMs: 1000 }],
    reads: [[root], []]
  })
  const result = await fixture.run()
  assert.equal(result.ok, true)
  assert.deepEqual(fixture.killed, [100])
})

test('a late snapshot of a reused root cannot become a launch identity', async () => {
  const successor = processRow(100, 1, 3000)
  const tree = localRuntimeProcessTreeFromWindows([successor, processRow(101, 100, 3100)], 100)
  const known = windowsMembersAtLaunch(tree, 1000)
  assert.deepEqual(known, [])
  const fixture = scripted({ initial: [successor], known, reads: [[successor], []] })
  const result = await fixture.run()
  assert.equal(result.ok, false)
  assert.match(result.reason, /no process identity was recorded at launch/)
  assert.deepEqual(fixture.persisted, [])
  assert.deepEqual(fixture.killed, [])
})

test('an ambiguous child does not discard the verified root at launch', async () => {
  const ambiguous = processRow(102, 100, 900)
  const tree = localRuntimeProcessTreeFromWindows([root, child, ambiguous], 100)
  assert.equal(tree.unsafeDescendants, true)
  const known = windowsMembersAtLaunch(tree, 1000)
  assert.deepEqual(known, [{ pid: 100, startedAtMs: 1000 }, { pid: 101, startedAtMs: 1100 }])
  const fixture = scripted({ initial: [root, child, ambiguous], known, reads: [[root, child, ambiguous], [child], []] })
  const result = await fixture.run()
  assert.equal(result.ok, false)
  assert.match(result.reason, /ambiguous child/)
  assert.deepEqual(fixture.killed, [100, 101])
})

test('refuses an older child of a reused parent PID without sending any kill', async () => {
  const fixture = scripted({ initial: [root, processRow(102, 100, 900)], reads: [[]] })
  const result = await fixture.run()
  assert.equal(result.ok, false)
  assert.match(result.reason, /ambiguous child/)
  assert.deepEqual(fixture.killed, [])
})

test('refuses a child discovered only after its parent vanished', async () => {
  const fixture = scripted({ initial: [root], reads: [[child]] })
  const result = await fixture.run()
  assert.equal(result.ok, false)
  assert.match(result.reason, /child appeared after its parent exited/)
  assert.deepEqual(fixture.killed, [])
})

test('drops a dead root record without killing the successor', async () => {
  const successor = processRow(100, 1, 3000)
  const fixture = scripted({ initial: [root], reads: [[successor], [successor]] })
  const result = await fixture.run()
  assert.equal(result.ok, true)
  assert.deepEqual(fixture.killed, [])
})

test('a middle process can exit while its previously recorded child is still stopped', async () => {
  const middle = processRow(101, 100, 1100)
  const leaf = processRow(102, 101, 1200)
  const fixture = scripted({
    initial: [root, middle, leaf],
    reads: [[root, middle, leaf], [leaf], [leaf], []]
  })
  const result = await fixture.run()
  assert.equal(result.ok, true)
  assert.deepEqual(fixture.persisted, [[100, 101, 102]])
  assert.deepEqual(fixture.killed, [100, 102])
})

test('a child PID reused before force is never killed', async () => {
  const successor = processRow(101, 1, 4000)
  const fixture = scripted({
    initial: [root, child],
    reads: [[root, child], [successor], [successor]]
  })
  const result = await fixture.run()
  assert.equal(result.ok, true)
  assert.deepEqual(fixture.killed, [100])
})

test('failure to persist a newly observed child refuses to kill', async () => {
  let killed = false
  await assert.rejects(stopWindowsVoiceProcessTree({
    rootPid: 100,
    knownMembers: [{ pid: 100, startedAtMs: 1000 }],
    initialProcesses: [root, child],
    readProcesses: async () => [root, child],
    killProcess: async () => { killed = true },
    persistMembers: async () => { throw new Error('record write failed') },
    settleMs: 0
  }), /record write failed/)
  assert.equal(killed, false)
})

test('kills a persisted survivor after the root exits and completes when no others are found', async () => {
  const fixture = scripted({
    initial: [child],
    known: [{ pid: 100, startedAtMs: 1000 }, { pid: 101, startedAtMs: 1100 }],
    reads: [[child], [child], []]
  })
  const result = await fixture.run()
  assert.equal(result.ok, true)
  assert.deepEqual(fixture.killed, [101])
})

test('a crashed engine with no live member reports it was not running', async () => {
  const fixture = scripted({ initial: [], reads: [[]] })
  const result = await fixture.run()
  assert.equal(result.ok, true)
  assert.equal(result.wasNotRunning, true)
  assert.deepEqual(fixture.killed, [])
})

test('an ambiguous child does not prevent a known survivor from stopping', async () => {
  const successor = processRow(100, 1, 3000)
  const unrelated = processRow(102, 100, 3100)
  const fixture = scripted({
    initial: [successor, unrelated, child],
    known: [{ pid: 100, startedAtMs: 1000 }, { pid: 101, startedAtMs: 1100 }],
    reads: [[successor, unrelated, child], [successor, unrelated, child], [successor, unrelated]]
  })
  const result = await fixture.run()
  assert.equal(result.ok, false)
  assert.match(result.reason, /ambiguous/)
  assert.deepEqual(fixture.killed, [101])
})

test('a persist delay is followed by a fresh table read before the kill', async () => {
  let reads = 0
  const killed = []
  let childGone = false
  const result = await stopWindowsVoiceProcessTree({
    rootPid: 100,
    knownMembers: [{ pid: 100, startedAtMs: 1000 }],
    initialProcesses: [root],
    readProcesses: async () => {
      reads += 1
      return reads === 1 ? [root, child] : [processRow(100, 1, 3000), ...(childGone ? [] : [child])]
    },
    killProcess: async (pid) => { killed.push(pid); childGone = true },
    persistMembers: async () => {},
    settleMs: 0
  })
  assert.equal(result.ok, true)
  assert.deepEqual(killed, [101])
  assert.ok(reads >= 3)
})

test('a kill-site birth-time mismatch is reported and never treated as a stopped engine', async () => {
  const checked = []
  const result = await stopWindowsVoiceProcessTree({
    rootPid: 100,
    knownMembers: [{ pid: 100, startedAtMs: 1000 }],
    initialProcesses: [root],
    readProcesses: async () => [root],
    killProcess: async (pid, startedAtMs) => { checked.push([pid, startedAtMs]); return 'mismatch' },
    persistMembers: async () => {},
    settleMs: 0
  })
  assert.equal(result.ok, false)
  assert.deepEqual(checked, [[100, 1000]])
})

test('refuses an unreadable birth time for a child of a vanished parent', async () => {
  const fixture = scripted({ initial: [root], reads: [[processRow(102, 100, null)]] })
  const result = await fixture.run()
  assert.equal(result.ok, false)
  assert.match(result.reason, /child appeared after its parent exited/)
  assert.deepEqual(fixture.killed, [])
})
