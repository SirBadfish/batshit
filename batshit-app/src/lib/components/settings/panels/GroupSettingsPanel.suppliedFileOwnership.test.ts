import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GroupSettingsPanel from './GroupSettingsPanel.svelte'
import { confirmDialog } from '$lib/stores/confirmDialog'
import { toast } from '$lib/components/ui/sonner/settings-toast'
import * as groupStore from '$lib/stores/groups.svelte'
import { appActionsHaveDrafts, type ActionContext } from '$lib/appActions/owners'
import type { ImportOutcome } from '$lib/appActions/imports/contracts'

// Authored V2 mounted regressions. Execution is held by the SA-122 coordinator.
// Real panel, real GroupService (PUT returns {success:true}, detail GET returns the record),
// real 650 ms queue and Svelte lifetime. No server, native helper or real user data.
vi.mock('$lib/stores/confirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }))
vi.mock('$lib/components/ui/sonner/settings-toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}
function browserStubs() {
  if (!Element.prototype.animate) Object.defineProperty(Element.prototype, 'animate', {
    configurable: true, value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null })
  })
  if (!globalThis.ResizeObserver) vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
}
function routes() {
  const records = new Map(['a', 'b'].map(suffix => [`group_${suffix}`, {
    id: `group_${suffix}`, user_id: 'test_user', name: `Group ${suffix.toUpperCase()}`, avatar_url: `/old_${suffix}.jpg`,
    agent_ids: [], agent_settings: {}, group_system_prompt: '', max_followups_total: 5, max_agents: 4,
    driver_mode: false, driver_agent_id: null, shared_tools: []
  }]))
  const puts: Array<{ id: string; payload: Record<string, unknown> }> = [], deletes: string[] = []
  let holdPut: Promise<void> | undefined, holdDelete: Promise<void> | undefined, holdRead: Promise<void> | undefined, readEntered: (() => void) | undefined, failRead = false
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    if (url === '/api/groups' && method === 'GET') return json({ groups: [...records.values()].map(record => structuredClone(record)) })
    if (url === '/api/uploads/avatar' && method === 'POST') {
      expect((init.body as FormData).get('entityId')).toBe('group_a')
      return json({ url: '/new_a.jpg' })
    }
    const id = /^\/api\/groups\/(group_[ab])$/.exec(url)?.[1]
    if (id && method === 'PUT') {
      const payload = JSON.parse(String(init.body))
      puts.push({ id, payload })
      if (holdPut) await holdPut
      records.set(id, { ...records.get(id)!, ...payload })
      return json({ success: true })
    }
    if (id && method === 'GET') {
      if (failRead) return json({ error: 'Read unavailable' }, 503)
      const saved = records.has(id) ? structuredClone(records.get(id)) : null
      readEntered?.()
      if (holdRead) await holdRead
      return saved ? json(saved) : json({ error: 'Group not found' }, 404)
    }
    if (id && method === 'DELETE') {
      deletes.push(id)
      if (holdDelete) await holdDelete
      records.delete(id)
      return json({ success: true, clearedSessionIds: [] })
    }
    if (url.startsWith('/api/agents') && method === 'GET') return json([])
    if (method === 'GET') return json({})
    throw new Error(`Unhandled ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { records, puts, deletes, fetchMock, setHoldPut: (hold: Promise<void>) => { holdPut = hold },
    setHoldRead: (hold: Promise<void>, entered: () => void) => { holdRead = hold; readEntered = entered },
    setHoldDelete: (hold: Promise<void>) => { holdDelete = hold }, failSavedRead: () => { failRead = true } }
}
async function mountPanel() {
  const view = render(GroupSettingsPanel, { props: { data: { user: { id: 'test_user' } } } })
  await screen.findByDisplayValue('Group A')
  await tick()
  vi.useFakeTimers()
  return view
}
async function pick(view: ReturnType<typeof render>, groupId: string) {
  const row = [...view.container.querySelectorAll<HTMLButtonElement>('.settings-sidebar-item')]
    .find(button => button.dataset.groupId === groupId)
  if (!row) throw new Error(`Missing Group row ${groupId}`)
  await fireEvent.click(row)
  await tick()
}
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await tick() } }
async function requestDelete(view: ReturnType<typeof render>) {
  const trigger = view.container.querySelector<HTMLButtonElement>('.batshit-settings-delete-trigger')!
  if (trigger.getAttribute('aria-expanded') !== 'true') await fireEvent.click(trigger)
  await fireEvent.click(view.container.querySelector<HTMLButtonElement>('.batshit-settings-delete-action')!)
  await flush()
}
function actionContext(): ActionContext {
  return { sessionId: null, signal: new AbortController().signal, check() {}, effect() {}, report() {},
    async wait<T>(read: () => T | undefined) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const value = read()
        if (value !== undefined) return value
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error('Timed out confirming Group save')
    } }
}

describe('Group supplied-file and delete ownership (BL-579, BL-1179)', () => {
  beforeEach(() => { browserStubs(); vi.mocked(confirmDialog).mockResolvedValue(true); vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); groupStore.setGroups([]); vi.clearAllMocks() })

  it('stages supplied A avatar, picks B before debounce, saves/readbacks A and keeps B form', async () => {
    const r = routes(), view = await mountPanel()
    const owner = view.component as unknown as { importAppActionAvatar: (args: unknown, files: File[], context: ActionContext) => Promise<ImportOutcome> }
    const importing = owner.importAppActionAvatar({ entityType: 'group', entityId: 'group_a' },
      [new File(['image bytes'], 'avatar.png', { type: 'image/png' })], actionContext())
    await flush()
    await pick(view, 'group_b')
    // Consume the import's target-change refusal; the actual queued human saver still owns A.
    await vi.advanceTimersByTimeAsync(650)
    await importing
    expect(r.puts.map(write => write.id)).toEqual(['group_a'])
    expect(r.records.get('group_a')?.avatar_url).toBe('/new_a.jpg')
    expect((screen.getByLabelText('Group Name') as HTMLInputElement).value).toBe('Group B')
    expect(groupStore.getGroupById('group_b')?.avatar_url).toBe('/old_b.jpg')
  })

  it('a held A save cannot replace B or a later A draft, and later A saves after the first readback', async () => {
    const r = routes(), hold = deferred<void>(), view = await mountPanel()
    r.setHoldPut(hold.promise)
    await fireEvent.input(screen.getByLabelText('Group Name'), { target: { value: 'First A' } })
    await vi.advanceTimersByTimeAsync(650)
    expect(r.puts).toHaveLength(1)
    await fireEvent.input(screen.getByLabelText('Group Name'), { target: { value: 'Later A' } })
    await pick(view, 'group_b')
    hold.resolve(); await flush()
    expect((screen.getByLabelText('Group Name') as HTMLInputElement).value).toBe('Group B')
    await pick(view, 'group_a')
    expect((screen.getByLabelText('Group Name') as HTMLInputElement).value).toBe('Later A')
    await vi.advanceTimersByTimeAsync(650)
    expect(r.puts.map(write => [write.id, write.payload.name])).toEqual([['group_a', 'First A'], ['group_a', 'Later A']])
  })

  it('a lost save GET keeps the draft visibly unsaved and never retries the PUT', async () => {
    const r = routes(), view = await mountPanel()
    r.failSavedRead()
    await fireEvent.input(screen.getByLabelText('Group Name'), { target: { value: 'Unconfirmed A' } })
    await vi.advanceTimersByTimeAsync(650)
    expect(view.container.textContent).toContain('The Group save could not be confirmed')
    expect((screen.getByLabelText('Group Name') as HTMLInputElement).value).toBe('Unconfirmed A')
    await vi.advanceTimersByTimeAsync(5000)
    expect(r.puts).toHaveLength(1)
    expect(groupStore.getGroupById('group_a')?.name).toBe('Group A')
  })

  it('a newer list read supersedes an older response without replacing the owned draft', async () => {
    const r = routes(), hold = deferred<void>(), view = await mountPanel()
    r.setHoldPut(hold.promise)
    await fireEvent.input(screen.getByLabelText('Group Name'), { target: { value: 'Draft A' } })
    await vi.advanceTimersByTimeAsync(650)
    await fireEvent.click(screen.getAllByRole('button', { name: /^Refresh$/ })[0])
    await flush()
    hold.resolve(); await flush()
    expect((screen.getByLabelText('Group Name') as HTMLInputElement).value).toBe('Draft A')
    expect(groupStore.getGroupById('group_a')?.name).toBe('Group A')
    expect(r.puts).toHaveLength(1)
  })

  it('an authoritative matching list read clears the draft after the old detail flight settles, with no extra PUT', async () => {
    const r = routes(), held = deferred<void>(), entered = deferred<void>(), view = await mountPanel()
    r.setHoldRead(held.promise, () => entered.resolve())
    const owner = view.component as unknown as { suppliedAvatarAvailability(args: unknown): string }
    await fireEvent.input(screen.getByLabelText('Group Name'), { target: { value: 'Saved A' } })
    await vi.advanceTimersByTimeAsync(650)
    await entered.promise
    // An equal queued edit must be retired by the authoritative matching read.
    await fireEvent.input(screen.getByLabelText('Group Name'), { target: { value: 'Saved A' } })
    await fireEvent.click(screen.getAllByRole('button', { name: /^Refresh$/ })[0])
    await flush()
    expect(appActionsHaveDrafts()).toBe(true) // The actual flight is still admitted.
    held.resolve(); await flush()
    expect(appActionsHaveDrafts()).toBe(false)
    expect(owner.suppliedAvatarAvailability({ entityType: 'group', entityId: 'group_a' })).toBe('available')
    await vi.advanceTimersByTimeAsync(5000)
    await fireEvent.click(screen.getAllByRole('button', { name: /^Refresh$/ })[0])
    await flush()
    expect(r.puts).toHaveLength(1)
    expect(appActionsHaveDrafts()).toBe(false)
  })

  it('a differing newer draft survives the matching older flight and stale queued writes are refused', async () => {
    const r = routes(), held = deferred<void>(), entered = deferred<void>(), view = await mountPanel()
    r.setHoldRead(held.promise, () => entered.resolve())
    const owner = view.component as unknown as { suppliedAvatarAvailability(args: unknown): string }
    await fireEvent.input(screen.getByLabelText('Group Name'), { target: { value: 'First saved A' } })
    await vi.advanceTimersByTimeAsync(650); await entered.promise
    await fireEvent.input(screen.getByLabelText('Group Name'), { target: { value: 'Newer draft A' } })
    await fireEvent.click(screen.getAllByRole('button', { name: /^Refresh$/ })[0]); await flush()
    held.resolve(); await flush(); await vi.advanceTimersByTimeAsync(650)
    expect((screen.getByLabelText('Group Name') as HTMLInputElement).value).toBe('Newer draft A')
    expect(r.puts).toHaveLength(1)
    expect(appActionsHaveDrafts()).toBe(true)
    expect(owner.suppliedAvatarAvailability({ entityType: 'group', entityId: 'group_a' })).toBe('unsaved_changes')
    expect(view.container.textContent).toContain('refreshed before this save started')
  })

  it('a later authoritative matching refresh recovers a settled unknown save and its error', async () => {
    const r = routes(), view = await mountPanel()
    r.failSavedRead()
    await fireEvent.input(screen.getByLabelText('Group Name'), { target: { value: 'Confirmed by list A' } })
    await vi.advanceTimersByTimeAsync(650)
    expect(appActionsHaveDrafts()).toBe(true)
    await fireEvent.click(screen.getAllByRole('button', { name: /^Refresh$/ })[0]); await flush()
    expect(appActionsHaveDrafts()).toBe(false)
    expect(view.container.textContent).not.toContain('The Group save could not be confirmed')
    expect(r.puts).toHaveLength(1)
  })

  it('teardown cancels an unstarted queue with a visible unsaved notice and no PUT', async () => {
    const r = routes(), view = await mountPanel()
    await fireEvent.input(screen.getByLabelText('Group Name'), { target: { value: 'Not saved' } })
    view.unmount()
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.puts).toHaveLength(0)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('closed before queued changes were saved'))
  })

  it('changing selection during confirmation refuses DELETE', async () => {
    const r = routes(), answer = deferred<boolean>(), view = await mountPanel()
    vi.mocked(confirmDialog).mockReturnValue(answer.promise)
    await requestDelete(view)
    await pick(view, 'group_b')
    answer.resolve(true); await flush()
    expect(r.deletes).toEqual([])
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('selected Group changed'))
  })

  it('a queued draft or actual in-flight save refuses delete without canceling the save', async () => {
    const r = routes(), hold = deferred<void>(), view = await mountPanel()
    r.setHoldPut(hold.promise)
    await fireEvent.input(screen.getByLabelText('Group Name'), { target: { value: 'Queued A' } })
    await requestDelete(view)
    expect(r.deletes).toEqual([])
    await vi.advanceTimersByTimeAsync(650)
    await requestDelete(view)
    expect(r.deletes).toEqual([])
    expect(r.puts).toHaveLength(1)
    hold.resolve(); await flush()
    expect(r.records.get('group_a')?.name).toBe('Queued A')
  })

  it('a DELETE response removes captured A and preserves a newly selected B draft', async () => {
    const r = routes(), hold = deferred<void>(), view = await mountPanel()
    r.setHoldDelete(hold.promise)
    await requestDelete(view)
    expect(r.deletes).toEqual(['group_a'])
    await pick(view, 'group_b')
    await fireEvent.input(screen.getByLabelText('Group Name'), { target: { value: 'B draft' } })
    hold.resolve(); await flush()
    expect(groupStore.getGroupById('group_a')).toBeNull()
    expect((screen.getByLabelText('Group Name') as HTMLInputElement).value).toBe('B draft')
    await vi.advanceTimersByTimeAsync(650)
    expect(r.puts.map(write => write.id)).toEqual(['group_b'])
  })

  it('teardown during confirmation prevents DELETE; teardown during DELETE still removes captured cache only', async () => {
    const r = routes(), answer = deferred<boolean>(), view = await mountPanel()
    vi.mocked(confirmDialog).mockReturnValue(answer.promise)
    await requestDelete(view)
    view.unmount(); answer.resolve(true); await flush()
    expect(r.deletes).toEqual([])
    vi.useRealTimers()
    vi.mocked(confirmDialog).mockResolvedValue(true)
    const second = await mountPanel(), hold = deferred<void>()
    r.setHoldDelete(hold.promise)
    await requestDelete(second)
    second.unmount(); hold.resolve(); await flush()
    expect(r.deletes).toEqual(['group_a'])
    expect(groupStore.getGroupById('group_a')).toBeNull()
    expect(groupStore.getGroupById('group_b')?.name).toBe('Group B')
  })
})
