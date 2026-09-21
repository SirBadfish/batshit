import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminJevJuiceCard from './AdminJevJuiceCard.svelte'

/**
 * SA-120 P0 — the Settings Auto-Save Contract for the Jev Juice card: hydration must
 * not save, and a real edit saves exactly once. The key and its Test button moved to
 * Settings → API Keys in the P7 review (Josh, 2026-09-17); this card only says when the key
 * is missing and points there.
 */

type FetchCall = { url: string; init?: RequestInit }

function installFetch(overrides: { putStatus?: number; keyPresent?: boolean; inChatWaitMs?: number } = {}) {
  const calls: FetchCall[] = []
  const config = {
    enabled: false,
    modelId: 'jev-1.13.0',
    attemptTimeoutMs: 5000,
    inChatWaitMs: overrides.inChatWaitMs ?? 750,
    screenIncomingText: false,
    updatedAt: null
  }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    if (url.endsWith('/api/settings/typesafe') && (!init || !init.method || init.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          config,
          key: overrides.keyPresent === false ? { present: false, source: null } : { present: true, source: 'user' },
          limits: {
            pinnedModelId: 'jev-1.13.0',
            attemptTimeoutMinMs: 500,
            attemptTimeoutMaxMs: 30000,
            inChatWaitMinMs: 200,
            inChatWaitMaxMs: 30000
          }
        })
      }
    }
    if (url.endsWith('/api/settings/typesafe') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      const status = overrides.putStatus ?? 200
      return {
        ok: status < 400,
        status,
        json: async () =>
          status < 400
            ? { config: { ...config, ...body, updatedAt: 'now' }, key: { present: true, source: 'user' } }
            : { error: 'nope' }
      }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
  return { calls, fetchMock }
}

const putCalls = (calls: FetchCall[]) => calls.filter((call) => call.init?.method === 'PUT')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AdminJevJuiceCard', () => {
  it('hydrates without saving, then saves exactly once when the master switch is flipped', async () => {
    const { calls } = installFetch()
    render(AdminJevJuiceCard)

    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/api/settings/typesafe'))).toBe(true))
    const toggle = await screen.findByRole('switch', { name: /allow jev juice/i })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    // Give any hydration-triggered autosave a chance to (wrongly) fire.
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(putCalls(calls)).toHaveLength(0)

    await fireEvent.click(toggle)
    await waitFor(() => expect(putCalls(calls)).toHaveLength(1), { timeout: 3000 })
    expect(JSON.parse(String(putCalls(calls)[0].init?.body))).toEqual({
      enabled: true,
      modelId: 'jev-1.13.0',
      attemptTimeoutMs: 5000,
      // SA-120 P8: the In-Chat Wait Limit rides the same draft (LS-059).
      inChatWaitMs: 750,
      // SA-120 P7: the card sends its whole draft; a record from before P7 hydrates this as OFF.
      screenIncomingText: false
    })
    await screen.findByText('Saved')
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(putCalls(calls)).toHaveLength(1)
  })

  it('shows the save error and does not retry on its own', async () => {
    const { calls } = installFetch({ putStatus: 400 })
    render(AdminJevJuiceCard)
    const toggle = await screen.findByRole('switch', { name: /allow jev juice/i })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    await fireEvent.click(toggle)
    await waitFor(() => expect(putCalls(calls)).toHaveLength(1), { timeout: 3000 })
    await screen.findByText('nope')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(putCalls(calls)).toHaveLength(1)
  })

  it('SA-120 P8: hydrates the In-Chat Wait Limit from the record, saves an edit exactly once, and refuses an out-of-range one without a PUT', async () => {
    // A stored value that is NOT the card's own starting number, so hydration is really from the record.
    const { calls } = installFetch({ inChatWaitMs: 1250 })
    render(AdminJevJuiceCard)
    const wait = (await screen.findByLabelText('In-Chat Wait Limit (ms)')) as HTMLInputElement
    await waitFor(() => expect(wait).not.toBeDisabled())
    await waitFor(() => expect(wait.value).toBe('1250'))
    expect(wait.min).toBe('200')
    expect(wait.max).toBe('30000')

    await fireEvent.input(wait, { target: { value: '5000' } })
    await waitFor(() => expect(putCalls(calls)).toHaveLength(1), { timeout: 3000 })
    expect(JSON.parse(String(putCalls(calls)[0].init?.body))).toMatchObject({ inChatWaitMs: 5000, attemptTimeoutMs: 5000 })
    await screen.findByText('Saved')

    await fireEvent.input(wait, { target: { value: '100' } })
    await screen.findByText(/In-Chat Wait Limit must be a whole number from 200 to 30000 ms/, undefined, { timeout: 3000 })
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(putCalls(calls)).toHaveLength(1)
  })

  it('refuses jev-latest in the field without calling the server', async () => {
    const { calls } = installFetch()
    render(AdminJevJuiceCard)
    const model = (await screen.findByLabelText('Model')) as HTMLInputElement
    await waitFor(() => expect(model).not.toBeDisabled())
    await fireEvent.input(model, { target: { value: 'jev-latest' } })
    await screen.findByText(/pinned Jev id/i, undefined, { timeout: 3000 })
    expect(putCalls(calls)).toHaveLength(0)
  })

  it('has no key row and no Test button: those live in Settings → API Keys', async () => {
    installFetch()
    render(AdminJevJuiceCard)
    // Wait for hydration to finish: the missing-key note is only decided once the key status is known.
    const model = await screen.findByLabelText('Model')
    await waitFor(() => expect(model).not.toBeDisabled())
    expect(screen.queryByRole('button', { name: 'Test' })).toBeNull()
    expect(screen.queryByText(/Needs Key/)).toBeNull()
    expect(screen.queryByText(/TypeSafe Key/)).toBeNull()
    expect(screen.queryByTestId('jev-juice-missing-key')).toBeNull()
  })

  it('says the key is missing and points at API Keys, as a warning once the master switch is on', async () => {
    installFetch({ keyPresent: false })
    render(AdminJevJuiceCard)
    const note = await screen.findByTestId('jev-juice-missing-key')
    expect(note.textContent).toContain('No TypeSafe key yet')
    expect(note.textContent).toContain('Settings → API Keys')
    expect(note.className).not.toContain('is-warning')

    const events: unknown[] = []
    window.addEventListener('batshit:open-settings', (event) => events.push((event as CustomEvent).detail))
    await fireEvent.click(screen.getByRole('button', { name: /Settings → API Keys/ }))
    expect(events).toEqual([{ tab: 'api-keys' }])

    const master = screen.getByRole('switch', { name: /Allow Jev Juice/i })
    await waitFor(() => expect(master).not.toBeDisabled())
    await fireEvent.click(master)
    await waitFor(() => expect(screen.getByTestId('jev-juice-missing-key').className).toContain('is-warning'))
  })
})
