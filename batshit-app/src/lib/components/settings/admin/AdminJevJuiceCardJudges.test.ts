import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminJevJuiceCard from './AdminJevJuiceCard.svelte'

/**
 * SA-120 P10a (DL-120-18) — the judges on the Admin Judge Juice card, under the Settings Auto-Save Contract: an old
 * record hydrates as TypeSafe only and saves nothing; every judge edit rides the one signature and one PUT; removing a
 * judge moves the choices that named it in the same save; Test asks the SAVED judge by id and waits while unsaved.
 */

type FetchCall = { url: string; init?: RequestInit }

const OLLAMA_PC = { id: 'ollama-pc', kind: 'ollama', label: 'Ollama on the PC', baseUrl: 'http://192.168.1.20:11434', modelId: 'clef-flash' }
const CLOUDFLARE = { id: 'cf', kind: 'cloudflare', label: 'Cloudflare', accountId: '0123456789abcdef0123456789abcdef', modelId: 'clef' }

function installFetch(options: { config?: Record<string, unknown>; keys?: Record<string, unknown> | null; keyPresent?: boolean } = {}) {
  const calls: FetchCall[] = []
  let config: Record<string, unknown> = {
    enabled: true,
    modelId: 'jev-1.13.0',
    attemptTimeoutMs: 5000,
    inChatWaitMs: 750,
    screenIncomingText: false,
    updatedAt: null,
    ...(options.config ?? {})
  }
  const key = options.keyPresent === false ? { present: false, source: null } : { present: true, source: 'user' }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    if (url.endsWith('/api/settings/typesafe') && (!init?.method || init.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          config,
          key,
          ...(options.keys === null ? {} : { keys: options.keys ?? { typesafe: key, cloudflare_workers_ai: { present: false, source: null }, systemone_url: { present: false, source: null } } }),
          limits: { pinnedModelId: 'jev-1.13.0', attemptTimeoutMinMs: 500, attemptTimeoutMaxMs: 30000, inChatWaitMinMs: 200, inChatWaitMaxMs: 30000 }
        })
      }
    }
    if (url.endsWith('/api/settings/typesafe') && init?.method === 'PUT') {
      config = { ...config, ...JSON.parse(String(init.body)), updatedAt: 'now' }
      return { ok: true, status: 200, json: async () => ({ config, key }) }
    }
    if (url.endsWith('/api/settings/typesafe/test')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, model: 'clef-flash', latencyMs: 31, message: 'Clef Flash (Ollama) answered on your local network in 31 ms.' }) }
    }
    if (url.endsWith('/api/settings/typesafe/ollama-models')) {
      return { ok: true, status: 200, json: async () => ({ baseUrl: 'http://192.168.1.20:11434', models: [{ name: 'clef-flash:latest', contextTokens: 16384 }], otherModelCount: 2 }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
  return { calls }
}

const putBodies = (calls: FetchCall[]) => calls.filter((call) => call.init?.method === 'PUT').map((call) => JSON.parse(String(call.init?.body)))
const settle = () => new Promise((resolve) => setTimeout(resolve, 700))

async function hydrated() {
  const toggle = await screen.findByRole('switch', { name: /allow judge juice/i })
  await waitFor(() => expect(toggle).not.toBeDisabled())
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AdminJevJuiceCard: judges (SA-120 P10a)', () => {
  it('RECORD-SHAPE TOLERANCE: an answer from before P10a (no judge fields, no keys) hydrates as TypeSafe only and saves nothing', async () => {
    const { calls } = installFetch({ keys: null })
    render(AdminJevJuiceCard)
    await hydrated()
    await settle()
    expect(putBodies(calls)).toHaveLength(0)
    expect(screen.getByTestId('judge-card-typesafe')).toBeTruthy()
    expect(screen.queryAllByTestId(/^judge-card-(?!typesafe)/)).toHaveLength(0)
    expect(screen.getByText("Your text leaves this computer and goes to TypeSafe's servers.")).toBeTruthy()
    expect((screen.getByLabelText('Default Judge') as HTMLElement).textContent).toContain('TypeSafe')
  })

  it('hydrates saved judges and choices without saving, and draws where each one sends text', async () => {
    const { calls } = installFetch({
      config: { providers: [OLLAMA_PC, CLOUDFLARE], defaultProviderId: 'ollama-pc', laneProviders: { untrusted_text: 'typesafe' } },
      keyPresent: false
    })
    render(AdminJevJuiceCard)
    await hydrated()
    await settle()
    expect(putBodies(calls)).toHaveLength(0)
    expect(screen.getByTestId('judge-privacy-ollama-pc').textContent).toBe(
      'Your text leaves this computer but stays on your local network (192.168.1.20).'
    )
    expect(screen.getByTestId('judge-privacy-cf').textContent).toBe("Your text leaves this computer and goes to Cloudflare's servers (Workers AI).")
    // Cloudflare needs its token; the note links to API Keys like the TypeSafe one.
    const keyNote = screen.getByTestId('judge-missing-key')
    expect(keyNote.textContent).toContain('Cloudflare Workers AI (Judge Juice)')
    // TypeSafe is still in use (Screen Incoming Text chose it), so its missing-key note stays.
    expect(screen.getByTestId('jev-juice-missing-key')).toBeTruthy()
    expect((screen.getByLabelText('Default Judge') as HTMLElement).textContent).toContain('Ollama on the PC')
    expect((screen.getByLabelText('Incoming text screen') as HTMLElement).textContent).toContain('TypeSafe')
    expect((screen.getByLabelText('Smart zip') as HTMLElement).textContent).toContain('Default (Ollama on the PC)')
  })

  it('BL-1451: Which Judge keeps its title row as a direct child of its subsection (the flat-row CSS needs that structure)', async () => {
    installFetch()
    render(AdminJevJuiceCard)
    await hydrated()
    const titleRow = screen.getByText('Which Judge').closest('.batshit-settings-action-row')
    expect(titleRow).toBeTruthy()
    expect(titleRow?.parentElement?.classList.contains('batshit-settings-subsection')).toBe(true)
  })

  it('hides the TypeSafe missing-key note when no feature uses TypeSafe', async () => {
    installFetch({ config: { providers: [OLLAMA_PC], defaultProviderId: 'ollama-pc', laneProviders: {} }, keyPresent: false })
    render(AdminJevJuiceCard)
    await hydrated()
    expect(screen.queryByTestId('jev-juice-missing-key')).toBeNull()
  })

  it('removing a judge moves every feature choice that named it back to the Default Judge, in one PUT', async () => {
    const { calls } = installFetch({
      config: { providers: [OLLAMA_PC, CLOUDFLARE], defaultProviderId: 'cf', laneProviders: { smart_zip: 'ollama-pc', reply_check: 'cf' } }
    })
    render(AdminJevJuiceCard)
    await hydrated()
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Ollama on the PC' }))
    await waitFor(() => expect(putBodies(calls)).toHaveLength(1), { timeout: 3000 })
    expect(putBodies(calls)[0]).toMatchObject({ providers: [CLOUDFLARE], defaultProviderId: 'cf', laneProviders: { reply_check: 'cf' } })
    await settle()
    expect(putBodies(calls)).toHaveLength(1)
  })

  it('round 1, S6: the Default Judge cannot be removed (pick another default first), and nothing is saved', async () => {
    const { calls } = installFetch({
      config: { providers: [OLLAMA_PC], defaultProviderId: 'ollama-pc', laneProviders: { smart_zip: 'ollama-pc' } }
    })
    render(AdminJevJuiceCard)
    await hydrated()
    const remove = screen.getByRole('button', { name: 'Remove Ollama on the PC' })
    expect(remove).toBeDisabled()
    expect(remove.getAttribute('title')).toBe('Pick another Default Judge first')
    await fireEvent.click(remove)
    await settle()
    expect(putBodies(calls)).toHaveLength(0)
    expect(screen.getByTestId('judge-card-ollama-pc')).toBeTruthy()
    expect((screen.getByLabelText('Default Judge') as HTMLElement).textContent).toContain('Ollama on the PC')
  })

  it('round 1, M2 + S3: a damaged stored choice shows as a missing judge, never as TypeSafe, and does not block switching off', async () => {
    const { calls } = installFetch({
      config: { providers: [OLLAMA_PC], defaultProviderId: '__unreadable__', laneProviders: { smart_zip: 'gone-judge' } },
      keyPresent: false
    })
    render(AdminJevJuiceCard)
    await hydrated()
    expect((screen.getByLabelText('Default Judge') as HTMLElement).textContent).toContain('Missing judge')
    expect((screen.getByLabelText('Smart zip') as HTMLElement).textContent).toContain('Missing judge')
    expect((screen.getByLabelText('Default Judge') as HTMLElement).textContent).not.toContain('TypeSafe')
    // TypeSafe is in use by no feature, so its missing-key note stays quiet.
    expect(screen.queryByTestId('jev-juice-missing-key')).toBeNull()

    await fireEvent.click(screen.getByRole('switch', { name: /allow judge juice/i }))
    await waitFor(() => expect(putBodies(calls)).toHaveLength(1), { timeout: 3000 })
    expect(putBodies(calls)[0]).toMatchObject({ enabled: false, defaultProviderId: '__unreadable__', laneProviders: { smart_zip: 'gone-judge' } })
    expect(screen.queryByText(/Pick a judge again/)).toBeNull()
  })

  it('a name edit saves once; a half-set-up judge shows its error and sends nothing', async () => {
    const { calls } = installFetch({ config: { providers: [OLLAMA_PC], defaultProviderId: 'typesafe', laneProviders: {} } })
    render(AdminJevJuiceCard)
    await hydrated()
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Gaming PC' } })
    await waitFor(() => expect(putBodies(calls)).toHaveLength(1), { timeout: 3000 })
    expect(putBodies(calls)[0].providers).toEqual([{ ...OLLAMA_PC, label: 'Gaming PC' }])
    await screen.findByText('Saved')

    await fireEvent.input(screen.getByLabelText('Model'), { target: { value: '' } })
    await screen.findByText('"Gaming PC": a model is required.', undefined, { timeout: 3000 })
    await settle()
    expect(putBodies(calls)).toHaveLength(1)
  })

  it('adds a judge from the menu with its kind, a starting address, and its own id', async () => {
    const { calls } = installFetch({ config: { providers: [], defaultProviderId: 'typesafe', laneProviders: {} } })
    render(AdminJevJuiceCard)
    await hydrated()
    await fireEvent.pointerDown(screen.getByRole('button', { name: /Add Judge/ }), { button: 0, pointerType: 'mouse' })
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'System One URL: LM Studio' }))
    const card = await screen.findByText('LM Studio')
    expect(card).toBeTruthy()
    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe('http://127.0.0.1:1234')
    // No model yet: the draft is refused on the card and nothing is sent.
    await screen.findByText('"LM Studio": a model is required.', undefined, { timeout: 3000 })
    expect(putBodies(calls)).toHaveLength(0)
    await fireEvent.input(screen.getByLabelText('Model'), { target: { value: 'clef-flash' } })
    await waitFor(() => expect(putBodies(calls)).toHaveLength(1), { timeout: 3000 })
    const [saved] = putBodies(calls)[0].providers
    expect(saved).toMatchObject({ kind: 'systemone_url', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234', modelId: 'clef-flash', sendsKey: false })
    expect(saved.id).toMatch(/^systemone-url-[0-9a-f]{6}$/)
  })

  it('Test asks the SAVED judge by id, shows the answer, and waits while an edit is unsaved', async () => {
    const { calls } = installFetch({ config: { providers: [OLLAMA_PC], defaultProviderId: 'typesafe', laneProviders: {} } })
    render(AdminJevJuiceCard)
    await hydrated()
    const test = screen.getByRole('button', { name: 'Test Ollama on the PC' })
    await waitFor(() => expect(test).not.toBeDisabled())
    await fireEvent.click(test)
    await screen.findByText('Clef Flash (Ollama) answered on your local network in 31 ms.')
    const testCall = calls.find((call) => call.url.endsWith('/api/settings/typesafe/test'))
    expect(JSON.parse(String(testCall?.init?.body))).toEqual({ providerId: 'ollama-pc' })

    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'PC' } })
    expect(screen.getByRole('button', { name: 'Test PC' })).toBeDisabled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test PC' })).not.toBeDisabled(), { timeout: 3000 })
  })

  it('Find Models lists the decision models and warns about a typed model Ollama does not list', async () => {
    const { calls } = installFetch({ config: { providers: [OLLAMA_PC], defaultProviderId: 'typesafe', laneProviders: {} } })
    render(AdminJevJuiceCard)
    await hydrated()
    await fireEvent.click(screen.getByRole('button', { name: /Find Models/ }))
    await screen.findByLabelText('Decision Models')
    const listCall = calls.find((call) => call.url.endsWith('/api/settings/typesafe/ollama-models'))
    expect(JSON.parse(String(listCall?.init?.body))).toEqual({ baseUrl: 'http://192.168.1.20:11434' })
    // The saved model is "clef-flash"; Ollama lists "clef-flash:latest".
    expect(await screen.findByText(/Ollama does not list this model as a decision model/)).toBeTruthy()
    await fireEvent.input(screen.getByLabelText('Model'), { target: { value: 'clef-flash:latest' } })
    await waitFor(() => expect(screen.queryByText(/Ollama does not list this model/)).toBeNull())
    expect(await screen.findByText(/about 16,384 tokens of text \(reported by Ollama\)/)).toBeTruthy()
  })
})
