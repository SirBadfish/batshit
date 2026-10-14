import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_ACTIONS_VERSION, parseActionRequest } from './catalog'
import type { ActionRequest } from './catalog'
import { createAppActionsDocument } from './document'
import { retireAppActionNavigation } from './owners'
import type { ActionHandler } from './owners'

const documents: ReturnType<typeof createAppActionsDocument>[] = []
afterEach(() => { for (const doc of documents.splice(0)) doc.retire(); vi.useRealTimers() })
function fixture(handler: ActionHandler = async () => ({ status: 'completed', visible: 'applied' })) {
  let selected: string | null = 'session-a'
  const effect = vi.fn(handler)
  const feedback = vi.fn()
  const doc = createAppActionsDocument({ documentId: 'document-a', documentEpoch: 'epoch-a',
    session: () => selected, handler: () => effect, feedback })
  documents.push(doc)
  const request = (changes: Record<string, unknown> = {}): ActionRequest => ({
    requestId: 'request-a', catalogVersion: APP_ACTIONS_VERSION, documentId: 'document-a',
    documentEpoch: 'epoch-a', expectedSessionId: 'session-a', actionId: 'settings.close',
    args: {}, expiresAt: Date.now() + 4000, ...changes
  } as ActionRequest)
  return { doc, effect, feedback, request, select: (id: string | null) => { selected = id } }
}
function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function admitted() { for (let i = 0; i < 6; i++) await Promise.resolve() }

describe('page-local App Actions request boundary', () => {
  it.each([
    { actionId: 'settings.change' }, { actionId: 'goon.desktop' }, { catalogVersion: 'old' },
    { args: { selector: 'button' } }, { args: { callback: () => {} } },
    { actionId: 'settings.open', args: { tab: 'general' } },
    { actionId: 'settings.open', args: { tab: 'agents', section: 'memory' } },
    { actionId: 'settings.open', args: { tab: 'agents', agentId: '__create__' } },
    { actionId: 'settings.open', args: { tab: 'voice', agentId: 'agent-a' } },
    { actionId: 'settings.open', args: { tab: 'projects', mode: 'create' } },
    { actionId: 'settings.open', args: { tab: 'admin', diagnosticsAction: 'preview' } },
    { actionId: 'settings.open', args: { tab: 'tools', toolsTab: 'unsupported' } },
    { args: [] }, { args: null }, { approvalId: 'anything' }, { expectedSessionId: undefined },
    { expiresAt: Infinity }, { requestId: 'a/b' }
  ])('refuses malformed or effectful input before the owner: %j', async changes => {
    const f = fixture()
    const outcome = await f.doc.execute(f.request(changes))
    expect(outcome.status).toBe('blocked')
    expect(outcome.visible).toBe('unchanged')
    expect(f.effect).not.toHaveBeenCalled()
  })
  it('admits exactly the existing tools IDs and detaches input', () => {
    const f = fixture()
    for (const toolsTab of ['gateway-settings', 'cli-tools', 'tool-grid', 'zip-options']) {
      const input = f.request({ actionId: 'settings.open', args: { tab: 'tools', toolsTab } })
      const parsed = parseActionRequest(input)
      expect(parsed.args).toEqual({ tab: 'tools', toolsTab })
      expect(parsed.args).not.toBe(input.args)
    }
  })
  it.each([
    ['stale_document', { documentId: 'document-b' }],
    ['stale_document', { documentEpoch: 'epoch-b' }],
    ['stale_session', { expectedSessionId: 'session-b' }],
    ['expired_request', { expiresAt: 1 }],
    ['expired_request', { expiresAt: Date.now() + 60000 }]
  ])('refuses %s with no effects', async (reason, input) => {
    const f = fixture()
    expect(await f.doc.execute(f.request(input))).toMatchObject({ status: 'blocked', reason })
    expect(f.effect).not.toHaveBeenCalled()
  })
  it('keeps the same receipt for repeats before and after settlement; changed arguments refuse', async () => {
    const gate = barrier()
    const f = fixture(async (_, ctx) => { await gate.promise; ctx.check(); return { status: 'completed' } })
    const input = f.request()
    const first = f.doc.execute(input)
    expect(f.doc.execute({ ...input })).toBe(first)
    const conflict = await f.doc.execute({ ...input, actionId: 'goon.hide' })
    expect(conflict.reason).toBe('request_id_conflict')
    gate.release()
    const result = await first
    expect(await f.doc.execute(input)).toBe(result)
    expect(await f.doc.receipt(input.requestId)).toBe(result)
    expect(f.effect).toHaveBeenCalledTimes(1)
  })
  it('retains refused IDs too, so corrected expiry/session cannot revive an old request', async () => {
    const f = fixture()
    const input = f.request({ expiresAt: 1 })
    expect((await f.doc.execute(input)).reason).toBe('expired_request')
    expect((await f.doc.execute({ ...input, expiresAt: Date.now() + 4000 })).reason).toBe('request_id_conflict')
    expect(f.effect).not.toHaveBeenCalled()
  })
  it('does not queue a concurrent request for later', async () => {
    const gate = barrier()
    const f = fixture(async () => { await gate.promise; return { status: 'completed' } })
    const first = f.doc.execute(f.request())
    await admitted()
    const secondInput = f.request({ requestId: 'request-b' })
    expect(await f.doc.execute(secondInput)).toMatchObject({ status: 'blocked', reason: 'busy' })
    gate.release(); await first
    expect((await f.doc.execute(secondInput)).reason).toBe('busy')
    expect(f.effect).toHaveBeenCalledTimes(1)
  })
  it('retires navigation between submission and deferred admission without invoking the owner', async () => {
    const applied = vi.fn()
    const f = fixture(async (_, ctx) => { ctx.effect(); applied(); return { status: 'completed', visible: 'applied' } })
    const input = f.request()
    const first = f.doc.execute(input)
    expect(f.doc.execute(input)).toBe(first)
    retireAppActionNavigation()
    const result = await first
    expect(result).toMatchObject({ status: 'blocked', reason: 'user_navigation', visible: 'unchanged', saved: 'not_requested' })
    expect(f.effect).not.toHaveBeenCalled()
    expect(applied).not.toHaveBeenCalled()
    expect(f.doc.execute(input)).toBe(first)
    expect(await f.doc.receipt(input.requestId)).toBe(result)
    expect(await f.doc.execute(f.request({ requestId: 'after-navigation' }))).toMatchObject({ status: 'completed' })
    expect(applied).toHaveBeenCalledTimes(1)
  })
  it('blocks a same-turn second request rather than admitting it after the first flight', async () => {
    const gate = barrier()
    const f = fixture(async () => { await gate.promise; return { status: 'completed' } })
    const first = f.doc.execute(f.request())
    const secondInput = f.request({ requestId: 'same-turn-second' })
    const second = f.doc.execute(secondInput)
    expect(await second).toMatchObject({ status: 'blocked', reason: 'busy' })
    gate.release(); await first
    expect(f.doc.execute(secondInput)).toBe(second)
    expect((await second).reason).toBe('busy')
    expect(f.effect).toHaveBeenCalledTimes(1)
  })
  it('retires a user navigation before a late lazy mount can perform a selection', async () => {
    const gate = barrier(), selected = vi.fn()
    const f = fixture(async (_, ctx) => { await gate.promise; ctx.effect(); selected(); return { status: 'completed' } })
    const input = f.request(), first = f.doc.execute(input)
    await admitted(); retireAppActionNavigation()
    expect(await first).toMatchObject({ status: 'blocked', reason: 'user_navigation' })
    gate.release(); await admitted()
    expect(selected).not.toHaveBeenCalled()
    expect((await f.doc.execute(input)).reason).toBe('user_navigation')
  })
  it('keeps an interrupted write busy until the real flight settles, reports partial uncertainty, and never repeats it', async () => {
    const gate = barrier(), write = vi.fn()
    const f = fixture(async (_, ctx) => {
      ctx.effect(); write(); ctx.report({ status: 'unknown_outcome', visible: 'applied', saved: 'unknown' })
      await gate.promise; ctx.check(); return { status: 'completed', saved: 'saved' }
    })
    const input = f.request({ actionId: 'goon.show' }), first = f.doc.execute(input)
    await admitted(); retireAppActionNavigation()
    expect(await first).toMatchObject({ status: 'unknown_outcome', visible: 'applied', saved: 'unknown' })
    expect((await f.doc.execute(f.request({ requestId: 'request-b' }))).reason).toBe('busy')
    gate.release(); await admitted()
    await f.doc.execute(input)
    expect(write).toHaveBeenCalledTimes(1)
  })
  it('rechecks the selected session immediately before effects and completion', async () => {
    const gate = barrier(), write = vi.fn()
    const f = fixture(async (_, ctx) => { await gate.promise; ctx.effect(); write(); return { status: 'completed' } })
    const first = f.doc.execute(f.request())
    await admitted(); f.select('session-b'); gate.release()
    expect(await first).toMatchObject({ status: 'blocked', reason: 'stale_session' })
    expect(write).not.toHaveBeenCalled()
  })
  it('reports a deadline after effects as unknown and cancels waiters without late effects', async () => {
    vi.useFakeTimers()
    const gate = barrier(), laterEffect = vi.fn()
    const f = fixture(async (_, ctx) => { ctx.effect(); await gate.promise; ctx.check(); laterEffect(); return { status: 'completed' } })
    const first = f.doc.execute(f.request({ expiresAt: Date.now() + 50 }))
    await admitted(); await vi.advanceTimersByTimeAsync(50)
    expect(await first).toMatchObject({ status: 'unknown_outcome', reason: 'expired_request' })
    gate.release(); await admitted()
    expect(laterEffect).not.toHaveBeenCalled()
  })
  it('retires an unmounted document and exposes no replay onto another document', async () => {
    const f = fixture(); f.doc.retire()
    expect(await f.doc.execute(f.request())).toMatchObject({ status: 'blocked', reason: 'unmounted_document' })
    expect(f.doc.discover().actions.every(action => action.availability === 'unmounted_document')).toBe(true)
    expect(f.effect).not.toHaveBeenCalled()
  })
  it('bounds receipts without evicting old request IDs', async () => {
    const f = fixture()
    for (let i = 0; i < 128; i++) await f.doc.execute(f.request({ requestId: `request-${i}` }))
    expect((await f.doc.execute(f.request({ requestId: 'overflow' }))).reason).toBe('receipt_capacity')
    expect(f.effect).toHaveBeenCalledTimes(128)
  })
  it('offers bounded compact discovery and detached exact descriptions', () => {
    const f = fixture()
    expect(f.doc.discover().count).toBe(5)
    expect(f.doc.discover('settings', 1).actions).toHaveLength(1)
    expect(() => f.doc.discover('', 6)).toThrow('invalid_discovery')
    const description = f.doc.describe('settings.open')
    description.inputSchema.properties.tab.enum.splice(0)
    expect(f.doc.describe('settings.open').inputSchema.properties.tab.enum).toHaveLength(18)
  })
})
