// The operator's copy of batshit-app's sandbox lifecycle gate must keep the same rules as
// `batshit-app/src/lib/server/services/sandboxLifecycleGate.ts` (whose suite is the fuller
// one). Run with `node --test tools/docker/*.test.mjs`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSandboxLifecycleGate } from './sandbox-lifecycle-gate.mjs'

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('concurrent ensures for one name share one run', async () => {
  const gate = createSandboxLifecycleGate()
  const started = deferred()
  let runs = 0
  const ensure = () =>
    gate.ensure('sandbox-a', () => {
      runs += 1
      return started.promise
    })

  const callers = [ensure(), ensure(), ensure()]
  await flush()
  started.resolve('ready')
  assert.deepEqual(await Promise.all(callers), ['ready', 'ready', 'ready'])
  assert.equal(runs, 1)
})

test('a removal waits for an ensure under way, and a later caller starts a fresh ensure', async () => {
  const gate = createSandboxLifecycleGate()
  const creating = deferred()
  const order = []
  let runs = 0
  const ensure = (label) =>
    gate.ensure('sandbox-a', async () => {
      runs += 1
      order.push(`ensure:${label}`)
      if (runs === 1) await creating.promise
    })

  const first = ensure('first')
  const removal = gate.remove('sandbox-a', async () => {
    order.push('remove')
  })
  const late = ensure('late')
  creating.resolve()
  await Promise.all([first, removal, late])
  assert.deepEqual(order, ['ensure:first', 'remove', 'ensure:late'])
})

test('an idle-only removal is skipped while leased and runs after release', async () => {
  const gate = createSandboxLifecycleGate()
  const release = gate.lease('sandbox-a')
  assert.deepEqual(await gate.removeIfIdle('sandbox-a', async () => 'removed'), { removed: false })
  release()
  assert.deepEqual(await gate.removeIfIdle('sandbox-a', async () => 'removed'), {
    removed: true,
    value: 'removed'
  })
})

test('busy names are reported and idle names are forgotten', async () => {
  const gate = createSandboxLifecycleGate()
  const creating = deferred()
  const release = gate.lease('sandbox-a')
  const ensure = gate.ensure('sandbox-b', () => creating.promise)
  assert.equal(gate.isBusy('sandbox-a'), true)
  assert.equal(gate.isBusy('sandbox-b'), true)
  assert.equal(gate.trackedNameCount(), 2)

  release()
  creating.resolve()
  await ensure
  assert.equal(gate.isBusy('sandbox-b'), false)
  assert.equal(gate.trackedNameCount(), 0)
})
