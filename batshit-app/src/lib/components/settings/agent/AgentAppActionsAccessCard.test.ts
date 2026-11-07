import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentAppActionsAccessCard from './AgentAppActionsAccessCard.svelte'
import { defaultAppActionsPolicy, type AppActionsNativePolicyResponse } from '$lib/appActions/settings/managementContract'

const live = vi.hoisted(() => ({ hear: null as null | ((event: any) => void) }))
vi.mock('$lib/services/userChannel', () => ({ onUserChannelEvent: (hear: (event: any) => void) => { live.hear = hear; return () => { live.hear = null } } }))
const SUBJECT = { kind: 'primary' as const, id: 'other' }
const SUBJECT_REVISION = `sha256:${'a'.repeat(64)}`
const RECREATED_SUBJECT_REVISION = `sha256:${'b'.repeat(64)}`
function fixture(): AppActionsNativePolicyResponse {
  return { success: true, agentId: 'actor', generation: 0, subjectRevision: SUBJECT_REVISION, policy: defaultAppActionsPolicy(), subjects: [{ subject: SUBJECT, label: 'Other Agent', type: 'api', available: true }] }
}
function reply(payload: unknown, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function install() {
  const state = { payload: fixture(), loadStatus: 200 }
  const writes: any[] = []
  const write = vi.fn(async (body: any) => { state.payload = { ...state.payload, generation: state.payload.generation + 1, policy: body.policy }; return reply(state.payload) })
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'PUT') return reply(state.payload, state.loadStatus)
    const body = JSON.parse(String(init.body)); writes.push(body); return write(body)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { state, writes, write, fetchMock }
}
async function ready() {
  const mounted = render(AgentAppActionsAccessCard, { props: { agentId: 'actor' } })
  await waitFor(() => expect(mounted.container.querySelector('fieldset')).toBeTruthy())
  ;(mounted.container.querySelector('details') as HTMLDetailsElement).open = true
  return mounted
}
beforeEach(() => { live.hear = null })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('human App Actions native access', () => {
  it('hydrates disabled, self-scoped, Ask first without writing', async () => {
    const { writes } = install(); await ready()
    expect(screen.getByRole('switch', { name: 'Enable App Actions' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('button', { name: 'App Actions subjects' }).textContent).toContain('This agent')
    for (const label of ['Instructions', 'Memory Settings', 'Context Management']) expect(screen.getByRole('button', { name: `${label} permission` }).textContent).toContain('Ask first')
    expect((screen.getByRole('button', { name: 'Save App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
    expect(writes).toEqual([])
  })
  it('saves only the explicit policy with its loaded generation', async () => {
    const { writes } = install(); await ready()
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    expect(writes).toEqual([])
    await fireEvent.click(screen.getByRole('button', { name: 'Save App Actions Access' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({ expectedGeneration: 0, expectedSubjectRevision: SUBJECT_REVISION, policy: { ...defaultAppActionsPolicy(), enabled: true } })
    expect(await screen.findByText('Access saved. Individual actions still check their current permissions.')).toBeTruthy()
  })
  it('keeps failed or malformed reads closed until a deliberate Retry', async () => {
    const { state, writes } = install(); state.payload = { success: true } as any
    const mounted = render(AgentAppActionsAccessCard, { props: { agentId: 'actor' } })
    ;(mounted.container.querySelector('details') as HTMLDetailsElement).open = true
    expect(await screen.findByRole('button', { name: 'Retry App Actions Access' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Enable App Actions' })).toBeNull()
    state.payload = fixture()
    await fireEvent.click(screen.getByRole('button', { name: 'Retry App Actions Access' }))
    expect(await screen.findByRole('switch', { name: 'Enable App Actions' })).toBeTruthy()
    expect(writes).toEqual([])
  })
  it('saves the chosen all-agents scope, exact exclusion and protected mode without changing its other modes', async () => {
    const { writes } = install(); await ready()
    await fireEvent.keyDown(screen.getByRole('button', { name: 'App Actions subjects' }), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'All agents', exact: true }), { pointerType: 'mouse' })
    await fireEvent.click(screen.getByRole('switch', { name: 'Exclude Other Agent (primary:other)' }))
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Memory Settings permission' }), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Block', exact: true }), { pointerType: 'mouse' })
    await fireEvent.click(screen.getByRole('button', { name: 'Save App Actions Access' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].policy.scope).toEqual({ mode: 'all', subjects: [], except: [SUBJECT] })
    expect(writes[0].policy.protected).toEqual({ instructions: 'ask', memorySettings: 'block', contextManagement: 'ask' })
  })
  it('refreshes clean state and preserves a dirty policy until the user reviews the newer generation', async () => {
    const { state, writes } = install(); await ready()
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    state.payload = { ...fixture(), generation: 2, policy: { ...defaultAppActionsPolicy(), ordinaryChanges: false } }
    live.hear?.({ type: 'agent_settings_changed', agentId: 'actor', family: 'app-actions-policy' })
    expect(await screen.findByText('The saved policy changed. Your draft is kept. Review the saved policy before saving.')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Enable App Actions' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByRole('button', { name: 'Save App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
    ;(screen.getByText('Review Saved Policy').parentElement as HTMLDetailsElement).open = true
    await fireEvent.click(screen.getByRole('button', { name: 'Keep My Draft' }))
    expect(writes).toEqual([])
    await fireEvent.click(screen.getByRole('button', { name: 'Save App Actions Access' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].expectedGeneration).toBe(2)
  })
  it('uses the remotely saved policy after a dirty refresh without cloning a state proxy or autosaving', async () => {
    const { state, writes } = install(); await ready()
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    const remotePolicy = { ...defaultAppActionsPolicy(), ordinaryChanges: false }
    state.payload = { ...fixture(), generation: 6, subjectRevision: RECREATED_SUBJECT_REVISION, policy: remotePolicy }
    live.hear?.({ type: 'agent_settings_changed', agentId: 'actor', family: 'app-actions-policy' })
    await screen.findByText('The saved policy changed. Your draft is kept. Review the saved policy before saving.')
    ;(screen.getByText('Review Saved Policy').parentElement as HTMLDetailsElement).open = true
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Policy' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable App Actions' }).getAttribute('aria-checked')).toBe('false'))
    expect(screen.getByRole('switch', { name: 'Ordinary Settings Changes' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText('Review Saved Policy')).toBeNull()
    expect(screen.queryByText('The saved policy changed. Your draft is kept. Review the saved policy before saving.')).toBeNull()
    expect((screen.getByRole('button', { name: 'Save App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
    expect(writes).toEqual([])
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save App Actions Access' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({ expectedGeneration: 6, expectedSubjectRevision: RECREATED_SUBJECT_REVISION, policy: { ...remotePolicy, enabled: true } })
  })
  it('keeps a dirty form fenced when the same agent ID has a new record revision at the same policy generation', async () => {
    const { state, writes } = install(); await ready()
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    state.payload = { ...fixture(), subjectRevision: RECREATED_SUBJECT_REVISION }
    live.hear?.({ type: 'agent_settings_changed', agentId: 'actor', family: 'app-actions-policy' })
    await screen.findByText('The saved policy changed. Your draft is kept. Review the saved policy before saving.')
    expect((screen.getByRole('button', { name: 'Save App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
    ;(screen.getByText('Review Saved Policy').parentElement as HTMLDetailsElement).open = true
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Policy' }))
    expect(writes).toEqual([])
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save App Actions Access' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ expectedGeneration: 0, expectedSubjectRevision: RECREATED_SUBJECT_REVISION })
  })
  it('does not resend an unknown save, and checks saved state only on request', async () => {
    const { writes, write, fetchMock } = install(); await ready()
    write.mockRejectedValueOnce(new Error('Connection lost'))
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save App Actions Access' }))
    expect(await screen.findByText('Connection lost')).toBeTruthy()
    expect(writes).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((screen.getByRole('button', { name: 'Save App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.click(screen.getByRole('button', { name: 'Check Saved Policy' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(writes).toHaveLength(1)
    expect(await screen.findByText('The current saved policy was read. The earlier save response remains unconfirmed.')).toBeTruthy()
  })
  it('keeps the human-route unconfirmed authority response uncertain until an explicit saved-policy read', async () => {
    const { writes, write, fetchMock } = install(); await ready()
    // authority.ts -> appActionsHumanRoute: an issued save is not a known 409 refusal.
    const error = 'The authority save may have reached storage. Reload before making another change; replacement is held while settlement is unknown.'
    write.mockResolvedValueOnce(reply({ success: false, code: 'AUTHORITY_SAVE_UNCONFIRMED', error }, 503))
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save App Actions Access' }))
    await screen.findByText(error)
    expect(screen.getByRole('switch', { name: 'Enable App Actions' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByRole('button', { name: 'Save App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
    expect(writes).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Access saved. Individual actions still check their current permissions.')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Check Saved Policy' }))
    await screen.findByText('The current saved policy was read. The earlier save response remains unconfirmed.')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(writes).toHaveLength(1)
    expect(screen.getByRole('switch', { name: 'Enable App Actions' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByRole('button', { name: 'Save App Actions Access' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText('Access saved. Individual actions still check their current permissions.')).toBeNull()
  })
  it('preserves a confirmed policy save through failed readback without calling the save unknown or replaying it', async () => {
    const { state, writes, write, fetchMock } = install(); await ready()
    const error = 'The policy was saved, but its current readback is unavailable. Check the saved policy before another change.'
    write.mockImplementationOnce(async body => {
      state.payload = { ...state.payload, generation: 1, policy: body.policy }
      state.loadStatus = 503
      return reply({ success: false, code: 'AUTHORITY_SAVED_READBACK_UNAVAILABLE', error }, 503)
    })
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save App Actions Access' }))
    await screen.findByText(error)
    expect(screen.getByText('The policy was saved. Check its current saved value before another change.')).toBeTruthy()
    expect(screen.queryByText('The save outcome is unconfirmed. Check the saved policy before making another change.')).toBeNull()
    expect(screen.getByRole('switch', { name: 'Enable App Actions' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByRole('button', { name: 'Save App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await fireEvent.click(screen.getByRole('button', { name: 'Check Saved Policy' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Check Saved Policy' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByText('The policy was saved. Check its current saved value before another change.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save App Actions Access' }) as HTMLButtonElement).disabled).toBe(true)
    state.loadStatus = 200
    await fireEvent.click(screen.getByRole('button', { name: 'Check Saved Policy' }))
    await screen.findByText('The policy save was confirmed. Its current saved value was checked.')
    expect(screen.queryByText('The current saved policy was read. The earlier save response remains unconfirmed.')).toBeNull()
    ;(screen.getByText('Review Saved Policy').parentElement as HTMLDetailsElement).open = true
    await fireEvent.click(screen.getByRole('button', { name: 'Use Saved Policy' }))
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    expect((screen.getByRole('button', { name: 'Save App Actions Access' }) as HTMLButtonElement).disabled).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(writes).toHaveLength(1)
  })
  it('takes a live refresh received during its own save after that save settles', async () => {
    const { state, write, fetchMock } = install(); await ready()
    const flight = deferred<Response>(); write.mockImplementationOnce(() => flight.promise)
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable App Actions' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save App Actions Access' }))
    live.hear?.({ type: 'reconnected' })
    state.payload = { ...fixture(), generation: 3, policy: { ...defaultAppActionsPolicy(), ordinaryChanges: false } }
    flight.resolve(reply({ ...fixture(), generation: 1, policy: { ...defaultAppActionsPolicy(), enabled: true } }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Ordinary Settings Changes' }).getAttribute('aria-checked')).toBe('false'))
  })
})
