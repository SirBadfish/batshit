import { afterEach, describe, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createAppActionsDocument } from './document'
import { createAppActionsBrowserTransport } from './browserTransport'
import { APP_ACTIONS_VERSION } from './catalog'
import { actionProofBytes, toActionBase64 } from './protocol'
import { createAppActionRegistry } from '../server/services/appActions/registry'
import type { AppActionCommand } from './protocol'
import type { ActionContext, ActionOutcome } from './owners'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })
const auth = { userId: 'owner', authenticationSession: 'cookie' }
const caller = { userId: 'owner', scopeId: 'agent:primary:chat' }
/** Injected transport behavior for one request: never sent, answered but lost, refused, or held first. */
type Fault = 'drop' | 'lose' | { hold?: Promise<void>; refuse?: string; status?: number; late?: Promise<void> }
function harness(options: { holdCommands?: boolean; publicationGate?: Promise<void>; now?: () => number;
  afterEffect?: (context: ActionContext) => Promise<ActionOutcome>;
  fault?: (path: string, body: Record<string, unknown>) => Fault | undefined;
  /** The page's clock runs this far ahead of the server's (milliseconds). */
  pageSkew?: number } = {}) {
  const listeners = new Set<(event: unknown) => void>()
  const errors: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  const paths: string[] = []
  let connected = true
  const events: AppActionCommand[] = []
  let effects = 0
  let session: string | null = 'chat'
  const registry = createAppActionRegistry({ validAuthentication: async () => true,
    now: options.now,
    publish: async (userId, event) => {
      if (event.type === 'app_action_requested') { events.push(event); if (options.holdCommands) return }
      if (options.publicationGate) await options.publicationGate
      for (const listener of listeners) listener({ ...event, userId })
    } })
  const pageNow = options.pageSkew === undefined ? options.now : () => (options.now ?? Date.now)() + options.pageSkew!
  const document = createAppActionsDocument({ documentId: 'document', documentEpoch: 'epoch',
    now: pageNow,
    session: () => session, feedback: () => {}, handler: () => async (_args, context) => {
      context.effect(); effects++
      if (options.afterEffect) return options.afterEffect(context)
      return { status: 'completed', visible: 'applied', saved: 'saved' }
    } })
  const fetcher: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    const path = String(input).split('/').pop() ?? ''
    paths.push(`${path}:${body.challengeId ? 'proof' : 'begin'}`)
    const fault = options.fault?.(path, body)
    if (fault === 'drop') throw new TypeError('network failure before the request reached the server')
    if (fault && typeof fault === 'object' && fault.hold) await fault.hold
    if (fault && typeof fault === 'object' && fault.refuse) {
      return new Response(JSON.stringify({ status: 'blocked', reason: fault.refuse }), { status: fault.status ?? 400 })
    }
    if (fault && typeof fault === 'object' && fault.late) {
      // The page gives up now; the request still reaches the server later.
      if (path === 'register') void fault.late.then(() => registry.prove(auth, String(body.challengeId), body.signature)).catch(() => {})
      throw new TypeError('the page stopped waiting while the request was still travelling')
    }
    try {
      let answer: unknown
      if (path === 'register') answer = body.challengeId
        ? await registry.prove(auth, body.challengeId, body.signature)
        : await registry.beginRegistration(auth, body.identity, body.publicKey)
      else if (path === 'renew') answer = body.challengeId
        ? await registry.prove(auth, body.challengeId, body.signature)
        : registry.beginRenewal(auth, body.registrationId, body.identity)
      else if (path === 'receipt') answer = await registry.acceptReceipt(auth, body.command, body.receipt, body.signature)
      else throw new Error('unexpected route')
      if (fault === 'lose') throw new TypeError('answer lost after the server accepted the request')
      return new Response(JSON.stringify(answer))
    } catch (error) {
      if (error instanceof TypeError) throw error
      return new Response(JSON.stringify({ reason: (error as Error).message }), { status: 400 })
    }
  }
  const transport = createAppActionsBrowserTransport(document, { fetch: fetcher, crypto: webcrypto as unknown as Crypto,
    now: pageNow,
    connected: () => connected, onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    feedback: reason => { errors.push(reason) } })
  cleanup.push(() => { transport.retire(); document.retire(); registry.dispose() })
  return { registry, transport, bodies, paths, errors, listeners, events, effectCount: () => effects,
    setSession: (value: string) => { session = value }, setConnected: (value: boolean) => { connected = value },
    emit: (event: unknown) => { for (const listener of listeners) listener(event) } }
}
describe('App Actions browser owner closure on the existing event channel', () => {
  for (const stop of [false, true]) it(`returns a finite unknown receipt while publication hangs${stop ? ' after Stop' : ''}, and refuses late delivery`, async () => {
    let time = 1000, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const h = harness({ now: () => time, publicationGate: gate })
    await h.transport.ready
    const controller = new AbortController()
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      const dispatched = await Promise.race([
        h.registry.dispatch({ ...caller, signal: controller.signal }, {
          requestId: `hanging-${stop}`, actionId: 'goon.show', args: {}, expectedSessionId: 'chat'
        }),
        new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('dispatch awaited stalled publisher')), 100) })
      ])
      clearTimeout(watchdog)
      if (stop) controller.abort()
      const result = await dispatched.result // Actual five-second command timeout; publisher still pending.
      assert.equal(result.receipt.status, 'unknown_outcome')
      assert.equal(result.receipt.reason, 'receipt_timeout')
      assert.equal(result.verified, false)
      assert.equal(h.effectCount(), 0)
      const repeated = await h.registry.dispatch(caller, {
        requestId: `hanging-${stop}`, actionId: 'goon.show', args: {}, expectedSessionId: 'chat'
      })
      assert.deepEqual(await repeated.result, result)
      assert.equal(h.events.length, 1)
      time = 6001 // Request expired, document lease still current.
      release()
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      assert.equal(h.effectCount(), 0)
      assert.equal(h.events.length, 1)
      assert.deepEqual(h.errors, ['expired_request'])
      assert.deepEqual(await repeated.result, result)
    } finally { clearTimeout(watchdog); time = 6001; release() }
  }, 15_000) // These two cases wait the real five-second deadline; keep other test budgets unchanged.
  it('registers a nonextractable-key document and signs only the owner-produced receipt', async () => {
    const h = harness()
    await h.transport.ready
    const dispatched = await h.registry.dispatch(caller, { requestId: 'request', actionId: 'goon.show', args: {}, expectedSessionId: 'chat' })
    const answer = await dispatched.result
    assert.equal(answer.verified, true)
    assert.equal(answer.receipt.status, 'completed')
    assert.equal(h.effectCount(), 1)
    const state = JSON.stringify(h.transport.state())
    assert.equal(state.includes('privateKey'), false)
    assert.equal(state.includes('signature'), false)
    assert.equal(Object.keys(h.transport).includes('sign'), false)
    const publicKey = h.bodies[0].publicKey as Record<string, unknown>
    assert.deepEqual(Object.keys(publicKey).sort(), ['crv', 'kty', 'x', 'y'])
    assert.equal(h.bodies.some(body => JSON.stringify(body).includes('authenticationSession')), false)
    assert.deepEqual(h.errors, [])
  })
  it('refuses stale selected sessions before effects and renews using the same document identity', async () => {
    const h = harness()
    await h.transport.ready
    const firstId = h.transport.state().registration?.registrationId
    h.setSession('new-chat')
    const dispatched = await h.registry.dispatch(caller, { requestId: 'stale', actionId: 'goon.show', args: {}, expectedSessionId: 'chat' })
    const answer = await dispatched.result
    assert.equal(answer.verified, true)
    assert.equal(answer.receipt.status, 'blocked')
    assert.equal(answer.receipt.reason, 'stale_session')
    assert.equal(h.effectCount(), 0)
    await h.transport.refresh()
    assert.equal(h.transport.state().registration?.registrationId, firstId)
    assert.equal(h.transport.state().registration?.expectedSessionId, 'new-chat')
  })
  it('ignores another registration and rejects altered command bytes without any owner effects', async () => {
    const h = harness()
    await h.transport.ready
    const binding = h.transport.state().registration!
    const request = { catalogVersion: APP_ACTIONS_VERSION, documentId: binding.documentId, documentEpoch: binding.documentEpoch,
      expectedSessionId: 'chat', requestId: 'fake', actionId: 'goon.show', args: {}, expiresAt: Date.now() + 4000 }
    const malicious = { type: 'app_action_requested', protocolVersion: 'app-actions-transport/v1',
      registrationId: binding.registrationId, registrationEpoch: binding.registrationEpoch, processId: binding.processId,
      nonce: 'nonce', actionHash: 'a'.repeat(43), request }
    for (const listener of h.listeners) listener({ ...malicious, registrationId: 'another-registration' })
    for (const listener of h.listeners) listener(malicious)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    assert.equal(h.effectCount(), 0)
    assert.deepEqual(h.errors, ['command_mismatch'])
  })
  it('never repeats effects for duplicate live events and cannot answer after retirement', async () => {
    const h = harness()
    await h.transport.ready
    const dispatched = await h.registry.dispatch(caller, { requestId: 'request', actionId: 'goon.show', args: {}, expectedSessionId: 'chat' })
    for (const listener of h.listeners) listener(h.events[0])
    assert.equal((await dispatched.result).verified, true)
    assert.equal(h.effectCount(), 1)
    h.transport.retire()
    assert.equal(h.listeners.size, 0)
    assert.equal(h.transport.state().ready, false)
  })
  it('uses actual nonextractable WebCrypto private keys and fails public-key signing', async () => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
    assert.equal(pair.privateKey.extractable, false)
    await assert.rejects(webcrypto.subtle.exportKey('jwk', pair.privateKey))
    await assert.rejects(webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, actionProofBytes('receipt', {})))
    const signature = toActionBase64(new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, actionProofBytes('register', {}))))
    assert.equal(signature.length, 86)
  })
  it('retires a command on Stop before asynchronous verification can begin owner effects', async () => {
    const h = harness()
    await h.transport.ready
    const controller = new AbortController()
    const dispatched = await h.registry.dispatch({ ...caller, signal: controller.signal }, {
      requestId: 'stopped', actionId: 'goon.show', args: {}, expectedSessionId: 'chat'
    })
    controller.abort()
    const result = await dispatched.result
    assert.equal(result.receipt.status, 'blocked')
    assert.equal(result.receipt.reason, 'caller_stopped')
    assert.equal(h.effectCount(), 0)
  })
  it('refuses wrong-nonce cancellation and ignores a different document cancellation', async () => {
    const h = harness()
    await h.transport.ready
    const dispatched = await h.registry.dispatch(caller, { requestId: 'active', actionId: 'goon.show', args: {}, expectedSessionId: 'chat' })
    const command = h.events[0]
    for (const listener of h.listeners) listener({ type: 'app_action_cancelled', command: { ...command, registrationId: 'sibling' } })
    for (const listener of h.listeners) listener({ type: 'app_action_cancelled', command: { ...command, nonce: 'forged-nonce' } })
    const result = await dispatched.result
    assert.equal(result.receipt.status, 'completed')
    assert.equal(h.effectCount(), 1)
    assert.deepEqual(h.errors, ['command_mismatch'])
  })
  it('remembers an exact Stop arriving before the command and retires cancellation replay without effects', async () => {
    const h = harness({ holdCommands: true })
    await h.transport.ready
    const controller = new AbortController()
    const dispatched = await h.registry.dispatch({ ...caller, signal: controller.signal }, {
      requestId: 'cancel-first', actionId: 'goon.show', args: {}, expectedSessionId: 'chat'
    })
    controller.abort()
    const command = h.events[0]
    for (const listener of h.listeners) {
      listener({ type: 'app_action_cancelled', command })
      listener(command)
      listener(command)
    }
    const result = await dispatched.result
    assert.equal(result.verified, true)
    assert.equal(result.receipt.status, 'blocked')
    assert.equal(result.receipt.reason, 'caller_stopped')
    assert.equal(h.effectCount(), 0)
    assert.deepEqual(h.errors, [])
  })
  it('reports Stop after effects as unknown while preserving a known save and flight custody', async () => {
    let began!: () => void, finish!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const ownerFinished = new Promise<void>(resolve => { finish = resolve })
    const h = harness({ afterEffect: async context => {
      context.report({ status: 'unknown_outcome', visible: 'applied', saved: 'saved' })
      began()
      await ownerFinished
      return { status: 'completed', visible: 'applied', saved: 'saved' }
    } })
    await h.transport.ready
    const controller = new AbortController()
    const dispatched = await h.registry.dispatch({ ...caller, signal: controller.signal }, {
      requestId: 'stop-after-effect', actionId: 'goon.show', args: {}, expectedSessionId: 'chat'
    })
    await started
    controller.abort()
    const result = await dispatched.result
    assert.equal(result.verified, true)
    assert.equal(result.receipt.status, 'unknown_outcome')
    assert.equal(result.receipt.reason, 'caller_stopped')
    assert.equal(result.receipt.saved, 'saved')
    assert.equal(result.receipt.visible, 'applied')
    const busy = await h.registry.dispatch(caller, { requestId: 'while-uncertain', actionId: 'goon.show', args: {}, expectedSessionId: 'chat' })
    assert.equal((await busy.result).receipt.reason, 'busy')
    assert.equal(h.effectCount(), 1)
    finish()
    const replay = await h.registry.dispatch(caller, { requestId: 'stop-after-effect', actionId: 'goon.show', args: {}, expectedSessionId: 'chat' })
    assert.deepEqual(await replay.result, result)
    assert.equal(h.effectCount(), 1)
  })
})

describe('App Actions lease recovery after a lapse (BL-1273)', () => {
  const count = (paths: string[], name: string) => paths.filter(path => path === name).length
  it('reconciles the exact registration first, then gives the still-mounted document a NEW challenged binding', async () => {
    let time = 1000
    const h = harness({ now: () => time })
    await h.transport.ready
    const old = h.transport.state().registration!
    time = old.expiresAt + 1 // The server has pruned the binding; the page's lease has passed.
    await h.transport.refresh()
    const fresh = h.transport.state().registration!
    assert.notEqual(fresh.registrationId, old.registrationId)
    assert.notEqual(fresh.registrationEpoch, old.registrationEpoch)
    assert.equal(fresh.documentId, old.documentId)
    assert.equal(fresh.documentEpoch, old.documentEpoch)
    assert.equal(h.transport.state().ready, true)
    assert.deepEqual(h.paths.slice(2), ['renew:begin', 'register:begin', 'register:proof'])
    assert.deepEqual(h.registry.listDocuments('owner').map(binding => binding.registrationId), [fresh.registrationId])
    await assert.rejects(h.registry.dispatch(caller, { requestId: 'old-target', actionId: 'goon.show', args: {},
      expectedSessionId: 'chat', targetDocumentId: old.registrationId }), /stale_or_wrong_document/)
    // A live event for the old registration is not this document's command any more.
    const request = { catalogVersion: APP_ACTIONS_VERSION, documentId: old.documentId, documentEpoch: old.documentEpoch,
      expectedSessionId: 'chat', requestId: 'old-event', actionId: 'goon.show', args: {}, expiresAt: time + 4000 }
    h.emit({ type: 'app_action_requested', protocolVersion: 'app-actions-transport/v1', registrationId: old.registrationId,
      registrationEpoch: old.registrationEpoch, processId: old.processId, nonce: 'old-nonce', actionHash: 'a'.repeat(43), request })
    const current = await h.registry.dispatch(caller, { requestId: 'new-target', actionId: 'goon.show', args: {},
      expectedSessionId: 'chat', targetDocumentId: fresh.registrationId })
    assert.equal((await current.result).verified, true)
    assert.equal(h.effectCount(), 1)
    assert.deepEqual(h.errors, [])
  })
  it('reconciles a lost renewal answer on the same exact registration and never makes a second binding', async () => {
    let lose = true
    const h = harness({ fault: (path, body) => {
      if (lose && path === 'renew' && body.challengeId) { lose = false; return 'lose' }
      return undefined
    } })
    await h.transport.ready
    const first = h.transport.state().registration!
    await assert.rejects(h.transport.refresh()) // The server extended the lease; the page never saw the answer.
    assert.deepEqual(h.errors, ['transport_failed'])
    await h.transport.refresh()
    assert.equal(h.transport.state().registration!.registrationId, first.registrationId)
    assert.equal(h.transport.state().ready, true)
    assert.equal(count(h.paths, 'register:begin'), 1)
    assert.equal(h.registry.listDocuments('owner').length, 1)
  })
  it('makes no binding while a lost registration proof could still be admitted, then adopts that exact binding', async () => {
    let time = 1000, lose = false
    const h = harness({ now: () => time, fault: (path, body) => {
      if (lose && path === 'register' && body.challengeId) { lose = false; return 'lose' }
      return undefined
    } })
    await h.transport.ready
    const old = h.transport.state().registration!
    time = old.expiresAt + 1
    lose = true
    await assert.rejects(h.transport.refresh()) // Old binding gone; the fresh proof was admitted but its answer lost.
    const admitted = h.registry.listDocuments('owner')
    assert.equal(admitted.length, 1)
    assert.notEqual(admitted[0].registrationId, old.registrationId)
    const registrations = count(h.paths, 'register:begin')
    await h.transport.refresh() // Inside the lost proof's challenge horizon: wait, never register again.
    assert.equal(count(h.paths, 'register:begin'), registrations)
    assert.equal(h.transport.state().registration, null)
    time += 5000 + 1000 + 1 // Past that challenge horizon plus the margin.
    await h.transport.refresh()
    assert.equal(h.transport.state().registration!.registrationId, admitted[0].registrationId)
    assert.equal(count(h.paths, 'register:begin'), registrations)
    assert.equal(h.registry.listDocuments('owner').length, 1)
    assert.equal(h.transport.state().ready, true)
  })
  it('cannot make a second binding when a registration proof the page gave up on still reaches the server', async () => {
    let time = 1000, late = false, arrive!: () => void
    const arrival = new Promise<void>(resolve => { arrive = resolve })
    const h = harness({ now: () => time, fault: (path, body) => {
      if (late && path === 'register' && body.challengeId) { late = false; return { late: arrival } }
      return undefined
    } })
    await h.transport.ready
    const old = h.transport.state().registration!
    time = old.expiresAt + 1
    late = true
    await assert.rejects(h.transport.refresh()) // The proof is still travelling: the server has not seen it yet.
    assert.equal(h.registry.listDocuments('owner').length, 0)
    const registrations = count(h.paths, 'register:begin')
    await h.transport.refresh() // Absent now, but it could still be admitted: no new registration.
    assert.equal(count(h.paths, 'register:begin'), registrations)
    arrive()
    await vi.waitFor(() => assert.equal(h.registry.listDocuments('owner').length, 1))
    const admitted = h.registry.listDocuments('owner')[0]
    time += 5000 + 1000 + 1
    await h.transport.refresh()
    assert.equal(h.transport.state().registration!.registrationId, admitted.registrationId)
    assert.equal(h.registry.listDocuments('owner').length, 1)
    assert.equal(count(h.paths, 'register:begin'), registrations)
  })
  for (const leave of ['retire', 'switch'] as const) it(`sends no registration when the old binding is reported gone after a ${leave === 'retire' ? 'retirement' : 'chat switch'}`, async () => {
    let holding = false, release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const h = harness({ fault: (path, body) => holding && path === 'renew' && !body.challengeId
      ? { hold, refuse: 'stale_registration', status: 409 } : undefined })
    await h.transport.ready
    holding = true
    const pass = h.transport.refresh()
    if (leave === 'retire') h.transport.retire(); else h.setSession('new-chat')
    release()
    await assert.rejects(pass, /stale_session/)
    assert.deepEqual(h.paths.slice(2), ['renew:begin'])
  })
  it('waits out a lost proof by the page clock even when the server clock is behind', async () => {
    let time = 1000, late = false, arrive!: () => void
    const arrival = new Promise<void>(resolve => { arrive = resolve })
    const h = harness({ now: () => time, pageSkew: 4000, fault: (path, body) => {
      if (late && path === 'register' && body.challengeId) { late = false; return { late: arrival } }
      return undefined
    } })
    await h.transport.ready
    const old = h.transport.state().registration!
    time = old.expiresAt + 1
    late = true
    await assert.rejects(h.transport.refresh())
    const registrations = h.paths.filter(path => path === 'register:begin').length
    time += 2500 // By the server's challenge time the horizon looks passed on this fast page clock; it is not.
    await h.transport.refresh()
    assert.equal(h.paths.filter(path => path === 'register:begin').length, registrations)
    arrive()
    await vi.waitFor(() => assert.equal(h.registry.listDocuments('owner').length, 1))
    time += 5000
    await h.transport.refresh()
    assert.equal(h.registry.listDocuments('owner').length, 1)
    assert.equal(h.transport.state().registration!.registrationId, h.registry.listDocuments('owner')[0].registrationId)
  })
  it('recovers a failed first registration through the same bounded maintenance', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let drops = 1
      const h = harness({ fault: (path, body) => {
        if (drops > 0 && path === 'register' && !body.challengeId) { drops--; return 'drop' }
        return undefined
      } })
      await assert.rejects(h.transport.ready)
      assert.deepEqual(h.errors, ['transport_failed'])
      await vi.advanceTimersByTimeAsync(1000)
      await vi.waitFor(() => assert.equal(h.transport.state().ready, true))
      assert.equal(h.registry.listDocuments('owner').length, 1)
      assert.equal(h.paths.filter(path => path === 'register:begin').length, 2)
    } finally { vi.useRealTimers() }
  })
  it('adopts a first registration whose answer was lost instead of registering twice', async () => {
    let time = 1000, lose = true
    const h = harness({ now: () => time, fault: (path, body) => {
      if (lose && path === 'register' && body.challengeId) { lose = false; return 'lose' }
      return undefined
    } })
    await assert.rejects(h.transport.ready)
    assert.equal(h.registry.listDocuments('owner').length, 1)
    time += 5000 + 1000 + 1
    await h.transport.refresh()
    assert.equal(h.transport.state().registration!.registrationId, h.registry.listDocuments('owner')[0].registrationId)
    assert.equal(h.paths.filter(path => path === 'register:begin').length, 1)
    assert.equal(h.registry.listDocuments('owner').length, 1)
  })
  it('drops a maintenance answer that arrives after retirement', async () => {
    let holding = false, release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const h = harness({ fault: (path, body) => holding && path === 'renew' && !body.challengeId ? { hold } : undefined })
    await h.transport.ready
    holding = true
    const pass = h.transport.refresh()
    h.transport.retire()
    release()
    await assert.rejects(pass, /stale_session/)
    assert.deepEqual(h.paths.slice(2), ['renew:begin'])
    assert.deepEqual(h.errors, [])
  })
  it('never signs a receipt for a command received under a registration generation that was replaced', async () => {
    let finish!: () => void, gone = false
    const finished = new Promise<void>(resolve => { finish = resolve })
    const h = harness({
      afterEffect: async () => { await finished; return { status: 'completed', visible: 'applied', saved: 'saved' } },
      fault: (path, body) => gone && path === 'renew' && !body.challengeId ? { refuse: 'stale_registration', status: 409 } : undefined
    })
    await h.transport.ready
    const old = h.transport.state().registration!
    await h.registry.dispatch(caller, { requestId: 'in-flight', actionId: 'goon.show', args: {}, expectedSessionId: 'chat' })
    await vi.waitFor(() => assert.equal(h.effectCount(), 1))
    gone = true // The server reports the old binding gone, as after a restart.
    await h.transport.refresh()
    assert.notEqual(h.transport.state().registration!.registrationId, old.registrationId)
    finish()
    await vi.waitFor(() => assert.ok(h.errors.includes('stale_registration')))
    assert.equal(count(h.paths, 'receipt:begin'), 0)
  })
  for (const renewed of [false, true]) it(`signs the admitted command's own receipt after a chat switch${renewed ? ' and a same-binding renewal' : ''}`, async () => {
    let finish!: () => void
    const finished = new Promise<void>(resolve => { finish = resolve })
    const h = harness({ afterEffect: async () => { await finished; return { status: 'completed', visible: 'applied', saved: 'saved' } } })
    await h.transport.ready
    const first = h.transport.state().registration!
    const dispatched = await h.registry.dispatch(caller, { requestId: `switch-${renewed}`, actionId: 'goon.show', args: {}, expectedSessionId: 'chat' })
    await vi.waitFor(() => assert.equal(h.effectCount(), 1))
    h.setSession('new-chat')
    if (renewed) {
      await h.transport.refresh() // Ordinary same-binding renewal: not a replacement generation.
      assert.equal(h.transport.state().registration!.registrationId, first.registrationId)
      assert.equal(h.transport.state().registration!.expectedSessionId, 'new-chat')
    }
    finish()
    // The page signs the receipt for the original command and session; it never suppresses or reassigns it.
    await vi.waitFor(() => assert.equal(h.paths.filter(path => path === 'receipt:begin').length, 1))
    if (!renewed) {
      // The owner's own truthful receipt: the effect was saved, then the chat changed before it finished.
      const result = await dispatched.result
      assert.equal(result.verified, true)
      assert.equal(result.receipt.requestId, 'switch-false')
      assert.equal(result.receipt.status, 'unknown_outcome')
      assert.equal(result.receipt.reason, 'stale_session')
      assert.equal(result.receipt.saved, 'saved')
      assert.deepEqual(h.errors, [])
    } else {
      // Unchanged server rule: the renewed binding now serves another chat, so the server refuses this receipt.
      await vi.waitFor(() => assert.ok(h.errors.includes('receipt_replayed_or_expired')))
    }
  })
  it('stops after three transient attempts with a visible reason and recovers on the existing reconnected event', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let down = false
      const h = harness({ fault: path => down && path === 'renew' ? 'drop' : undefined })
      await h.transport.ready
      const first = h.transport.state().registration!
      down = true
      await assert.rejects(h.transport.refresh())
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(120_000)
      assert.equal(count(h.paths, 'renew:begin'), 3)
      assert.deepEqual(h.errors, ['transport_failed', 'recovery_exhausted'])
      assert.equal(h.transport.state().ready, false)
      down = false
      h.emit({ type: 'reconnected' })
      await vi.waitFor(() => assert.equal(h.transport.state().ready, true))
      assert.equal(h.transport.state().registration!.registrationId, first.registrationId)
      assert.equal(count(h.paths, 'register:begin'), 1)
    } finally { vi.useRealTimers() }
  })
  it('treats a disconnected user channel as transient and sends nothing until it returns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = harness()
      await h.transport.ready
      h.setConnected(false)
      await assert.rejects(h.transport.refresh(), /live_document_unavailable/)
      await vi.advanceTimersByTimeAsync(3000)
      assert.deepEqual(h.paths, ['register:begin', 'register:proof'])
      assert.deepEqual(h.errors, ['live_document_unavailable', 'recovery_exhausted'])
      h.setConnected(true)
      await h.transport.refresh()
      assert.equal(h.transport.state().ready, true)
    } finally { vi.useRealTimers() }
  })
  for (const reason of ['authentication_required', 'untrusted_origin', 'invalid_signature', 'invalid_request']) {
    it(`never retries a ${reason} refusal as a transient failure`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        let refusing = false
        const h = harness({ fault: (path, body) => refusing && path === 'renew' && !body.challengeId ? { refuse: reason } : undefined })
        await h.transport.ready
        refusing = true
        await assert.rejects(h.transport.refresh(), new RegExp(reason))
        await vi.advanceTimersByTimeAsync(120_000)
        assert.equal(count(h.paths, 'renew:begin'), 1)
        assert.deepEqual(h.errors, [reason])
      } finally { vi.useRealTimers() }
    })
  }
})
