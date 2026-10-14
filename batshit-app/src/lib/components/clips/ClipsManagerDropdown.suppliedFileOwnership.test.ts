import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { tick, type ComponentProps } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ClipsManagerDropdown from './ClipsManagerDropdown.svelte'
import { toast } from 'svelte-sonner'
import type { ActionContext } from '$lib/appActions/owners'
import type { ImportOutcome } from '$lib/appActions/imports/contracts'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
import { confirmDialog } from '$lib/stores/confirmDialog'

// Mounted owner proof: qualification-3 retained eight fixture failures. V6's
// actual mounted rerun is held by coordinator. Actual component +
// import leaf + Svelte clippedItems publication. Fakes retain the actual clip_state
// sessionId/clips shape and simulate a 500 after its write, rather than treating !ok as no write.
vi.mock('svelte-sonner', () => ({ toast: { loading: vi.fn(() => 'upload'), dismiss: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('$lib/stores/confirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }))
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const state = (sessionId: string, ids: string[]) => ({ sessionId, clips: ids.map(clipId => ({ clipId, unclipAfter: null, messagesUntilUnclip: null })) })
const file = (name: string) => new File(['Clip bytes'], name, { type: 'text/plain' })
function browserStubs() {
  if (!Element.prototype.animate) Object.defineProperty(Element.prototype, 'animate', {
    configurable: true, value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null })
  })
  if (!globalThis.ResizeObserver) vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
}
function context(): ActionContext {
  return { sessionId: 'session_a', signal: new AbortController().signal, check() {}, effect() {}, report() {},
    async wait<T>(read: () => T | undefined) { const value = read(); if (value === undefined) throw new Error('Unconfirmed'); return value } }
}
function routes(kind: 'partial' | 'partial_unknown' | '500_after_write' | '500_unknown' | 'lost_final' | 'settings_fail' | 'late_write' | 'held_snapshot') {
  const saved = new Map<string, Record<string, unknown>>()
  const attached = new Map<string, string[]>([['session_a', []], ['session_b', []]])
  const mutations: Array<{ sessionId: string; clipId: string }> = []
  let allowReads = false, uploadEntered: (() => void) | undefined, uploadHold: Promise<void> | undefined
  let nextClipIndex = 0, pendingPost: (() => void) | undefined, failNextAttach = false, failNextRead = false
  let heldRead: { hold: Promise<void>; entered: () => void } | undefined
  let heldAttachment: { hold: Promise<void>; entered: () => void } | undefined
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    if (url === '/api/user/settings') return kind === 'settings_fail' ? json({ error: 'unavailable' }, 503) : json({ settings: null })
    if (url === '/api/clips' && method === 'GET') return json([...saved.values()])
    if (url === '/api/uploads/clips' && method === 'POST') {
      uploadEntered?.()
      if (uploadHold) await uploadHold
      const files = (init.body as FormData).getAll('files') as File[]
      return json({ files: files.map(entry => {
        const id = `clip_${String.fromCharCode(97 + nextClipIndex++)}`
        saved.set(id, { id, filename: entry.name, fileType: 'text', mimeType: 'text/plain', systemClip: false, storageMode: 'local' })
        return { originalName: entry.name, mimetype: 'text/plain', localUrl: `/uploads/${entry.name}`, clipData: { id, tokens: 3 } }
      }) })
    }
    if (url.startsWith('/api/clips/') && method === 'GET') return json(saved.get(url.split('/').at(-1)!))
    if (url === '/api/session-clips/state' && method === 'POST') {
      const payload = JSON.parse(String(init.body))
      mutations.push(payload)
      if (kind === 'held_snapshot' && heldAttachment) {
        // The real POST builds a whole state before its asynchronous write.
        const next = [...new Set([...(attached.get(payload.sessionId) ?? []), payload.clipId])]
        const owned = heldAttachment; heldAttachment = undefined; owned.entered(); await owned.hold
        attached.set(payload.sessionId, next)
        return json(state(payload.sessionId, next))
      }
      if (heldAttachment) { const owned = heldAttachment; heldAttachment = undefined; owned.entered(); await owned.hold }
      if (kind === 'late_write') {
        const next = [...new Set([...(attached.get(payload.sessionId) ?? []), payload.clipId])]
        pendingPost = () => { attached.set(payload.sessionId, next) }
        throw new Error('Browser response lost while server write remains pending')
      }
      if (failNextAttach) { failNextAttach = false; return json({ error: 'completed attachment request failed' }, 500) }
      if (kind.startsWith('partial') && payload.clipId === 'clip_b') return json({ error: 'refused' }, 403)
      attached.set(payload.sessionId, payload.action === 'detach'
        ? (attached.get(payload.sessionId) ?? []).filter(id => id !== payload.clipId)
        : [...new Set([...(attached.get(payload.sessionId) ?? []), payload.clipId])])
      if (kind.startsWith('500')) return json({ error: 'active set write failed after clip_state write' }, 500)
      return json(state(payload.sessionId, attached.get(payload.sessionId)!))
    }
    if (url.startsWith('/api/session-clips/state/') && method === 'GET') {
      const target = decodeURIComponent(url.split('/').at(-1)!)
      const observed = state(target, [...(attached.get(target) ?? [])])
      if (heldRead) { const owned = heldRead; heldRead = undefined; owned.entered(); await owned.hold; return json(observed) }
      if (failNextRead) { failNextRead = false; throw new Error('New read response lost') }
      if (saved.size && !allowReads && ['partial_unknown', '500_unknown', 'lost_final'].includes(kind)) throw new Error('Read response lost')
      return json(state(target, attached.get(target) ?? []))
    }
    if (method === 'DELETE' && (url === '/api/clips' || url.startsWith('/api/clips/'))) {
      const ids: string[] = url === '/api/clips' ? JSON.parse(String(init.body)).clipIds : [url.split('/').at(-1)!]
      const results = ids.map(clipId => ({ clipId, deleted: true, missing: !saved.has(clipId) }))
      // Permanent deletion has this actual all-user-session effect, even when
      // invoked from a different current chat or without a selected chat.
      for (const [target, existing] of attached) attached.set(target, existing.filter(id => !ids.includes(id)))
      for (const id of ids) saved.delete(id)
      return url === '/api/clips' ? json({ success: true, deleted: results.length, missing: results.filter(result => result.missing).map(result => result.clipId), results })
        : json({ success: true, result: results[0] })
    }
    throw new Error(`Unexpected ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { mutations, fetchMock, attached, saved, allowReadback: () => { allowReads = true },
    releasePendingPost: () => { if (!pendingPost) throw new Error('No pending server write'); pendingPost() },
    holdNextRead: (hold: Promise<void>, entered: () => void) => { heldRead = { hold, entered } },
    failNextAttachmentRead: () => { failNextAttach = true; failNextRead = true },
    holdNextAttachment: (hold: Promise<void>, entered: () => void) => { heldAttachment = { hold, entered } },
    holdUpload: (hold: Promise<void>, entered: () => void) => { uploadHold = hold; uploadEntered = entered } }
}
async function mountClips(withUser = false) {
  const publications: string[][] = []
  const props = { sessionId: 'session_a', pageData: withUser ? { user: { id: 'test_user' } } as unknown as ComponentProps<typeof ClipsManagerDropdown>['pageData'] : null,
    onClippedItemsChange: (clips: Array<{ id: string }>) => publications.push(clips.map(clip => clip.id)) }
  const view = render(ClipsManagerDropdown, { props })
  // jsdom has no layout. Bits hides a connected floating anchor once its
  // getClientRects() is empty, so model only this actual visible trigger's box.
  // Keep the real portal, visibility logic and accessible-role queries intact.
  const trigger = view.getByTestId('manage-clips-button')
  const triggerRect = new DOMRect(12, 12, 32, 32)
  vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => trigger.isConnected && !trigger.hidden ? triggerRect : new DOMRect())
  vi.spyOn(trigger, 'getClientRects').mockImplementation(() => {
    const rects = trigger.isConnected && !trigger.hidden ? [triggerRect] : []
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null })
  })
  await waitFor(() => expect(publications.length).toBeGreaterThan(0))
  await tick()
  const owner = view.component as unknown as {
    importAppActionFiles(args: unknown, files: File[], context: ActionContext): Promise<ImportOutcome>
    getClippedItems(): Array<{ id: string }>
    detachClipById(id: string): Promise<void>
  }
  return { view, owner, props, publications }
}
async function openClips() {
  // The actual menu's opening GET also proves retained evidence survives a normal refresh.
  await fireEvent.pointerDown(screen.getByTestId('manage-clips-button'), { button: 0, pointerType: 'mouse', ctrlKey: false })
  await tick()
  expect(await screen.findByRole('menu')).toBeVisible()
}
async function flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await tick() } }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function requestPermanentXDelete(kind: 'single' | 'bulk') {
  expect(await screen.findByRole('menu')).toBeVisible()
  if (kind === 'single') await fireEvent.click(await screen.findByRole('button', { name: 'Delete clip x.txt permanently' }))
  else {
    const enterBulk = screen.queryByRole('button', { name: 'Bulk Delete' })
    if (enterBulk) await fireEvent.click(enterBulk)
    const checkbox = await screen.findByRole('checkbox', { name: 'Select x.txt for deletion' })
    if (checkbox.getAttribute('aria-checked') !== 'true') await fireEvent.click(checkbox)
    await fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }))
  }
}

describe('Clip per-file attachment evidence (BL-1170, BL-1171, BL-1177)', () => {
  beforeEach(() => { browserStubs(); vi.mocked(confirmDialog).mockResolvedValue(true); vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })

  it('the first attached file stays in mounted clippedItems when the second attach is refused', async () => {
    const r = routes('partial'), h = await mountClips()
    const result = await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('a.txt'), file('b.txt')], context())
    await tick()
    expect(result.import.attachedIds).toEqual(['clip_a'])
    expect(result.import.staged).toBe('failed')
    expect(h.owner.getClippedItems().map(clip => clip.id)).toEqual(['clip_a'])
    expect(h.publications.at(-1)).toEqual(['clip_a'])
    expect(r.mutations.map(entry => entry.clipId)).toEqual(['clip_a', 'clip_b'])
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a 500 after persisted attachment is reconciled and shown while overall readiness stays unresolved', async () => {
    const r = routes('500_after_write'), h = await mountClips()
    const result = await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('a.txt')], context())
    await tick()
    expect(result.status).toBe('unknown_outcome')
    expect(result.import.staged).toBe('confirmed')
    expect(result.import.ready).toBe('unknown')
    expect(h.owner.getClippedItems().map(clip => clip.id)).toEqual(['clip_a'])
    expect(r.mutations).toHaveLength(1)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a successful attach followed by lost final GET preserves its known mounted attachment', async () => {
    const r = routes('lost_final'), h = await mountClips()
    const result = await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('a.txt')], context())
    await tick()
    expect(result.status).toBe('unknown_outcome')
    expect(h.owner.getClippedItems().map(clip => clip.id)).toEqual(['clip_a'])
    await openClips()
    expect(await screen.findByText('Some Clip attachment results are unresolved.')).toBeTruthy()
    expect(h.owner.getClippedItems().map(clip => clip.id)).toEqual(['clip_a'])
    r.allowReadback()
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh Clips' }))
    await waitFor(() => expect(screen.queryByText('Some Clip attachment results are unresolved.')).toBeNull())
    expect(r.mutations).toHaveLength(1)
  })

  it('a partial lost read leaves A attached and B visibly unknown; failed refresh cannot retry or claim absence', async () => {
    const r = routes('partial_unknown'), h = await mountClips()
    const result = await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('a.txt'), file('b.txt')], context())
    expect(result.import.unresolvedIds).toEqual(['clip_b'])
    await openClips()
    expect(await screen.findByText('status unknown')).toBeTruthy()
    expect(h.owner.getClippedItems().map(clip => clip.id)).toEqual(['clip_a'])
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh Clips' }))
    expect(screen.getByText('status unknown')).toBeTruthy()
    expect(r.mutations).toHaveLength(2)
    r.allowReadback()
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh Clips' }))
    await waitFor(() => expect(screen.queryByText('status unknown')).toBeNull())
    expect(h.owner.getClippedItems().map(clip => clip.id)).toEqual(['clip_a'])
  })

  it('a 500 plus lost reconciliation shows unknown and refresh restores the persisted attachment without POST', async () => {
    const r = routes('500_unknown'), h = await mountClips()
    const result = await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('a.txt')], context())
    expect(result.import.unresolvedIds).toEqual(['clip_a'])
    await openClips()
    expect(await screen.findByText('Clip attachment status is unknown')).toBeTruthy()
    expect(h.owner.getClippedItems()).toEqual([])
    r.allowReadback()
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh Clips' }))
    await waitFor(() => expect(h.owner.getClippedItems().map(clip => clip.id)).toEqual(['clip_a']))
    expect(r.mutations).toHaveLength(1)
  })

  it('switching session during upload keeps captured-session POST/read and leaves the new mounted list empty', async () => {
    const r = routes('partial'), h = await mountClips()
    let release!: () => void, entered!: () => void
    const hold = new Promise<void>(done => { release = done }), started = new Promise<void>(done => { entered = done })
    r.holdUpload(hold, entered)
    const importing = h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('a.txt')], context())
    await started
    await h.view.rerender({ ...h.props, sessionId: 'session_b' })
    release(); await importing; await tick()
    expect(r.mutations.map(entry => entry.sessionId)).toEqual(['session_a'])
    expect(h.owner.getClippedItems()).toEqual([])
    const readUrls = r.fetchMock.mock.calls.map(([input]) => String(input))
    expect(readUrls).toContain('/api/session-clips/state/session_a')
  })

  it('a lost POST followed by an early negative GET stays unknown when that original server write later commits', async () => {
    const r = routes('late_write'), h = await mountClips()
    const result = await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('a.txt')], context())
    expect(result.status).toBe('unknown_outcome')
    expect(result.import.unsettledIds).toEqual(['clip_a'])
    expect(result.import.unresolvedIds).toEqual(['clip_a'])
    await openClips()
    expect(await screen.findByText('Clip attachment status is unknown')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh Clips' })); await flush()
    expect(screen.getByText('Clip attachment status is unknown')).toBeTruthy()
    await expect(h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('b.txt')], context())).rejects.toThrow('attachment_completion_unknown')
    r.releasePendingPost()
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh Clips' }))
    await waitFor(() => expect(h.owner.getClippedItems().map(clip => clip.id)).toEqual(['clip_a']))
    expect(screen.getByText(/Refresh checks current attachments; it cannot stop that request/)).toBeTruthy()
    await h.owner.detachClipById('clip_a')
    await fireEvent.click(screen.getByRole('button', { name: 'Unclip All' }))
    expect(r.mutations).toHaveLength(1)
    expect(r.fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  })

  for (const readKind of ['explicit', 'normal'] as const) for (const newer of ['known', 'unresolved'] as const) {
    it(`an old ${readKind} read cannot erase newer ${newer} evidence in the same mounted session`, async () => {
      const r = routes('lost_final'), h = await mountClips()
      await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('a.txt')], context())
      await openClips()
      await screen.findByText('Some Clip attachment results are unresolved.')
      r.allowReadback()
      const held = deferred(), entered = deferred()
      r.holdNextRead(held.promise, entered.resolve)
      if (readKind === 'explicit') await fireEvent.click(screen.getByRole('button', { name: 'Refresh Clips' }))
      else window.dispatchEvent(new CustomEvent(LIVE_SETTINGS_EVENTS.sessionClipStateChanged, { detail: { sessionId: 'session_a' } }))
      await entered.promise
      if (newer === 'unresolved') r.failNextAttachmentRead()
      await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('b.txt')], context())
      await tick()
      expect(h.owner.getClippedItems().map(clip => clip.id)).toEqual(newer === 'known' ? ['clip_a', 'clip_b'] : ['clip_a'])
      held.resolve(); await flush()
      expect(h.owner.getClippedItems().map(clip => clip.id)).toEqual(newer === 'known' ? ['clip_a', 'clip_b'] : ['clip_a'])
      if (newer === 'unresolved') expect(screen.getByText('status unknown')).toBeTruthy()
      expect(r.mutations).toHaveLength(2)
    })
  }

  it('an old recovery response cannot reattach a Clip detached by the mounted existing owner', async () => {
    const r = routes('lost_final'), h = await mountClips()
    await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('a.txt')], context())
    await openClips(); await screen.findByText('Some Clip attachment results are unresolved.')
    r.allowReadback()
    const held = deferred(), entered = deferred()
    r.holdNextRead(held.promise, entered.resolve)
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh Clips' })); await entered.promise
    await h.owner.detachClipById('clip_a')
    held.resolve(); await flush()
    expect(h.owner.getClippedItems()).toEqual([])
    expect(r.mutations.map(entry => (entry as { action?: string }).action)).toEqual(['attach', 'detach'])
  })

  for (const kind of ['single', 'bulk'] as const) {
    it(`permanent ${kind} deletion refuses before confirmation while an imported POST is unsettled`, async () => {
      const r = routes('late_write'), h = await mountClips(true)
      await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('a.txt')], context())
      await openClips(); await screen.findByText('Clip attachment status is unknown')
      if (kind === 'single') await fireEvent.click(screen.getByRole('button', { name: 'Delete clip a.txt permanently' }))
      else {
        await fireEvent.click(screen.getByRole('button', { name: 'Bulk Delete' }))
        await fireEvent.click(screen.getByRole('button', { name: 'Select All' }))
        await fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
      }
      await flush()
      expect(confirmDialog).not.toHaveBeenCalled()
      expect(r.fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Deleting Clips could race that request'))
    })

    it(`permanent ${kind} deletion rechecks unsettled work after a held confirmation`, async () => {
      const r = routes('late_write'), h = await mountClips(true)
      // Save a Vault file without starting any attachment operation.
      await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: false }, [file('a.txt')], context())
      await openClips(); await screen.findByText('a.txt')
      let confirm!: (value: boolean) => void
      vi.mocked(confirmDialog).mockReturnValue(new Promise<boolean>(done => { confirm = done }))
      if (kind === 'single') await fireEvent.click(screen.getByRole('button', { name: 'Delete clip a.txt permanently' }))
      else {
        await fireEvent.click(screen.getByRole('button', { name: 'Bulk Delete' }))
        await fireEvent.click(screen.getByRole('button', { name: 'Select All' }))
        await fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
      }
      expect(confirmDialog).toHaveBeenCalledTimes(1)
      await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('b.txt')], context())
      confirm(true); await flush()
      expect(r.fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Deleting Clips could race that request'))
    })
  }

  for (const kind of ['single', 'bulk'] as const) {
    it(`permanent ${kind} deletion refuses while the imported attachment response is still pending`, async () => {
      const r = routes('lost_final'), h = await mountClips(true)
      r.allowReadback()
      await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: false }, [file('a.txt')], context())
      await openClips(); await screen.findByText('a.txt')
      let confirm!: (value: boolean) => void
      if (kind === 'bulk') {
        vi.mocked(confirmDialog).mockReturnValue(new Promise<boolean>(done => { confirm = done }))
        await fireEvent.click(screen.getByRole('button', { name: 'Bulk Delete' }))
        await fireEvent.click(screen.getByRole('button', { name: 'Select All' }))
        await fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
        expect(confirmDialog).toHaveBeenCalledTimes(1)
      }
      const held = deferred(), entered = deferred()
      r.holdNextAttachment(held.promise, entered.resolve)
      const importing = h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('b.txt')], context())
      await entered.promise
      if (kind === 'single') await fireEvent.click(screen.getByRole('button', { name: 'Delete clip a.txt permanently' }))
      else confirm(true)
      await flush()
      expect(confirmDialog).toHaveBeenCalledTimes(kind === 'single' ? 0 : 1)
      expect(r.fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Deleting Clips could race that request'))
      expect(r.mutations).toHaveLength(1)
      held.resolve()
      expect((await importing).status).toBe('completed')
      expect(h.owner.getClippedItems().map(clip => clip.id)).toEqual(['clip_b'])
    })
  }

  for (const kind of ['single', 'bulk'] as const) for (const nextSession of ['session_b', null]) for (const completion of ['pending', 'lost'] as const) {
    it(`BL-1193 ${kind} deletion after A→${nextSession ?? 'null'} refuses the remembered A ${completion} whole-state write`, async () => {
      const r = routes(completion === 'pending' ? 'held_snapshot' : 'late_write'), h = await mountClips(true)
      await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: false }, [file('x.txt')], context())
      // X is in the old whole-state snapshot; the imported attachment adds Y.
      r.attached.set('session_a', ['clip_a'])
      const held = deferred(), entered = deferred()
      if (completion === 'pending') r.holdNextAttachment(held.promise, entered.resolve)
      const importing = h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('y.txt')], context())
      if (completion === 'pending') await entered.promise
      else {
        const result = await importing
        expect(result.status).toBe('unknown_outcome')
        expect(result.import.unsettledIds).toEqual(['clip_b'])
      }
      await h.view.rerender({ ...h.props, sessionId: nextSession }); await flush()
      await openClips(); await screen.findByText('x.txt')
      await requestPermanentXDelete(kind); await flush()
      expect(confirmDialog).not.toHaveBeenCalled()
      expect(r.fetchMock.mock.calls.some(([url, init]) => init?.method === 'DELETE' && String(url).startsWith('/api/clips'))).toBe(false)
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('this or another chat'))
      expect(r.mutations).toHaveLength(1)
      if (completion === 'lost') {
        r.releasePendingPost()
        await h.view.rerender({ ...h.props, sessionId: 'session_a' }); await flush()
        await fireEvent.click(screen.getByRole('button', { name: 'Refresh Clips' }))
        await waitFor(() => expect(h.owner.getClippedItems().map(clip => clip.id)).toEqual(['clip_a', 'clip_b']))
        expect(screen.getByText(/Refresh checks current attachments; it cannot stop that request/)).toBeTruthy()
        await h.view.rerender({ ...h.props, sessionId: nextSession }); await flush()
        await requestPermanentXDelete(kind); await flush()
        expect(confirmDialog).not.toHaveBeenCalled()
        expect(r.fetchMock.mock.calls.some(([url, init]) => init?.method === 'DELETE' && String(url).startsWith('/api/clips'))).toBe(false)
      } else {
        held.resolve()
        expect((await importing).status).toBe('completed')
        await flush()
        await requestPermanentXDelete(kind)
        await waitFor(() => expect(r.saved.has('clip_a')).toBe(false))
        expect(confirmDialog).toHaveBeenCalledTimes(1)
        expect(r.attached.get('session_a')).toEqual(['clip_b'])
      }
      expect(r.mutations).toHaveLength(1)
    })
  }

  for (const kind of ['single', 'bulk'] as const) for (const completion of ['pending', 'lost'] as const) {
    it(`BL-1193 held ${kind} B confirmation refuses an A ${completion} attachment after returning to B`, async () => {
      const r = routes(completion === 'pending' ? 'held_snapshot' : 'late_write'), h = await mountClips(true)
      await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: false }, [file('x.txt')], context())
      r.attached.set('session_a', ['clip_a'])
      await h.view.rerender({ ...h.props, sessionId: 'session_b' }); await flush()
      await openClips(); await screen.findByText('x.txt')
      let confirm!: (value: boolean) => void
      vi.mocked(confirmDialog).mockReturnValue(new Promise<boolean>(done => { confirm = done }))
      await requestPermanentXDelete(kind)
      expect(confirmDialog).toHaveBeenCalledTimes(1)
      await h.view.rerender({ ...h.props, sessionId: 'session_a' }); await flush()
      const held = deferred(), entered = deferred()
      if (completion === 'pending') r.holdNextAttachment(held.promise, entered.resolve)
      const importing = h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('y.txt')], context())
      if (completion === 'pending') await entered.promise
      else await importing
      await h.view.rerender({ ...h.props, sessionId: 'session_b' }); await flush()
      confirm(true); await flush()
      expect(r.fetchMock.mock.calls.some(([url, init]) => init?.method === 'DELETE' && String(url).startsWith('/api/clips'))).toBe(false)
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('this or another chat'))
      expect(r.mutations).toHaveLength(1)
      if (completion === 'pending') { held.resolve(); await importing }
      else r.releasePendingPost()
      expect(r.attached.get('session_a')).toEqual(['clip_a', 'clip_b'])
    })
  }

  it('a failed fresh settings read refuses the mounted upload effect', async () => {
    const r = routes('settings_fail'), h = await mountClips()
    const result = await h.owner.importAppActionFiles({ sessionId: 'session_a', attach: true }, [file('a.txt')], context())
    expect(result.reason).toBe('clip_settings_unconfirmed')
    expect(r.fetchMock.mock.calls.some(([input]) => String(input) === '/api/uploads/clips')).toBe(false)
    expect(r.mutations).toEqual([])
  })
})
