import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { SETTINGS_TABS } from '$lib/appActions/catalog'
import { SETTINGS_FIELDS, SETTINGS_ACTION_DESCRIPTORS } from '$lib/appActions/settings/fields'
import {
  validateIdentityChanges, validateMemoryChanges, validateInspection,
  type SettingsOwnerContext
} from '$lib/appActions/settings/validation'
import {
  createConditionalSettingsStore as createStoreWithAbortGuard, createOwnAgentSettingsExecutors,
  SETTINGS_SNAPSHOT_PATHS, READ_SETTINGS_SNAPSHOT_SCRIPT, CONDITIONAL_SETTINGS_WRITE_SCRIPT,
  type ConditionalSettingsStore, type SettingsRedisClient, type SettingsRedisExecutor
} from './conditionalAgentSettings'
import { createSettingsInspector, projectSettingsInspection, type SettingsInspectionStore } from './inspection'

const context = (actingAgentId = 'sadie', userId = 'josh'): SettingsOwnerContext => ({
  actor: { kind: 'agent', userId, actingAgentId }, signal: new AbortController().signal, check() {}
})
const developer: SettingsOwnerContext = { actor: { kind: 'developer', userId: 'josh' }, signal: new AbortController().signal, check() {} }
const raw = (value: unknown) => value === undefined ? '[]' : JSON.stringify([value])
const initial = () => [raw('sadie'), raw('josh'), raw('api'), raw('Sadie'), raw(false), raw({ on_my_mind: 2000, triggers: 1200, recalled: 2400, untouchedSibling: 'keep' }), raw(undefined), raw(2), raw(undefined), raw(2), raw(undefined), raw(undefined)]
function readyClient(evalOperation: SettingsRedisClient['eval']): SettingsRedisClient & { events: EventEmitter } {
  const events = new EventEmitter()
  return { events, isOpen: true, isReady: true, eval: evalOperation,
    withAbortSignal() { return { eval: evalOperation } },
    on: events.on.bind(events), removeListener: events.removeListener.bind(events) }
}
// Exercise the installed queue itself without a socket, Redis, or services.
// The env override only locates existing dependencies for the /tmp bundle.
const installedRequire = createRequire(process.env.SA122_INSTALLED_PACKAGE_JSON ?? import.meta.url)
const redisOwnerRequire = createRequire(installedRequire.resolve('redis'))
const RedisCommandsQueue = redisOwnerRequire('@redis/client/dist/lib/client/commands-queue').default
const { AbortError } = redisOwnerRequire('@redis/client/dist/lib/errors')
const createConditionalSettingsStore = (execute: SettingsRedisExecutor) => createStoreWithAbortGuard(execute, error => error instanceof AbortError)
function fixture() {
  let stored = initial()
  let reads = 0
  const writes: unknown[] = []
  const store: ConditionalSettingsStore = {
    async read() { reads += 1; return { raw: [...stored] } },
    async write(subjectAgentId, userId, family, before, changes) {
      writes.push({ subjectAgentId, userId, family, before, changes })
      if (family === 'identity') stored[3] = raw((changes as { displayName: string }).displayName)
      else {
        const budget = JSON.parse(stored[5])[0]
        for (const [name, value] of Object.entries(changes)) {
          if (name === 'triggerLingerTurns') stored[7] = raw(value)
          else if (name === 'recallLingerTurns') stored[9] = raw(value)
          else budget[name === 'onMyMind' ? 'on_my_mind' : name] = value
        }
        stored[5] = raw(budget)
      }
      return 'OK'
    }
  }
  return { store, writes, get reads() { return reads }, get stored() { return stored }, set stored(value) { stored = value } }
}

describe('own-agent Settings admission and exact request bodies', () => {
  it('rejects privilege-bearing and generic-path keys before a read or save', async () => {
    const f = fixture(); const owner = createOwnAgentSettingsExecutors(f.store)
    for (const extra of ['actor', 'agentId', 'caller', 'path', 'allowRisky', 'approvalId', 'signal', 'deadlineAt', 'memory_enabled', 'provider_specific_settings']) {
      await assert.rejects(owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: `sha256:${'0'.repeat(64)}`, changes: { onMyMind: 1000 }, [extra]: true }, context()), /invalid_arguments/)
      assert.throws(() => validateMemoryChanges({ onMyMind: 1000, [extra]: true }), /invalid_arguments/)
    }
    assert.equal(f.reads, 0); assert.equal(f.writes.length, 0)
  })
  it('requires the authenticated acting agent and stored user/Primary type', async () => {
    const f = fixture(); const owner = createOwnAgentSettingsExecutors(f.store)
    await assert.rejects(owner.readMemory({ subjectAgentId: 'sadie' }, context('cooper')), /own_agent_required/)
    await assert.rejects(owner.readMemory({ subjectAgentId: 'sadie' }, developer), /own_agent_required/)
    assert.equal(f.reads, 0)
    await assert.rejects(owner.readMemory({ subjectAgentId: 'sadie' }, context('sadie', 'another-user')), /agent_not_owned/)
    f.stored[2] = raw('n8n')
    await assert.rejects(owner.readMemory({ subjectAgentId: 'sadie' }, context()), /unsupported_primary_agent/)
    assert.equal(f.writes.length, 0)
  })
  it('accepts zero as real and refuses clamping, coercion and malformed names', () => {
    assert.deepEqual(validateMemoryChanges({ onMyMind: 0, triggers: 20000, recalled: 1, triggerLingerTurns: 0, recallLingerTurns: 8 }), { onMyMind: 0, triggers: 20000, recalled: 1, triggerLingerTurns: 0, recallLingerTurns: 8 })
    for (const value of [-1, 1.1, 20001, '1', null, undefined, NaN, Infinity]) assert.throws(() => validateMemoryChanges({ onMyMind: value }))
    for (const value of [-1, 1.1, 9, '2']) assert.throws(() => validateMemoryChanges({ triggerLingerTurns: value }))
    assert.deepEqual(validateIdentityChanges({ displayName: '  Sadie  ' }), { displayName: 'Sadie' })
    for (const displayName of ['', '  ', '\ud800', 'x'.repeat(201), 2]) assert.throws(() => validateIdentityChanges({ displayName }))
    assert.throws(() => validateIdentityChanges({ displayName: 'Sadie', id: 'cooper' }))
  })
  it('checks freshness again after the asynchronous read and never writes on expiry', async () => {
    const f = fixture(); const owner = createOwnAgentSettingsExecutors(f.store)
    const read = await owner.readMemory({ subjectAgentId: 'sadie' }, context())
    let checks = 0
    const expired = { ...context(), check() { if (++checks === 2) throw new Error('expired') } }
    await assert.rejects(owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { triggers: 1000 } }, expired), /expired/)
    assert.equal(f.writes.length, 0)
  })
})

describe('conditional owner save and truthful outcomes', () => {
  it('rechecks expiry and retirement after deferred client acquisition, before EVAL', async () => {
    for (const family of ['memory', 'identity'] as const) for (const refusal of ['expired', 'retired']) {
      let admitted = true; let calls = 0; let mutations = 0
      let resume!: () => void; let deferred!: () => void
      const pending = new Promise<void>(resolve => { resume = resolve })
      const reached = new Promise<void>(resolve => { deferred = resolve })
      const client = readyClient(async script => {
        if (script === READ_SETTINGS_SNAPSHOT_SCRIPT) return ['OK', ...initial()]
        mutations += 1; return 'OK'
      })
      const store = createConditionalSettingsStore(async operation => {
        if (++calls === 3) { deferred(); await pending }
        return operation(client)
      })
      const owner = createOwnAgentSettingsExecutors(store)
      const actor = { ...context(), check() { if (!admitted) throw new Error(refusal) } }
      const read = family === 'memory' ? await owner.readMemory({ subjectAgentId: 'sadie' }, actor) : await owner.readIdentity({ subjectAgentId: 'sadie' }, actor)
      const saving = family === 'memory' ? owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { triggers: 900 } }, actor) : owner.updateIdentity({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { displayName: 'New name' } }, actor)
      await reached; admitted = false; resume()
      const result = await saving
      assert.equal(result.status, 'blocked'); assert.equal(result.saved, 'not_requested')
      assert.equal(result.reason, 'operation_no_longer_admitted'); assert.equal(mutations, 0)
      assert.equal(client.events.eventNames().length, 0)
    }
  })
  it('reports a failed client acquisition as definite no-write without retry', async () => {
    let calls = 0; let mutations = 0
    const client = readyClient(async script => {
      if (script === READ_SETTINGS_SNAPSHOT_SCRIPT) return ['OK', ...initial()]
      mutations += 1; return 'OK'
    })
    const owner = createOwnAgentSettingsExecutors(createConditionalSettingsStore(async operation => {
      if (++calls === 3) throw new Error('getClient failed before invoking operation')
      return operation(client)
    }))
    const read = await owner.readIdentity({ subjectAgentId: 'sadie' }, context())
    const result = await owner.updateIdentity({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { displayName: 'New name' } }, context())
    assert.equal(result.reason, 'settings_store_unavailable_before_write'); assert.equal(result.saved, 'not_requested')
    assert.equal(calls, 3); assert.equal(mutations, 0)
  })
  it('never submits a command to a disconnected client that can queue until reconnect', async () => {
    const queue = new RedisCommandsQueue(2, undefined, () => {})
    let issues = 0
    const client = readyClient(async script => script === READ_SETTINGS_SNAPSHOT_SCRIPT ? ['OK', ...initial()] : 'OK')
    Object.defineProperty(client, 'isReady', { value: false, configurable: true })
    client.withAbortSignal = signal => ({ async eval() { issues += 1; return queue.addCommand(['EVAL', 'probe', '0'], { abortSignal: signal }) } })
    const owner = createOwnAgentSettingsExecutors(createConditionalSettingsStore(async operation => operation(client)))
    const read = await owner.readMemory({ subjectAgentId: 'sadie' }, context())
    const result = await owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { triggers: 900 } }, context())
    assert.equal(result.reason, 'settings_store_not_ready'); assert.equal(result.saved, 'not_requested')
    Object.defineProperty(client, 'isReady', { value: true })
    assert.equal(issues, 0); assert.deepEqual([...queue.commandsToWrite()], [])
    assert.equal(client.events.eventNames().length, 0)
  })
  it('aborts an actual installed-queue command before write and leaves shared listeners intact', async () => {
    assert.equal(AbortError, installedRequire('redis').AbortError)
    const queue = new RedisCommandsQueue(2, undefined, () => {})
    const events = new EventEmitter(); let sharedErrors = 0; events.on('error', () => { sharedErrors += 1 })
    let issued!: () => void; const reached = new Promise<void>(resolve => { issued = resolve })
    const client = readyClient(async () => ['OK', ...initial()])
    client.on = events.on.bind(events); client.removeListener = events.removeListener.bind(events)
    client.withAbortSignal = signal => ({ async eval(script, options) {
      const pending = queue.addCommand(['EVAL', script, '1', ...options.keys, ...options.arguments], { abortSignal: signal })
      issued(); return pending
    } })
    const owner = createOwnAgentSettingsExecutors(createConditionalSettingsStore(async operation => operation(client)))
    const read = await owner.readMemory({ subjectAgentId: 'sadie' }, context())
    const saving = owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { triggers: 900 } }, context())
    await reached; events.emit('error', new Error('disconnect before socket write'))
    const result = await saving
    assert.equal(result.reason, 'settings_store_disconnected_before_write'); assert.equal(result.saved, 'not_requested')
    assert.deepEqual([...queue.commandsToWrite()], []); assert.equal(sharedErrors, 1)
    assert.equal(events.listenerCount('error'), 1); assert.equal(events.listenerCount('end'), 0); assert.equal(events.listenerCount('reconnecting'), 0)
  })
  it('keeps a lost answer unknown after the actual queue has issued command bytes', async () => {
    const queue = new RedisCommandsQueue(2, undefined, () => {})
    const events = new EventEmitter(); let issued!: () => void; let bytes = 0
    const reached = new Promise<void>(resolve => { issued = resolve })
    const client = readyClient(async () => ['OK', ...initial()])
    client.on = events.on.bind(events); client.removeListener = events.removeListener.bind(events)
    client.withAbortSignal = signal => ({ async eval(script, options) {
      const pending = queue.addCommand(['EVAL', script, '1', ...options.keys, ...options.arguments], { abortSignal: signal })
      bytes = [...queue.commandsToWrite()].length; issued(); return pending
    } })
    const owner = createOwnAgentSettingsExecutors(createConditionalSettingsStore(async operation => operation(client)))
    const read = await owner.readMemory({ subjectAgentId: 'sadie' }, context())
    const saving = owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { triggers: 900 } }, context())
    await reached; events.emit('error', new Error('socket lost after write'))
    queue.flushWaitingForReply(new Error('reply lost'))
    const result = await saving
    assert(bytes > 0); assert.equal(result.status, 'unknown_outcome'); assert.equal(result.saved, 'unknown')
    assert.deepEqual([...queue.commandsToWrite()], []); assert.equal(events.listenerCount('error'), 0)
  })
  it('removes an actual queued command when the real caller signal is retired before socket write', async () => {
    const queue = new RedisCommandsQueue(2, undefined, () => {})
    const stopped = new AbortController(); let issued!: () => void
    const reached = new Promise<void>(resolve => { issued = resolve })
    const client = readyClient(async () => ['OK', ...initial()])
    client.withAbortSignal = signal => ({ async eval(script, options) {
      const pending = queue.addCommand(['EVAL', script, '1', ...options.keys, ...options.arguments], { abortSignal: signal })
      issued(); return pending
    } })
    const owner = createOwnAgentSettingsExecutors(createConditionalSettingsStore(async operation => operation(client)))
    const actor = { ...context(), signal: stopped.signal }
    const read = await owner.readMemory({ subjectAgentId: 'sadie' }, actor)
    const saving = owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { triggers: 900 } }, actor)
    await reached; stopped.abort()
    const result = await saving
    assert.equal(result.reason, 'operation_no_longer_admitted'); assert.equal(result.saved, 'not_requested')
    assert.deepEqual([...queue.commandsToWrite()], [])
  })
  it('cancels an unsent command at the server-owned deadline and refuses a missing cancellation signal', async () => {
    const queue = new RedisCommandsQueue(2, undefined, () => {})
    const client = readyClient(async () => ['OK', ...initial()])
    client.withAbortSignal = signal => ({ async eval(script, options) {
      return queue.addCommand(['EVAL', script, '1', ...options.keys, ...options.arguments], { abortSignal: signal })
    } })
    const owner = createOwnAgentSettingsExecutors(createConditionalSettingsStore(async operation => operation(client)))
    const actor = context()
    const read = await owner.readIdentity({ subjectAgentId: 'sadie' }, actor)
    const result = await owner.updateIdentity({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { displayName: 'New name' } }, { ...actor, deadlineAt: Date.now() + 100 })
    assert.equal(result.reason, 'operation_no_longer_admitted'); assert.equal(result.saved, 'not_requested')
    assert.deepEqual([...queue.commandsToWrite()], [])
    await assert.rejects(owner.updateIdentity({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { displayName: 'New name' } }, { ...actor, signal: undefined }), /operation_cancellation_signal_required/)
  })
  it('previews without mutations and explicitly refuses legacy/invalid budget parents', async () => {
    const f = fixture(); const owner = createOwnAgentSettingsExecutors(f.store)
    const read = await owner.readMemory({ subjectAgentId: 'sadie' }, context())
    const preview = await owner.previewMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { onMyMind: 900 } }, context())
    assert.equal(preview.status, 'preview'); assert.equal(preview.requiresConfirmation, true); assert.equal(f.writes.length, 0)
    f.stored[5] = raw(undefined); f.stored[6] = raw({ on_my_mind: 4000, triggers: 1800, recalled: 900 })
    const legacy = await owner.readMemory({ subjectAgentId: 'sadie' }, context())
    const request = { subjectAgentId: 'sadie', expectedRevision: legacy.revision, changes: { onMyMind: 800 } }
    assert.equal((await owner.previewMemory(request, context())).reason, 'legacy_budget_settings_require_human')
    assert.equal((await owner.updateMemory(request, context())).reason, 'legacy_budget_settings_require_human')
    f.stored[5] = raw([])
    const invalid = await owner.readMemory({ subjectAgentId: 'sadie' }, context())
    assert.equal((await owner.updateMemory({ ...request, expectedRevision: invalid.revision }, context())).reason, 'invalid_budget_shape')
    assert.equal(f.writes.length, 0)
  })
  it('sends one fixed-field patch and offers an exact conditional inverse', async () => {
    const f = fixture(); const owner = createOwnAgentSettingsExecutors(f.store)
    const read = await owner.readMemory({ subjectAgentId: 'sadie' }, context())
    const result = await owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { onMyMind: 900, triggers: 1200 } }, context())
    assert.equal(result.saved, 'saved'); assert.equal(result.readback, 'verified'); assert.equal(result.visible, 'unknown')
    assert.deepEqual((f.writes[0] as { changes: unknown }).changes, { onMyMind: 900 })
    assert.deepEqual(result.inverse?.changes, { onMyMind: 2000 })
    assert.equal(result.inverse?.expectedRevision, result.current?.revision)
    assert.equal(JSON.parse(f.stored[5])[0].untouchedSibling, 'keep')
    assert.equal(f.stored[4], raw(false))
    const undone = await owner.updateMemory(result.inverse, context())
    assert.equal(undone.saved, 'saved'); assert.equal(undone.current?.values.onMyMind, 2000)
  })
  it('does not reconcile defaults or write for an effective no-op', async () => {
    const f = fixture(); f.stored[5] = raw(undefined)
    const owner = createOwnAgentSettingsExecutors(f.store)
    const read = await owner.readMemory({ subjectAgentId: 'sadie' }, context())
    const result = await owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { onMyMind: 2000 } }, context())
    assert.equal(result.status, 'no_op'); assert.equal(result.saved, 'not_requested'); assert.equal(f.writes.length, 0)
  })
  it('refuses a changed memory sibling before writing and ignores identity drift for memory revision', async () => {
    const f = fixture(); const owner = createOwnAgentSettingsExecutors(f.store)
    const read = await owner.readMemory({ subjectAgentId: 'sadie' }, context())
    f.stored[3] = raw('A newer name')
    assert.equal((await owner.readMemory({ subjectAgentId: 'sadie' }, context())).revision, read.revision)
    f.stored[5] = raw({ on_my_mind: 2000, triggers: 1800, recalled: 2400 })
    const result = await owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { onMyMind: 900 } }, context())
    assert.equal(result.reason, 'revision_conflict'); assert.equal(f.writes.length, 0)
  })
  it('reports atomic refusals unchanged and never mistakes a lost save answer for failure', async () => {
    const f = fixture(); const owner = createOwnAgentSettingsExecutors(f.store)
    const read = await owner.readMemory({ subjectAgentId: 'sadie' }, context())
    for (const answer of ['CONFLICT', 'MISSING', 'FORBIDDEN', 'UNSUPPORTED_PRIMARY', 'INVALID_BUDGET_SHAPE', 'LEGACY_BUDGETS', 'INVALID_CHANGES']) {
      f.store.write = async () => answer
      const result = await owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { onMyMind: 900 } }, context())
      assert.equal(result.status, 'blocked'); assert.equal(result.saved, 'not_requested'); assert.equal(result.visible, 'unchanged')
    }
    f.store.write = async () => { throw new Error('connection lost after EVAL') }
    assert.equal((await owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { onMyMind: 900 } }, context())).status, 'unknown_outcome')
  })
  it('keeps a proved save when the separate readback fails or is newer', async () => {
    const f = fixture(); const owner = createOwnAgentSettingsExecutors(f.store)
    const read = await owner.readIdentity({ subjectAgentId: 'sadie' }, context())
    const write = f.store.write
    f.store.write = async (...args) => { const answer = await write(...args); f.store.read = async () => { throw new Error('read failed') }; return answer }
    const result = await owner.updateIdentity({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { displayName: 'Sadie New' } }, context())
    assert.equal(result.saved, 'saved'); assert.equal(result.status, 'completed'); assert.equal(result.readback, 'unavailable')
    const g = fixture(); const next = createOwnAgentSettingsExecutors(g.store)
    const first = await next.readIdentity({ subjectAgentId: 'sadie' }, context())
    g.store.write = async () => { g.stored[3] = raw('Concurrent name'); return 'OK' }
    const newer = await next.updateIdentity({ subjectAgentId: 'sadie', expectedRevision: first.revision, changes: { displayName: 'My choice' } }, context())
    assert.equal(newer.saved, 'saved'); assert.equal(newer.readback, 'changed'); assert.equal(newer.inverse, undefined)
  })
  it('does not claim lossless undo for a previously absent linger setting', async () => {
    const f = fixture(); f.stored[7] = raw(undefined)
    const owner = createOwnAgentSettingsExecutors(f.store); const read = await owner.readMemory({ subjectAgentId: 'sadie' }, context())
    const result = await owner.updateMemory({ subjectAgentId: 'sadie', expectedRevision: read.revision, changes: { triggerLingerTurns: 3 } }, context())
    assert.equal(result.saved, 'saved'); assert.equal(result.inverse, undefined)
    assert.equal(result.inverseUnavailable, 'previous_values_cannot_be_restored_losslessly')
  })
  it('validates documented RedisJSON JSONPath arrays and fixed source-controlled CAS paths', async () => {
    const calls: Array<{ script: string; keys: string[]; arguments: string[] }> = []
    const client = readyClient(async (script, options) => {
      calls.push({ script, ...options })
      return script === READ_SETTINGS_SNAPSHOT_SCRIPT ? ['OK', ...initial()] : 'OK'
    })
    const store = createConditionalSettingsStore(async operation => operation(client))
    const before = await store.read('sadie')
    assert.deepEqual(JSON.parse(calls[0].arguments[0]), SETTINGS_SNAPSHOT_PATHS)
    await store.write('sadie', 'josh', 'memory', before, { onMyMind: 900 })
    assert.equal(client.events.eventNames().length, 0)
    assert.equal(calls[1].script, CONDITIONAL_SETTINGS_WRITE_SCRIPT)
    assert.deepEqual(calls[1].keys, ['agent:sadie'])
    assert.deepEqual(JSON.parse(calls[1].arguments[4]), { onMyMind: 900 })
    const compared = JSON.parse(calls[1].arguments[2]) as string[][]
    assert(compared.some(([path]) => path === '$.memory_lane_budgets'))
    assert(!compared.some(([path]) => path.includes('provider') || path === '$'))
    const bad = createConditionalSettingsStore(async operation => operation(
      readyClient(async () => ['OK', ...initial().map(value => JSON.parse(value)[0])])
    ))
    await assert.rejects(bad.read('sadie'))
  })
})

describe('18-tab masked inspection', () => {
  it('reports malformed saved blocks unavailable while successful absent blocks remain unset', () => {
    for (const malformed of [[], false, 123, 'bad saved block']) {
      for (const [tab, block, ids] of [
        ['clips', 'ui_settings', ['compressImages', 'compressionQuality', 'maxImageSize', 'forceJpeg']],
        ['tools', 'global_zip_settings', ['zipViewMode', 'toolNotes']],
        ['voice', 'voice_settings', ['lipSyncMode']],
        ['3d-goons', 'goons_settings', ['dockOpen']]
      ] as const) {
        const result = projectSettingsInspection(tab, { userSettings: { [block]: malformed } }, 'developer')
        for (const id of ids) assert.equal(result.fields.find(field => field.id === id)?.state, 'unavailable')
        assert(!result.fields.some(field => field.state === 'value' && typeof field.value === 'string' && field.value.includes('bad saved')))
      }
      assert.equal(projectSettingsInspection('voice', { userSettings: { voice_settings: { goonLipSync: malformed, goonLipSyncMode: 'viseme' } } }, 'developer').fields[0].state, 'unavailable')
      assert.equal(projectSettingsInspection('user', { userSettings: malformed }, 'developer').fields[0].state, 'unavailable')
    }
    for (const absent of [undefined, null, {}]) {
      for (const [tab, block, ids] of [
        ['clips', 'ui_settings', ['compressImages', 'compressionQuality', 'maxImageSize', 'forceJpeg']],
        ['tools', 'global_zip_settings', ['zipViewMode', 'toolNotes']],
        ['voice', 'voice_settings', ['lipSyncMode']],
        ['3d-goons', 'goons_settings', ['dockOpen']]
      ] as const) {
        const result = projectSettingsInspection(tab, { userSettings: { [block]: absent } }, 'developer')
        assert.equal(result.availability, 'read_only')
        for (const id of ids) assert.equal(result.fields.find(field => field.id === id)?.state, 'unset')
      }
    }
  })
  it('projects the supported saved legacy lip-sync mode with current-owner precedence', () => {
    for (const mode of ['amplitude', 'viseme']) {
      const legacy = projectSettingsInspection('voice', { userSettings: { voice_settings: { goonLipSyncMode: mode } } }, 'developer')
      assert.equal(legacy.fields[0].state, 'value'); assert.equal(legacy.fields[0].value, mode)
    }
    const nested = projectSettingsInspection('voice', { userSettings: { voice_settings: { goonLipSync: { mode: 'amplitude' }, goonLipSyncMode: 'viseme' } } }, 'developer')
    assert.equal(nested.fields[0].value, 'amplitude')
    const emptyNested = projectSettingsInspection('voice', { userSettings: { voice_settings: { goonLipSync: {}, goonLipSyncMode: 'viseme' } } }, 'developer')
    assert.equal(emptyNested.fields[0].state, 'unset')
    for (const mode of [null, false, 1, 'unsupported', [], {}]) {
      assert.equal(projectSettingsInspection('voice', { userSettings: { voice_settings: { goonLipSync: { mode } } } }, 'developer').fields[0].state, 'unavailable')
      assert.equal(projectSettingsInspection('voice', { userSettings: { voice_settings: { goonLipSyncMode: mode } } }, 'developer').fields[0].state, 'unavailable')
    }
  })
  it('covers the exact tabs and never spreads sensitive source records', () => {
    assert.deepEqual(Object.keys(SETTINGS_FIELDS).sort(), [...SETTINGS_TABS].sort())
    const secret = 'DO_NOT_EXPOSE_TOKEN_OR_PATH'
    const sources = { entityCount: 3, agent: { displayName: 'Sadie', agentType: 'api' as const },
      userSettings: { displayName: 'Josh', user_id: 'josh', email: secret, global_custom_system_prompt: secret, admin_settings: { token: secret },
        ui_settings: { compress_images: false, compression_quality: 40, max_image_size: '1024', force_jpeg: true, token: secret, upload_settings: { tunnel_url: secret } },
        voice_settings: { goonLipSync: { mode: 'viseme' }, byoProviders: [{ apiKey: secret }], inputDeviceId: secret },
        goons_settings: { dockOpen: true, desktop: { shortcut: secret } }, global_zip_settings: { zip_ai_view_mode: 'inline', zip_tool_notes_enabled: true, credentials: secret } } }
    for (const tab of SETTINGS_TABS) {
      const result = projectSettingsInspection(tab, sources, 'developer')
      assert.equal(result.tab, tab); assert(!JSON.stringify(result).includes(secret))
      for (const field of result.fields) if (field.state !== 'value') assert(!Object.hasOwn(field, 'value'))
    }
    assert.equal(projectSettingsInspection('theme', sources, 'developer').availability, 'not_implemented')
    assert.equal(projectSettingsInspection('api-keys', sources, 'developer').availability, 'human_only')
    assert.equal(projectSettingsInspection('user', sources, 'agent').fields[0].state, 'masked')
    assert.equal(projectSettingsInspection('clips', { userSettings: { ui_settings: { compression_quality: 900 } } }, 'developer').fields.find(field => field.id === 'compressionQuality')?.state, 'unavailable')
    assert.throws(() => validateInspection({ tab: 'clips', path: '$.ui_settings' }))
    assert.throws(() => validateInspection({ tab: 'admin', subjectAgentId: 'sadie' }))
  })
  it('does not contact human-only/unsupported owners or fall back on a failed read', async () => {
    let reads = 0
    const store: SettingsInspectionStore = {
      async readUserSettings() { reads += 1; throw new Error('unavailable') },
      async countEntities() { reads += 1; throw new Error('unavailable') },
      async readAgent() { reads += 1; throw new Error('unavailable') },
      readMemory: createOwnAgentSettingsExecutors(fixture().store).readMemory
    }
    const inspect = createSettingsInspector(store)
    for (const tab of ['api-keys', 'admin', 'dev', 'theme', 'local-ai', 'icons', 'slash-commands']) await inspect({ tab }, developer)
    assert.equal(reads, 0)
    const result = await inspect({ tab: 'clips' }, developer)
    assert.equal(result.availability, 'unavailable'); assert.equal(result.reason, 'settings_source_unavailable')
    assert(result.fields.every(field => field.state === 'unavailable' || field.state === 'human_only'))
    await assert.rejects(inspect({ tab: 'memory', subjectAgentId: 'cooper' }, context()), /own_agent_required/)
  })
  it('keeps fixed catalog risks and requires an own-agent subject for every mutation', () => {
    assert.equal(SETTINGS_ACTION_DESCRIPTORS.find(action => action.id === 'settings.agent.memory.update')?.risk, 'confirm')
    assert.equal(SETTINGS_ACTION_DESCRIPTORS.find(action => action.id === 'settings.agent.identity.update')?.risk, 'safe')
    for (const action of SETTINGS_ACTION_DESCRIPTORS.filter(action => action.id.endsWith('.update'))) {
      assert.deepEqual(action.callers, ['agent']); assert.equal(action.actsAsAgent, true)
      assert.equal(action.inputSchema.additionalProperties, false)
    }
  })
})
