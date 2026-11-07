import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomaticBackupView } from '$lib/types/automaticBackup'
import AdminAutomaticBackupSettings from './AdminAutomaticBackupSettings.svelte'

// Mounted human settings owner only. HTTP is the boundary double; disk/scheduler proof is separate.
function view(overrides: Partial<AutomaticBackupView> = {}): AutomaticBackupView {
  return {
    config: { revision: 'revision-1', ownerUserId: 'human', enabled: false, cadence: 'daily', folder: null, afterUpdates: false, enabledAt: null },
    defaultFolder: '/persistent/Batshit/backups',
    startup: { ready: true, buildId: 'build-1', dataGeneration: 'migration-1' },
    running: false, lastSuccess: null, retainedCount: 0, nextDueAt: null,
    lastAttemptAt: null, error: null, cleanupFailures: [], preservedFolders: [], preservedFiles: [], unavailableCopies: [],
    ...overrides
  }
}
function reply(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(payload) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}
function install(initial = view()) {
  const state = { current: initial }
  const writes: Array<Record<string, any>> = []
  const get = vi.fn(async () => reply(state.current))
  const put = vi.fn(async (body: Record<string, any>) => {
    state.current = view({ ...state.current, config: { ...state.current.config, ...body, revision: 'revision-2' } })
    return reply(state.current)
  })
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('/api/admin/backup/automatic')
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      writes.push(body)
      return put(body)
    }
    return get()
  })
  vi.stubGlobal('fetch', fetchMock)
  return { state, writes, get, put, fetchMock }
}
async function ready() {
  render(AdminAutomaticBackupSettings)
  await screen.findByRole('switch', { name: 'Enable Automatic Backups' })
}
async function focusRefresh() { await fireEvent(window, new Event('focus')) }
const folder = () => screen.getByLabelText('Backup Folder') as HTMLInputElement
const cadence = () => screen.getByLabelText('Backup Schedule')
async function chooseCadence(label: 'Daily' | 'Weekly') {
  await fireEvent.keyDown(cadence(), { key: 'ArrowDown' })
  await fireEvent.pointerUp(await screen.findByRole('option', { name: label }), { pointerType: 'mouse' })
}
const enable = () => screen.getByRole('switch', { name: 'Enable Automatic Backups' })
const save = () => screen.getByRole('button', { name: 'Save Settings' })

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Automatic backup settings', () => {
  it.each([false, true])('a failed or malformed initial read hides controls and cannot write (%s)', async (malformed) => {
    const { get, writes } = install()
    get.mockResolvedValueOnce(malformed ? reply({}) : reply({ error: 'Saved configuration unavailable.' }, 500))
    render(AdminAutomaticBackupSettings)
    await screen.findByRole('button', { name: 'Retry Automatic Backup Read' })
    expect(screen.queryByRole('switch', { name: 'Enable Automatic Backups' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save Settings' })).toBeNull()
    expect(writes).toHaveLength(0)
    await fireEvent.click(screen.getByRole('button', { name: 'Retry Automatic Backup Read' }))
    expect(await screen.findByRole('switch', { name: 'Enable Automatic Backups' })).toHaveAttribute('aria-checked', 'false')
    expect(writes).toHaveLength(0)
  })

  it('requires an explicit save for enable, cadence, folder and update consent, using the loaded revision', async () => {
    const { writes } = install()
    await ready()
    expect(enable()).toHaveAttribute('aria-checked', 'false')
    expect(cadence()).toHaveTextContent('Daily')
    expect(folder().value).toBe('')
    expect(screen.getByRole('switch', { name: 'Back up After Successful App Updates' })).toHaveAttribute('aria-checked', 'false')
    await fireEvent.click(enable())
    await chooseCadence('Weekly')
    await fireEvent.input(folder(), { target: { value: '/archive/chosen' } })
    await fireEvent.click(screen.getByRole('switch', { name: 'Back up After Successful App Updates' }))
    expect(writes).toHaveLength(0)
    await fireEvent.click(save())
    await screen.findByText('Automatic backup settings saved.')
    expect(writes).toEqual([{ expectedRevision: 'revision-1', enabled: true, cadence: 'weekly', folder: '/archive/chosen', afterUpdates: true }])
    expect(save()).toBeDisabled()
  })

  it('Use Default changes only the draft and saves null, rather than a guessed default path', async () => {
    const { writes } = install(view({ config: { ...view().config, folder: '/archive/previous' } }))
    await ready()
    await fireEvent.click(screen.getByRole('button', { name: 'Use Default' }))
    expect(folder().value).toBe('')
    expect(writes).toHaveLength(0)
    await fireEvent.click(save())
    await screen.findByText('Automatic backup settings saved.')
    expect(writes[0].folder).toBeNull()
  })

  it('acknowledges the server-resolved folder without leaving the submitted draft dirty', async () => {
    const { put, writes } = install()
    put.mockResolvedValueOnce(reply(view({ config: { ...view().config, revision: 'resolved-revision', enabled: true, folder: '/private/archive/real' } })))
    await ready()
    await fireEvent.click(enable())
    await fireEvent.input(folder(), { target: { value: '/archive/link/../real' } })
    await fireEvent.click(save())
    await screen.findByText('Automatic backup settings saved.')
    expect(writes[0].folder).toBe('/archive/link/../real')
    expect(folder().value).toBe('/private/archive/real')
    expect(save()).toBeDisabled()
  })

  it('refreshes status while keeping a dirty destination and its original revision', async () => {
    const { state, writes, get } = install()
    await ready()
    await fireEvent.input(folder(), { target: { value: '/archive/my-draft' } })
    state.current = view({
      config: { ...view().config, revision: 'someone-else', cadence: 'weekly', folder: '/archive/theirs' },
      retainedCount: 1, lastSuccess: { createdAt: '2026-10-23T15:00:00Z', path: '/archive/theirs/verified.zip', bytes: 1024 }
    })
    await focusRefresh()
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/One copy is available until the next successful backup/)).toBeTruthy()
    expect(folder().value).toBe('/archive/my-draft')
    expect(cadence()).toHaveTextContent('Daily')
    expect(writes).toHaveLength(0)
    await fireEvent.click(save())
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ expectedRevision: 'revision-1', folder: '/archive/my-draft', cadence: 'daily' })
  })

  it('a conflict retains the draft across polls until explicit Load Saved Settings replaces it', async () => {
    const { state, put, writes, get } = install()
    put.mockResolvedValueOnce(reply({ error: 'Settings changed elsewhere.', code: 'automatic_backup_refused' }, 409))
    await ready()
    await fireEvent.input(folder(), { target: { value: '/archive/my-draft' } })
    await fireEvent.click(save())
    await screen.findByText('Settings changed elsewhere.')
    state.current = view({ config: { ...view().config, revision: 'revision-new', cadence: 'weekly', folder: '/archive/saved' } })
    await focusRefresh()
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    expect(folder().value).toBe('/archive/my-draft')
    expect(save()).toBeDisabled()
    expect(writes).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Load Saved Settings' }))
    await screen.findByText('Saved settings loaded.')
    expect(folder().value).toBe('/archive/saved')
    expect(cadence()).toHaveTextContent('Weekly')
    await fireEvent.click(enable())
    await fireEvent.click(save())
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1].expectedRevision).toBe('revision-new')
  })

  it.each(['transport', 'malformed', 'server'] as const)('an unknown %s save never retries or rebases on a poll, and recovery preserves the unknown notice', async (failure) => {
    const { put, state, get, writes } = install()
    if (failure === 'transport') put.mockRejectedValueOnce(new Error('Connection lost.'))
    else put.mockResolvedValueOnce(failure === 'malformed' ? reply({}) : reply({ error: 'Could not confirm save.' }, 500))
    await ready()
    await fireEvent.input(folder(), { target: { value: '/archive/unknown' } })
    await fireEvent.click(save())
    await screen.findByText(/A settings save has an unknown outcome/)
    state.current = view({ config: { ...view().config, revision: 'revision-new', folder: '/archive/current' } })
    await focusRefresh()
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    expect(folder().value).toBe('/archive/unknown')
    expect(save()).toBeDisabled()
    expect(writes).toHaveLength(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Load Saved Settings' }))
    await screen.findByText('Saved settings loaded.')
    expect(folder().value).toBe('/archive/current')
    expect(screen.getByText(/does not confirm that earlier save/)).toBeTruthy()
    expect(writes).toHaveLength(1)
  })

  it('ignores an older poll answer that arrives after a confirmed save', async () => {
    const { get, writes } = install()
    await ready()
    const held = deferred<ReturnType<typeof reply>>()
    get.mockImplementationOnce(() => held.promise)
    await focusRefresh()
    await fireEvent.click(enable())
    await fireEvent.click(save())
    await screen.findByText('Automatic backup settings saved.')
    held.resolve(reply(view()))
    await waitFor(() => expect(enable()).toHaveAttribute('aria-checked', 'true'))
    await chooseCadence('Weekly')
    await fireEvent.click(save())
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]).toMatchObject({ expectedRevision: 'revision-2', enabled: true, cadence: 'weekly' })
  })

  it('shows bounded startup, cleanup and old-folder state and disables controls during a running backup', async () => {
    const { state, get } = install(view({
      running: true, startup: { ready: false, buildId: 'build-1', dataGeneration: '', error: 'Migration unfinished.' },
      error: 'Destination unavailable.', cleanupFailures: [{ path: '/archive/old.zip', message: 'Identity changed.' }],
      preservedFolders: [{ folder: '/old-folder', backupCount: 2 }],
      preservedFiles: [{ path: '/archive/recovered.zip', originalPath: '/archive/new.zip', message: 'Interrupted publication retained.' }],
      unavailableCopies: [{ path: '/archive/missing.zip', state: 'missing', message: 'The original copy is no longer present.' }]
    }))
    await ready()
    expect(enable()).toBeDisabled()
    expect(folder()).toBeDisabled()
    expect(await screen.findByText(/Backup file needs attention: \/archive\/old.zip/)).toBeTruthy()
    expect(screen.getByText(/Backup unavailable \(missing\): \/archive\/missing.zip/)).toBeTruthy()
    expect(screen.getByText(/Old folder preserved: \/old-folder/)).toBeTruthy()
    expect(screen.getByText(/File preserved: \/archive\/recovered.zip/)).toBeTruthy()
    state.current = view({ startup: { ready: false, buildId: 'build-1', dataGeneration: '', error: 'Migration unfinished.' } })
    await focusRefresh()
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/Automatic backups are waiting for successful startup checks. Migration unfinished./)).toBeTruthy()
    expect(enable()).not.toBeDisabled()
  })

  it('refreshes every 30 seconds and releases its interval and focus listener on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { state, get } = install()
    const mounted = render(AdminAutomaticBackupSettings)
    await screen.findByRole('switch', { name: 'Enable Automatic Backups' })
    state.current = view({ config: { ...view().config, revision: 'revision-new', cadence: 'weekly' } })
    await vi.advanceTimersByTimeAsync(30_000)
    await waitFor(() => expect(cadence()).toHaveTextContent('Weekly'))
    expect(get).toHaveBeenCalledTimes(2)
    mounted.unmount()
    await vi.advanceTimersByTimeAsync(30_000)
    await focusRefresh()
    expect(get).toHaveBeenCalledTimes(2)
  })
})
