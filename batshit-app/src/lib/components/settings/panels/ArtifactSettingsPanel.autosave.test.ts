import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ArtifactSettingsPanel from './ArtifactSettingsPanel.svelte'

// BL-545 / BL-546: Settings > Artifacts must never save a copy it did not load, and must never
// send back fields the user did not change. The panel is driven against a small fake of the
// artifact routes that keeps one stored record and answers the way the real routes do.

const ARTIFACT_ID = 'artifact_ssart_probe'
const LOADED_CONTENT = '<div id="app">loaded copy</div>'
const AGENT_CONTENT = '<div id="app">the agent changed this after Settings opened</div>'

type StoredArtifact = Record<string, any>

function storedArtifact(overrides: Partial<StoredArtifact> = {}): StoredArtifact {
  return {
    id: ARTIFACT_ID,
    user_id: 'ssart_user',
    name: 'Renamed By Agent',
    slug: 'renamed_by_agent',
    type: 'html',
    content: LOADED_CONTENT,
    mode: 'edit',
    version: 3,
    description: '',
    tags: [],
    metadata: { enforce_batshit_artifact_structure: false, source_type: 'built_in' },
    created_in_session: '',
    last_edited_session: '',
    brain_type: 'built_in',
    ai_enabled: true,
    webhook_url: null,
    system_prompt: null,
    custom_prompt: null,
    zone: null,
    blueprint: null,
    agent_use_enabled: false,
    agent_access_scope: 'selected',
    agent_allowlist: ['agent_kept_by_access_panel'],
    icon_ref: null,
    icon: null,
    created_at: '2026-09-28T10:00:00.000Z',
    updated_at: '2026-09-28T10:00:00.000Z',
    published_at: null,
    versions: [
      { id: 'v1', version: 1, content: '<div>v1</div>', created_at: '2026-09-28T10:00:00.000Z', created_by: 'ssart_user' },
      { id: 'v2', version: 2, content: '<div>v2</div>', created_at: '2026-09-28T10:00:00.000Z', created_by: 'ssart_user' },
      { id: 'v3', version: 3, content: LOADED_CONTENT, created_at: '2026-09-28T10:00:00.000Z', created_by: 'ssart_user' }
    ],
    ...overrides
  }
}

function leanCopy(record: StoredArtifact): StoredArtifact {
  // `/api/artifacts` lists records without `content` or `versions` (the list projection).
  const { content: _content, versions: _versions, ...lean } = record
  return lean
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ensureBrowserStubs() {
  if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: () => {}, finish: () => {}, play: () => {}, pause: () => {}, onfinish: null })
    })
  }
  if (typeof globalThis.ResizeObserver === 'undefined') {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    })
  }
}

/**
 * A fake of the three artifact routes the panel calls. `stored` is the saved record (listed first,
 * so the panel selects it); `others` are listed after it. A PUT is merged the way
 * `ArtifactsService.update` merges (metadata over the stored copy, version +1 when content
 * changes) and refused 409 when it names a `baseVersion` other than the stored one.
 */
function installArtifactRoutes(options: {
  stored: StoredArtifact
  others?: StoredArtifact[]
  detailGate?: Promise<void>
}) {
  const records = new Map<string, StoredArtifact>(
    [options.stored, ...(options.others ?? [])].map((record) => [record.id, record])
  )
  const mainId = options.stored.id
  const state = {
    get stored() {
      return records.get(mainId) as StoredArtifact
    },
    set stored(next: StoredArtifact) {
      records.set(mainId, next)
    },
    records
  }
  const puts: Array<Record<string, any>> = []
  const putIds: string[] = []
  const detailReads: string[] = []

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()

    if (url.startsWith('/api/icons/library')) {
      return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    }
    if (url.startsWith('/api/artifacts?')) {
      return jsonResponse([...records.values()].map(leanCopy))
    }
    const id = url.startsWith('/api/artifacts/') ? decodeURIComponent(url.slice('/api/artifacts/'.length)) : ''
    const record = records.get(id)
    if (record && method === 'GET') {
      detailReads.push(url)
      if (options.detailGate && id === mainId) await options.detailGate
      return jsonResponse(structuredClone(records.get(id)))
    }
    if (record && method === 'PUT') {
      const body = JSON.parse(String(init.body))
      puts.push(body)
      putIds.push(id)
      const { baseVersion, versionDescription: _note, sessionId: _session, ...updates } = body
      if (baseVersion !== undefined && baseVersion !== record.version) {
        return jsonResponse(
          {
            success: false,
            error: `This artifact changed after this edit started: it is now at version ${record.version}, and the edit was made on version ${baseVersion}. Nothing was saved. Load the current version and make the edit again.`,
            code: 'ARTIFACT_VERSION_CONFLICT',
            details: { storedVersion: record.version, baseVersion }
          },
          409
        )
      }
      const contentChanged = typeof updates.content === 'string' && updates.content !== record.content
      const next = {
        ...record,
        ...updates,
        metadata: { ...(record.metadata ?? {}), ...(updates.metadata ?? {}) },
        version: contentChanged ? record.version + 1 : record.version,
        updated_at: new Date().toISOString()
      }
      records.set(id, next)
      return jsonResponse(structuredClone(next))
    }
    throw new Error(`Unhandled fetch: ${method} ${url}`)
  })

  // @ts-expect-error test override
  global.fetch = fetchMock
  return { state, puts, putIds, detailReads, fetchMock }
}

function renderPanel() {
  return render(ArtifactSettingsPanel, {
    props: { data: { user: { id: 'ssart_user' } } }
  })
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Change the Power Source select from the option labelled `from` to the one labelled `to`. */
async function choosePowerSource(from: string, to: string) {
  const trigger = screen.getByText(from, { selector: '[data-slot="select-value"]' }).closest('button')
  await fireEvent.keyDown(trigger as HTMLElement, { key: 'ArrowDown' })
  // Another option's description can name the same source (Gradio's names HuggingFace), so
  // pick the option whose label is the one asked for.
  const options = await screen.findAllByRole('option')
  const option = options.find((entry) => entry.textContent?.trim().startsWith(to))
  expect(option).toBeTruthy()
  await fireEvent.pointerUp(option as HTMLElement, { pointerType: 'mouse' })
}

/** Whether the panel's "Enable For All Agents" switch shows on (it stays visible, disabled, while Agent Use is off). */
function allAgentsSwitchIsOn(): boolean {
  const row = screen.getByText('Enable For All Agents').closest('.batshit-settings-toggle-row') as HTMLElement
  return within(row).getByRole('switch').getAttribute('aria-checked') === 'true'
}

describe('ArtifactSettingsPanel saves only what the user changed, on the copy it loaded', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ensureBrowserStubs()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it('sends no save while the detail is loading, and none after, when the saved slug differs from the name (BL-545)', async () => {
    const gate = deferred<void>()
    // An agent renamed the artifact; the server kept the old slug.
    const routes = installArtifactRoutes({
      stored: storedArtifact({ name: 'Renamed By Agent', slug: 'original_name' }),
      detailGate: gate.promise
    })
    renderPanel()

    await screen.findByDisplayValue('Renamed By Agent')
    await waitFor(() => expect(routes.detailReads).toHaveLength(1))
    // Longer than the 600 ms autosave debounce, with the detail still on its way.
    await pause(1100)
    expect(routes.puts).toEqual([])

    gate.resolve()
    await waitFor(() => expect(screen.getByDisplayValue('original_name')).toBeTruthy())
    await pause(1100)
    expect(routes.puts).toEqual([])
    expect(routes.state.stored.content).toBe(LOADED_CONTENT)
    expect(routes.state.stored.slug).toBe('original_name')
  })

  it('sends no save for a change that arrives before the detail loaded (a preview reporting its Fabric fields) (BL-545)', async () => {
    const gate = deferred<void>()
    const routes = installArtifactRoutes({ stored: storedArtifact(), detailGate: gate.promise })
    renderPanel()

    await screen.findByDisplayValue('Renamed By Agent')
    await waitFor(() => expect(routes.detailReads).toHaveLength(1))
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'batshit:artifact:ready', artifactId: ARTIFACT_ID, fabricFields: [{ fabricId: 'prompt', type: 'text' }] }
      })
    )
    await pause(1100)
    expect(routes.puts).toEqual([])

    gate.resolve()
    await waitFor(() => expect(screen.getByDisplayValue('renamed_by_agent')).toBeTruthy())
    await pause(1100)
    expect(routes.puts).toEqual([])
    expect(routes.state.stored.content).toBe(LOADED_CONTENT)
  })

  it('opens a `_v2` twin without saving it, also when it is opened again after its detail loaded (BL-545)', async () => {
    // The twin was saved as `report_v2` because another "Report" already had `report`.
    const other = storedArtifact({ id: 'artifact_ssart_alpha', name: 'Alpha Tool', slug: 'alpha_tool' })
    const twin = storedArtifact({ id: 'artifact_ssart_report_v2', name: 'Report', slug: 'report_v2' })
    const routes = installArtifactRoutes({ stored: other, others: [twin] })
    renderPanel()

    await screen.findByDisplayValue('alpha_tool')
    const openArtifact = async (name: string, slug: string) => {
      const row = screen.getByText(name, { selector: '.settings-sidebar-item-title' })
      await fireEvent.click(row.closest('button') as HTMLElement)
      await screen.findByDisplayValue(slug)
      await pause(50)
    }
    await openArtifact('Report', 'report_v2')
    await waitFor(() => expect(routes.detailReads).toHaveLength(2))
    await openArtifact('Alpha Tool', 'alpha_tool')
    // The twin's detail is loaded now, so this opening hydrates it in one step, and its name
    // replaces another name in the Name field (which is what made the slug follow the name).
    await openArtifact('Report', 'report_v2')
    await pause(1100)
    expect(routes.puts).toEqual([])
    expect(screen.getByDisplayValue('report_v2')).toBeTruthy()
  })

  it('sends only Placement when the user changes Placement, so an agent change made after opening survives (BL-546)', async () => {
    const routes = installArtifactRoutes({ stored: storedArtifact() })
    renderPanel()

    await screen.findByDisplayValue('Renamed By Agent')
    await waitFor(() => expect(routes.detailReads).toHaveLength(1))
    await pause(50)

    // The agent patches the artifact while Settings is open (the panel is not told).
    routes.state.stored = {
      ...routes.state.stored,
      content: AGENT_CONTENT,
      version: 4,
      metadata: { ...routes.state.stored.metadata, fabric_fields: [{ fabricId: 'prompt', type: 'text' }] },
      agent_allowlist: ['agent_kept_by_access_panel', 'agent_added_in_access']
    }

    const panelOption = (await screen.findByText('Publish in the panel rail.')).closest('button')
    expect(panelOption).toBeTruthy()
    await fireEvent.click(panelOption as HTMLElement)

    await waitFor(() => expect(routes.puts).toHaveLength(1), { timeout: 3000 })
    expect(routes.puts[0]).toEqual({ zone: 'panel', mode: 'published' })
    expect(routes.state.stored.content).toBe(AGENT_CONTENT)
    expect(routes.state.stored.version).toBe(4)
    expect(routes.state.stored.metadata.fabric_fields).toEqual([{ fabricId: 'prompt', type: 'text' }])
    expect(routes.state.stored.agent_allowlist).toEqual(['agent_kept_by_access_panel', 'agent_added_in_access'])
  })

  it('names the loaded version on an HTML save; a newer saved version refuses it, keeps the draft, and reloads after the editor closes (BL-546)', async () => {
    const routes = installArtifactRoutes({ stored: storedArtifact() })
    renderPanel()

    await screen.findByDisplayValue('Renamed By Agent')
    await waitFor(() => expect(routes.detailReads).toHaveLength(1))
    await pause(50)

    routes.state.stored = { ...routes.state.stored, content: AGENT_CONTENT, version: 4 }

    const htmlRow = screen.getByText('Artifact HTML / Code').closest('.batshit-settings-form-row') as HTMLElement
    await fireEvent.click(within(htmlRow).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue(LOADED_CONTENT)
    await fireEvent.input(editor, { target: { value: '<div id="app">my edit</div>' } })
    await fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }))

    await waitFor(() => expect(routes.puts).toHaveLength(1))
    expect(routes.puts[0]).toEqual({ content: '<div id="app">my edit</div>', baseVersion: 3 })

    // The refusal is shown in the editor, and the user's draft stays there.
    expect(await screen.findByText(/saved version 4 while you were editing version 3/)).toBeTruthy()
    expect(screen.getByDisplayValue('<div id="app">my edit</div>')).toBeTruthy()
    expect(routes.detailReads).toHaveLength(1)
    expect(routes.state.stored.content).toBe(AGENT_CONTENT)

    // Closing the editor loads the saved version into the panel.
    await fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    await waitFor(() => expect(routes.detailReads).toHaveLength(2))
    await fireEvent.click(within(htmlRow).getByRole('button', { name: /Edit/ }))
    expect(await screen.findByDisplayValue(AGENT_CONTENT)).toBeTruthy()
  })

  it('keeps the per-agent list when the power source becomes a user-only type, and when it switches back (BL-830)', async () => {
    // Saved with two agents selected; the list is edited in Agents > Access, never in this panel.
    const routes = installArtifactRoutes({
      stored: storedArtifact({
        agent_use_enabled: true,
        agent_access_scope: 'selected',
        agent_allowlist: ['agent_a', 'agent_b'],
        metadata: {
          enforce_batshit_artifact_structure: false,
          source_type: 'built_in',
          fabric_fields: [{ fabricId: 'prompt', type: 'text' }]
        }
      })
    })
    renderPanel()

    await screen.findByDisplayValue('Renamed By Agent')
    await waitFor(() => expect(routes.detailReads).toHaveLength(1))
    await pause(50)

    // HuggingFace is user-only: Agent Use turns off, and the list stays as stored.
    await choosePowerSource('Built-in AI', 'HuggingFace')
    await waitFor(() => expect(routes.puts).toHaveLength(1), { timeout: 3000 })
    expect(routes.puts[0].brain_type).toBe('none')
    expect(routes.puts[0].agent_use_enabled).toBe(false)
    expect('agent_allowlist' in routes.puts[0]).toBe(false)
    expect(routes.state.stored.agent_allowlist).toEqual(['agent_a', 'agent_b'])

    // Switching back saves no list either, so the list is still the one that was saved.
    await waitFor(() => expect(screen.getByText('HuggingFace', { selector: '[data-slot="select-value"]' })).toBeTruthy())
    await choosePowerSource('HuggingFace', 'Built-in AI')
    await waitFor(() => expect(routes.puts).toHaveLength(2), { timeout: 3000 })
    expect(routes.puts[1].brain_type).toBe('built_in')
    expect('agent_allowlist' in routes.puts[1]).toBe(false)
    expect(routes.state.stored.agent_allowlist).toEqual(['agent_a', 'agent_b'])
  })

  it('keeps "Enable For All Agents" when the power source becomes a user-only type, and when it switches back (BL-830)', async () => {
    const routes = installArtifactRoutes({
      stored: storedArtifact({
        agent_use_enabled: true,
        agent_access_scope: 'all',
        agent_allowlist: [],
        metadata: {
          enforce_batshit_artifact_structure: false,
          source_type: 'built_in',
          fabric_fields: [{ fabricId: 'prompt', type: 'text' }]
        }
      })
    })
    renderPanel()

    await screen.findByDisplayValue('Renamed By Agent')
    await waitFor(() => expect(routes.detailReads).toHaveLength(1))
    await pause(50)
    expect(allAgentsSwitchIsOn()).toBe(true)

    // A user-only source turns Agent Use off and hides the choice; it never changes the scope.
    await choosePowerSource('Built-in AI', 'HuggingFace')
    await waitFor(() => expect(routes.puts).toHaveLength(1), { timeout: 3000 })
    expect(routes.puts[0].brain_type).toBe('none')
    expect(routes.puts[0].agent_use_enabled).toBe(false)
    expect('agent_access_scope' in routes.puts[0]).toBe(false)
    expect('agent_allowlist' in routes.puts[0]).toBe(false)
    expect(routes.state.stored.agent_access_scope).toBe('all')

    // Back on an agent-usable source the artifact still reads "all agents"; Agent Use stays off
    // until the user turns it on again, and the switch back sends no scope either.
    await waitFor(() => expect(screen.getByText('HuggingFace', { selector: '[data-slot="select-value"]' })).toBeTruthy())
    await choosePowerSource('HuggingFace', 'Built-in AI')
    // The choice is back on screen as it was saved, before the switch-back save has answered.
    await waitFor(() => expect(screen.getByText('Enable For All Agents')).toBeTruthy())
    expect(allAgentsSwitchIsOn()).toBe(true)
    await waitFor(() => expect(routes.puts).toHaveLength(2), { timeout: 3000 })
    expect(routes.puts[1].brain_type).toBe('built_in')
    expect('agent_access_scope' in routes.puts[1]).toBe(false)
    expect(routes.state.stored.agent_access_scope).toBe('all')
    expect(allAgentsSwitchIsOn()).toBe(true)
  })

  it('an artifact that never saved a scope loads as "all agents" and writes no scope on the same round trip (BL-830)', async () => {
    // Legacy record: no scope, no list, Agent Use never set (JSON drops the undefined fields).
    const routes = installArtifactRoutes({
      stored: storedArtifact({
        agent_use_enabled: undefined,
        agent_access_scope: undefined,
        agent_allowlist: undefined,
        metadata: {
          enforce_batshit_artifact_structure: false,
          source_type: 'built_in',
          fabric_fields: [{ fabricId: 'prompt', type: 'text' }]
        }
      })
    })
    renderPanel()

    await screen.findByDisplayValue('Renamed By Agent')
    await waitFor(() => expect(routes.detailReads).toHaveLength(1))
    await pause(50)
    expect(allAgentsSwitchIsOn()).toBe(true)

    await choosePowerSource('Built-in AI', 'HuggingFace')
    await waitFor(() => expect(routes.puts).toHaveLength(1), { timeout: 3000 })
    expect(routes.puts[0].brain_type).toBe('none')
    expect('agent_access_scope' in routes.puts[0]).toBe(false)
    expect('agent_allowlist' in routes.puts[0]).toBe(false)

    await waitFor(() => expect(screen.getByText('HuggingFace', { selector: '[data-slot="select-value"]' })).toBeTruthy())
    await choosePowerSource('HuggingFace', 'Built-in AI')
    await waitFor(() => expect(screen.getByText('Enable For All Agents')).toBeTruthy())
    expect(allAgentsSwitchIsOn()).toBe(true)
    await waitFor(() => expect(routes.puts).toHaveLength(2), { timeout: 3000 })
    expect('agent_access_scope' in routes.puts[1]).toBe(false)
    expect(allAgentsSwitchIsOn()).toBe(true)
  })

  // BL-174: since BL-121 a Static / No AI artifact gives agents its settings controls only. The
  // card says so in a user-only note beside its Agent Use switch; it is not an eligibility
  // refusal, so the switch, the saved choice and the autosave are unchanged.
  const STATIC_NOTE = /Static \/ No AI runs only for you, in its panel/

  function agentUseSwitch() {
    const row = screen.getByText('Agent Use', { selector: 'p' }).closest('.batshit-settings-toggle-row') as HTMLElement
    return within(row).getByRole('switch')
  }

  it('a Static / No AI artifact shows the user-only note beside its Agent Use switch, and opening it saves nothing (BL-174)', async () => {
    const routes = installArtifactRoutes({
      stored: storedArtifact({
        brain_type: 'none',
        ai_enabled: false,
        agent_use_enabled: true,
        agent_access_scope: 'all',
        agent_allowlist: [],
        metadata: { enforce_batshit_artifact_structure: false, source_type: 'static' }
      })
    })
    renderPanel()

    await screen.findByDisplayValue('Renamed By Agent')
    await waitFor(() => expect(routes.detailReads).toHaveLength(1))

    expect(await screen.findByText(STATIC_NOTE)).toBeTruthy()
    expect(agentUseSwitch().getAttribute('aria-checked')).toBe('true')
    await pause(1100)
    expect(routes.puts).toHaveLength(0)
  })

  it('switching to Static / No AI shows the note and keeps Agent Use on; the save sends only the power source (BL-174)', async () => {
    const routes = installArtifactRoutes({
      stored: storedArtifact({ agent_use_enabled: true, agent_access_scope: 'all', agent_allowlist: [] })
    })
    renderPanel()

    await screen.findByDisplayValue('Renamed By Agent')
    await waitFor(() => expect(routes.detailReads).toHaveLength(1))
    await pause(50)
    expect(screen.queryByText(STATIC_NOTE)).toBeNull()

    await choosePowerSource('Built-in AI', 'Static / No AI')
    expect(await screen.findByText(STATIC_NOTE)).toBeTruthy()
    expect(agentUseSwitch().getAttribute('aria-checked')).toBe('true')
    await waitFor(() => expect(routes.puts).toHaveLength(1), { timeout: 3000 })
    expect(routes.puts[0].brain_type).toBe('none')
    expect('agent_use_enabled' in routes.puts[0]).toBe(false)
    expect(routes.state.stored.agent_use_enabled).toBe(true)
  })
})
