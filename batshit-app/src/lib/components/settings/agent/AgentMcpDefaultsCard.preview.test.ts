import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { tick, type ComponentProps } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentMcpDefaultsCard from './AgentMcpDefaultsCard.svelte'
import {
  confirmUserSettings, resetUserSettings, setUserSettings
} from '$lib/stores/userSettings.svelte'

function props(subjectKind?: 'primary' | 'subagent'): ComponentProps<typeof AgentMcpDefaultsCard> {
  return {
    agentId: 'same_id', subjectKind, toolHostScope: 'api', defaultMCPGateways: [],
    defaultMCPToolSelections: [], dcmDisplaySettings: { version: 1, groups: {}, tools: {} },
    mcpSaveState: 'idle', mcpRenderNonce: 0, defaultOpen: true, showCardHeader: false,
    showZipControls: false, showZipModeControls: false, showGridIntroBlock: false,
    onGatewaysChange: vi.fn(), onDcmDisplaySettingsChange: vi.fn(),
    getToolZipOverride: () => ({ buffer_size: '', zip_threshold: '', auto_zip: '__inherit__' }),
    onToolZipOverrideChange: vi.fn(),
    getNonMcpZipOverride: () => ({ buffer_size: '', zip_threshold: '', auto_zip: '__inherit__', min_buffer: 2 }),
    onNonMcpZipOverrideChange: vi.fn(), onZipAiViewModeChange: vi.fn()
  }
}
function reply(text: string, details: Record<string, unknown> = {}) { return new Response(JSON.stringify({ text, ...details }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function install(respond: (body: Record<string, unknown>, index: number) => Promise<Response>) {
  const requests: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/api/mcp/tools/dcm')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body)); requests.push(body)
    return respond(body, requests.length)
  }))
  return requests
}
async function openPreview() { await fireEvent.click(screen.getByRole('button', { name: 'Preview Agent Setup Tools' })) }
afterEach(() => { cleanup(); resetUserSettings(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('typed Agent Setup tool preview identity', () => {
  it('marks unprepared runtime utility estimates partial without reporting an authoritative empty tool set', async () => {
    install(async () => reply('', { apiUtilityProjection: 'unprepared', counts: { availableTools: 0, dcmTools: 0 } }))
    const cardProps = props('primary')
    render(AgentMcpDefaultsCard, { props: cardProps })
    await openPreview()
    expect(await screen.findByText(/Runtime utility hints are not computed by this preview/)).toBeTruthy()
    expect(screen.getByText('No computed tool groups in this preview.')).toBeTruthy()
    expect(screen.queryByText('No discoverable tools left to list.')).toBeNull()
    expect(cardProps.onDcmDisplaySettingsChange).not.toHaveBeenCalled()
    expect(cardProps.onGatewaysChange).not.toHaveBeenCalled()
  })
  it('labels token estimates and separates the scalable tool budget from fixed feature hints', async () => {
    install(async () => reply('Tool index plus feature hints', {
      tokenEstimates: { enabled: 250, dcm: 3605, total: 3855 },
      counts: { enabledTools: 4, availableTools: 12, dcmTools: 8, groups: 3 },
      hintBudget: { limit: 3000, budgetedTokens: 2840, featureTokens: 765 }
    }))
    render(AgentMcpDefaultsCard, { props: props('primary') })
    await openPreview()
    await screen.findByText('Tool index plus feature hints')
    expect(screen.getByText('Tool index token estimate: 3605')).toBeTruthy()
    expect(screen.getByText('Combined tool token estimate: 3855')).toBeTruthy()
    expect(screen.getByText('Scalable tool hint token estimate: 2840 / 3000')).toBeTruthy()
    expect(screen.getByText('Fixed feature hint token estimate: 765')).toBeTruthy()
    expect(screen.getByText(/enabled skills catalog is outside this preview/)).toBeTruthy()
    expect(screen.queryByText(/DCM tokens:/)).toBeNull()
  })

  it.each([undefined, { limit: 3000, budgetedTokens: 2800 }])('does not invent measured zeros when hint accounting is absent or incomplete (%s)', async hintBudget => {
    install(async () => reply('Tool index without accounting', { hintBudget }))
    render(AgentMcpDefaultsCard, { props: props('primary') })
    await openPreview()
    await screen.findByText('Tool index without accounting')
    expect(screen.getByText('Tool index token estimate: Unknown')).toBeTruthy()
    expect(screen.queryByText(/Scalable tool hint token estimate:/)).toBeNull()
    expect(screen.queryByText(/Fixed feature hint token estimate:/)).toBeNull()
  })

  it('a confirmed Admin hint change refreshes an open preview without changing the Tool Grid draft', async () => {
    confirmUserSettings({ admin_settings: { dcm_schema_hint_total_tokens: 3000 } })
    const requests = install(async (_body, index) => reply(index === 1 ? 'Before Admin save' : 'After Admin save'))
    const cardProps = props('primary')
    render(AgentMcpDefaultsCard, { props: cardProps })
    await openPreview()
    await screen.findByText('Before Admin save')
    confirmUserSettings({ admin_settings: { dcm_schema_hint_total_tokens: 4200 } })
    await screen.findByText('After Admin save')
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(cardProps.onGatewaysChange).not.toHaveBeenCalled()
    expect(cardProps.onDcmDisplaySettingsChange).not.toHaveBeenCalled()
  })

  it('shows the server budget refusal clearly instead of rendering JSON as preview text', async () => {
    const error = 'Tool hint budget 500 is below the minimum 640. Increase the budget or reduce enabled groups.'
    install(async () => new Response(JSON.stringify({
      error, code: 'TOOL_HINT_BUDGET_TOO_SMALL', budgetTokens: 500, minimumRequiredTokens: 640
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
    render(AgentMcpDefaultsCard, { props: props('primary') })
    await openPreview()
    expect(await screen.findByText(error)).toBeTruthy()
    expect(screen.queryByText(/"code":/)).toBeNull()
    expect(screen.queryByText(/No discoverable tools left to list/)).toBeNull()
  })

  it('an unconfirmed settings value does not become a confirmed Admin preview dependency', async () => {
    resetUserSettings()
    const requests = install(async () => reply('Server-owned preview'))
    render(AgentMcpDefaultsCard, { props: props('primary') })
    await openPreview()
    await screen.findByText('Server-owned preview')
    setUserSettings({ admin_settings: { dcm_schema_hint_total_tokens: 12000 } })
    await tick()
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(requests).toHaveLength(1)
    expect(screen.getByText('Server-owned preview')).toBeTruthy()
  })

  it.each(['primary', 'subagent', undefined] as const)('sends only the explicit subject namespace (%s), without deriving Primary from API scope', async kind => {
    const requests = install(async () => reply('Current scoped preview'))
    render(AgentMcpDefaultsCard, { props: props(kind) })
    await openPreview()
    await screen.findByText('Current scoped preview')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ agentId: 'same_id', runtime: 'api' })
    if (kind) expect(requests[0].subjectKind).toBe(kind)
    else expect(requests[0]).not.toHaveProperty('subjectKind')
  })

  it('clears a completed Primary preview when the same ID becomes a Subagent', async () => {
    const subagent = deferred<Response>()
    const requests = install(async (_body, index) => index === 1 ? reply('Primary-only preview') : subagent.promise)
    const mounted = render(AgentMcpDefaultsCard, { props: props('primary') })
    await openPreview()
    await screen.findByText('Primary-only preview')
    await mounted.rerender(props('subagent'))
    expect(screen.queryByText('Primary-only preview')).toBeNull()
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toMatchObject({ agentId: 'same_id', subjectKind: 'subagent', runtime: 'api' })
    subagent.resolve(reply('Subagent preview'))
    await screen.findByText('Subagent preview')
    expect(screen.queryByText('Primary-only preview')).toBeNull()
  })

  it('rejects a late Primary answer after a same-ID namespace change', async () => {
    const primary = deferred<Response>()
    const requests = install(async (_body, index) => index === 1 ? primary.promise : reply('Current Subagent preview'))
    const mounted = render(AgentMcpDefaultsCard, { props: props('primary') })
    await openPreview()
    await waitFor(() => expect(requests).toHaveLength(1))
    await mounted.rerender(props('subagent'))
    await screen.findByText('Current Subagent preview')
    const late = reply('Late Primary-only preview')
    const readLate = vi.spyOn(late, 'json')
    primary.resolve(late)
    await waitFor(() => expect(readLate).toHaveBeenCalledTimes(1))
    await tick()
    expect(screen.queryByText('Late Primary-only preview')).toBeNull()
    expect(screen.getByText('Current Subagent preview')).toBeTruthy()
    expect(requests).toHaveLength(2)
  })
})
