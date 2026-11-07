import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PortableAppActionsGrant from './PortableAppActionsGrant.svelte'
import { defaultAppActionsPolicy, type AppActionsPortableGrantResponse } from '$lib/appActions/settings/managementContract'
const live = vi.hoisted(() => ({ hear: null as null | ((event: any) => void) }))
vi.mock('$lib/services/userChannel', () => ({ onUserChannelEvent: (hear: (event: any) => void) => { live.hear = hear; return () => { live.hear = null } } }))

function fixture(): AppActionsPortableGrantResponse {
  return { success: true, tokenId: 'pst_owned', authorityGeneration: 4, grant: null,
    subjects: [{ subject: { kind: 'primary', id: 'chosen' }, label: 'Chosen Agent', type: 'api', available: true }] }
}
function reply(payload: unknown, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }) }
function install() {
  const state = { payload: fixture(), status: 200 }
  const writes: any[] = []
  const write = vi.fn(async (body: any) => { state.payload = { ...state.payload, grant: body.grant, authorityGeneration: state.payload.authorityGeneration + 1 }; return reply(state.payload) })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'PUT') return reply(state.payload, state.status)
    const body = JSON.parse(String(init.body)); writes.push({ path: String(input), method: init.method, body }); return write(body)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { state, writes, write, fetchMock }
}
async function ready(onSaved = vi.fn()) {
  render(PortableAppActionsGrant, { props: { tokenId: 'pst_owned', onSaved } })
  await screen.findByRole('switch', { name: 'Enable App Actions' })
  return onSaved
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('portable App Actions grant editor', () => {
  it('loads without writing, defaults to 24 hours and has no invented self scope', async () => {
    const { writes } = install(); const before = Date.now(); await ready()
    const expiry = new Date((screen.getByLabelText('App Actions Expiry') as HTMLInputElement).value).getTime()
    expect(expiry - before).toBeGreaterThan(23.9 * 60 * 60 * 1000)
    expect(expiry - before).toBeLessThan(24.1 * 60 * 60 * 1000)
    expect(screen.getByRole('button', { name: 'App Actions subjects' }).textContent).toContain('Chosen agents')
    await fireEvent.click(screen.getByRole('button', { name: 'App Actions subjects' }))
    expect(screen.queryByRole('option', { name: 'This agent', exact: true })).toBeNull()
    expect(writes).toEqual([])
  })
  it('saves one explicit grant with typed subjects and generation, never a preliminary family PATCH', async () => {
    const { writes } = install(); const onSaved = await ready()
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    await fireEvent.click(screen.getByRole('switch', { name: 'Include Chosen Agent (primary:chosen)' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save Portable App Actions Access' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ path: '/api/portable-skills/tokens/pst_owned/app-actions-grant', method: 'PUT', body: {
      expectedAuthorityGeneration: 4, grant: { policy: { ...defaultAppActionsPolicy(true), enabled: true, scope: { mode: 'selected', subjects: [{ kind: 'primary', id: 'chosen' }], except: [] } } }
    } })
    expect(Object.keys(writes[0].body).sort()).toEqual(['expectedAuthorityGeneration', 'grant'])
    expect(onSaved).toHaveBeenCalledTimes(1)
  })
  it.each(['2020-01-01T01:00', '2099-01-01T01:00'])('refuses an invalid lifetime %s without a write', async expires => {
    const { writes } = install(); await ready()
    await fireEvent.input(screen.getByLabelText('App Actions Expiry'), { target: { value: expires } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save Portable App Actions Access' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(writes).toEqual([])
  })
  it('removes only the App Actions grant through its current authority generation', async () => {
    const { state, writes } = install(); state.payload.grant = { policy: defaultAppActionsPolicy(true), expiresAt: new Date(Date.now() + 3600000).toISOString() }
    await ready()
    await fireEvent.click(screen.getByRole('button', { name: 'Remove App Actions Access' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body).toEqual({ expectedAuthorityGeneration: 4, grant: null })
    expect(await screen.findByText('App Actions access removed. Other token families are unchanged.')).toBeTruthy()
  })
  it('preserves the exact saved expiry when only permission changes', async () => {
    const { state, writes } = install()
    const exactExpiry = new Date(Date.now() + 3601234).toISOString()
    state.payload.grant = { policy: defaultAppActionsPolicy(true), expiresAt: exactExpiry }
    await ready()
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save Portable App Actions Access' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body.grant.expiresAt).toBe(exactExpiry)
  })
  it('preserves a dirty draft when matching token authority changes in another mounted consumer', async () => {
    const { state, writes } = install(); await ready()
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    state.payload = { ...state.payload, authorityGeneration: 9 }
    live.hear?.({ type: 'portable_skill_authority_changed', tokenId: 'pst_owned', authorityGeneration: 9 })
    expect(await screen.findByText('This token changed. Your draft is kept. Review its saved access before saving.')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Enable App Actions' }).getAttribute('aria-checked')).toBe('true')
    expect(writes).toEqual([])
  })
  it('uses remotely saved access after a dirty refresh with its exact generation and expiry, without autosaving', async () => {
    const { state, writes } = install(); await ready()
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    const exactExpiry = new Date(Date.now() + 3601234).toISOString()
    const remotePolicy = { ...defaultAppActionsPolicy(true), ordinaryChanges: false }
    state.payload = { ...state.payload, authorityGeneration: 12, grant: { policy: remotePolicy, expiresAt: exactExpiry } }
    live.hear?.({ type: 'portable_skill_authority_changed', tokenId: 'pst_owned', authorityGeneration: 12 })
    await screen.findByText('This token changed. Your draft is kept. Review its saved access before saving.')
    ;(screen.getByText('Review Saved Access').parentElement as HTMLDetailsElement).open = true
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Access' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable App Actions' }).getAttribute('aria-checked')).toBe('false'))
    expect(screen.getByRole('switch', { name: 'Ordinary Settings Changes' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText('Review Saved Access')).toBeNull()
    expect(screen.queryByText('This token changed. Your draft is kept. Review its saved access before saving.')).toBeNull()
    expect((screen.getByRole('button', { name: 'Save Portable App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
    expect(writes).toEqual([])
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save Portable App Actions Access' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body).toEqual({ expectedAuthorityGeneration: 12, grant: { policy: { ...remotePolicy, enabled: true }, expiresAt: exactExpiry } })
  })
  it('retains a draft after 409 and reads the current grant without retrying the save', async () => {
    const { state, writes, write } = install(); await ready()
    write.mockImplementationOnce(async () => { state.payload = { ...state.payload, authorityGeneration: 5 }; return reply({ error: 'Token authority changed.' }, 409) })
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save Portable App Actions Access' }))
    expect(await screen.findByText('This token changed. Your draft is kept. Review its saved access before saving.')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Enable App Actions' }).getAttribute('aria-checked')).toBe('true')
    expect(writes).toHaveLength(1)
    expect((screen.getByRole('button', { name: 'Save Portable App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('keeps the human-route unconfirmed authority response uncertain until an explicit saved-access read', async () => {
    const { writes, write, fetchMock } = install(); const onSaved = await ready()
    // authority.ts -> appActionsHumanRoute: an issued save is not a known 409 refusal.
    const error = 'The authority save may have reached storage. Reload before making another change; replacement is held while settlement is unknown.'
    write.mockResolvedValueOnce(reply({ success: false, code: 'AUTHORITY_SAVE_UNCONFIRMED', error }, 503))
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    const expiry = (screen.getByLabelText('App Actions Expiry') as HTMLInputElement).value
    await fireEvent.click(screen.getByRole('button', { name: 'Save Portable App Actions Access' }))
    await screen.findByText(error)
    expect(screen.getByRole('switch', { name: 'Enable App Actions' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByLabelText('App Actions Expiry') as HTMLInputElement).value).toBe(expiry)
    expect((screen.getByRole('button', { name: 'Save Portable App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
    expect(writes).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onSaved).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('button', { name: 'Check Saved Access' }))
    await screen.findByText('The current saved access was read. The earlier save response remains unconfirmed.')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(writes).toHaveLength(1)
    expect(screen.getByRole('switch', { name: 'Enable App Actions' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByLabelText('App Actions Expiry') as HTMLInputElement).value).toBe(expiry)
    expect((screen.getByRole('button', { name: 'Save Portable App Actions Access' }) as HTMLButtonElement).disabled).toBe(false)
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.queryByText('App Actions access saved. Ask first still requires approval for each protected operation.')).toBeNull()
  })
  it('preserves a confirmed grant save through failed readback without calling the save unknown or replaying it', async () => {
    const { state, writes, write, fetchMock } = install(); await ready()
    const error = 'The grant was saved, but its current readback is unavailable. Check the saved access before another change.'
    write.mockImplementationOnce(async body => {
      state.payload = { ...state.payload, authorityGeneration: 5, grant: body.grant }
      state.status = 503
      return reply({ success: false, code: 'AUTHORITY_SAVED_READBACK_UNAVAILABLE', error }, 503)
    })
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    const expiry = (screen.getByLabelText('App Actions Expiry') as HTMLInputElement).value
    await fireEvent.click(screen.getByRole('button', { name: 'Save Portable App Actions Access' }))
    await screen.findByText(error)
    expect(screen.getByText('The access was saved. Check its current saved value before another change.')).toBeTruthy()
    expect(screen.queryByText('The save outcome is unconfirmed. Check the saved access before making another change.')).toBeNull()
    expect(screen.getByRole('switch', { name: 'Enable App Actions' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByLabelText('App Actions Expiry') as HTMLInputElement).value).toBe(expiry)
    expect((screen.getByRole('button', { name: 'Save Portable App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await fireEvent.click(screen.getByRole('button', { name: 'Check Saved Access' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Check Saved Access' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByText('The access was saved. Check its current saved value before another change.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save Portable App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
    state.status = 200
    await fireEvent.click(screen.getByRole('button', { name: 'Check Saved Access' }))
    await screen.findByText('The access save was confirmed. Its current saved value was checked.')
    expect(screen.queryByText('The current saved access was read. The earlier save response remains unconfirmed.')).toBeNull()
    ;(screen.getByText('Review Saved Access').parentElement as HTMLDetailsElement).open = true
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Access' }))
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    expect((screen.getByRole('button', { name: 'Save Portable App Actions Access' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByLabelText('App Actions Expiry') as HTMLInputElement).value).toBe(expiry)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(writes).toHaveLength(1)
  })
  it('does not expose grant controls after malformed success', async () => {
    const { state, writes } = install(); state.payload = { success: true } as any
    render(PortableAppActionsGrant, { props: { tokenId: 'pst_owned' } })
    expect(await screen.findByRole('button', { name: 'Retry Portable App Actions Access' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Enable App Actions' })).toBeNull()
    expect(writes).toEqual([])
  })
})
