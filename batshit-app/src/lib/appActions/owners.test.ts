import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppActionsDocument } from './document'
import { APP_ACTIONS_VERSION } from './catalog'
import { performDockAction, registerAppAction, registerAppActionDraft, retireAppActionNavigation } from './owners'
import type { DockPorts } from './owners'
const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0)) fn() })
function fixture({ desktop = 'inactive', visible = false, confirmed = true, saved = 'saved' } = {} as {
  desktop?: 'inactive' | 'active' | 'transitioning'; visible?: boolean; confirmed?: boolean; saved?: 'saved' | 'failed' | 'unknown'
}) {
  const apply = vi.fn((open: boolean) => { visible = open })
  const persist = vi.fn(async () => saved)
  const ports: DockPorts = { desktop: () => desktop, visible: () => visible, confirmed: () => confirmed,
    apply, persist, mounted: () => true }
  const doc = createAppActionsDocument({ documentId: 'document', documentEpoch: 'epoch', session: () => null,
    handler: id => (_, ctx) => performDockAction(id === 'goon.show', ports, ctx), feedback: vi.fn() })
  cleanup.push(() => doc.retire())
  const expiresAt = Date.now() + 4000
  const execute = (show = true, requestId = 'request') => doc.execute({ requestId, catalogVersion: APP_ACTIONS_VERSION,
    documentId: 'document', documentEpoch: 'epoch', expectedSessionId: null,
    actionId: show ? 'goon.show' : 'goon.hide', args: {}, expiresAt })
  return { execute, apply, persist, doc, ports }
}
describe('ordinary Dock action owner', () => {
  it('continues to reject duplicate direct action owners', () => {
    cleanup.push(registerAppAction('goon.show', vi.fn()))
    expect(() => registerAppAction('goon.show', vi.fn())).toThrow('App Action owner already mounted: goon.show')
  })
  it.each(['active', 'transitioning'] as const)('refuses Desktop %s before any visibility/save call', async desktop => {
    const f = fixture({ desktop })
    expect(await f.execute()).toMatchObject({ status: 'blocked', reason: desktop === 'active' ? 'desktop_mode_active' : 'desktop_transitioning' })
    expect(f.apply).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled()
  })
  it.each([true, false])('matching visibility %s does not reconcile the saved preference, even with an unconfirmed read', async visible => {
    const f = fixture({ visible, confirmed: false })
    expect(await f.execute(visible)).toMatchObject({ status: 'no_op', saved: 'not_requested' })
    expect(f.apply).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled()
  })
  it('requires a confirmed read before changing anything', async () => {
    const f = fixture({ confirmed: false })
    expect((await f.execute()).reason).toBe('settings_unconfirmed')
    expect(f.apply).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled()
  })
  it('preserves an unsaved editor without queuing Save/Discard or a visibility write', async () => {
    cleanup.push(registerAppActionDraft(() => true))
    const f = fixture()
    expect((await f.execute()).reason).toBe('unsaved_changes')
    expect(f.apply).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled()
  })
  it('reports a committed persistence flight as unknown when interrupted before its response, retaining one write and busy custody', async () => {
    const f = fixture()
    let releaseResponse!: () => void
    let enteredPersistence!: () => void
    const responseHeld = new Promise<void>(resolve => { releaseResponse = resolve })
    const dispatched = new Promise<void>(resolve => { enteredPersistence = resolve })
    let committedDockOpen = false
    // The real owner and document run together. Only the owning persistence port
    // is substituted: commit first, then hold its response as in the live POST proof.
    f.persist.mockImplementation(async () => {
      committedDockOpen = true
      enteredPersistence()
      await responseHeld
      return 'saved'
    })
    const first = f.execute()
    try {
      await dispatched
      expect(committedDockOpen).toBe(true)
      expect(f.execute()).toBe(first)
      retireAppActionNavigation()
      const receipt = await first
      expect(receipt).toMatchObject({ status: 'unknown_outcome', reason: 'user_navigation',
        visible: 'applied', saved: 'unknown' })
      expect(f.doc.state().busy).toBe(true)
      expect(await f.execute(false, 'while-response-held')).toMatchObject({ status: 'blocked', reason: 'busy',
        visible: 'unchanged', saved: 'not_requested' })
      expect(f.apply).toHaveBeenCalledOnce()
      expect(f.persist).toHaveBeenCalledOnce()
      releaseResponse()
      await vi.waitFor(() => expect(f.doc.state().busy).toBe(false))
      expect(f.execute()).toBe(first)
      expect(await f.execute()).toBe(receipt)
      expect(await f.doc.receipt('request')).toBe(receipt)
      expect((await f.execute(false, 'while-response-held')).reason).toBe('busy')
      expect(f.apply).toHaveBeenCalledOnce()
      expect(f.persist).toHaveBeenCalledOnce()
    } finally {
      releaseResponse()
    }
  })
  it('keeps persistence not requested when retirement occurs after visibility but before dispatch', async () => {
    const f = fixture()
    f.ports.apply = open => { f.apply(open); retireAppActionNavigation() }
    expect(await f.execute()).toMatchObject({ status: 'unknown_outcome', reason: 'user_navigation',
      visible: 'applied', saved: 'not_requested' })
    expect(f.apply).toHaveBeenCalledOnce()
    expect(f.persist).not.toHaveBeenCalled()
  })
  it.each([
    ['saved', 'completed'], ['failed', 'failed'], ['unknown', 'unknown_outcome']
  ] as const)('distinguishes visibility from saved outcome %s', async (saved, status) => {
    const f = fixture({ saved })
    expect(await f.execute()).toMatchObject({ status, saved, visible: 'applied' })
    expect(f.apply).toHaveBeenCalledOnce(); expect(f.persist).toHaveBeenCalledOnce()
  })
})
