import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { buildPickedPresetModelFields } from '$lib/utils/modelPresetPick'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'

/**
 * The Agent Settings half of BL-544 and BL-482.
 *
 * BL-544: Agents > Access loads every skill's and artifact's access list once per Settings visit.
 * Its toggles sent the whole list from that copy (and switched Enable For All Agents off, and set
 * an artifact's scope to selected agents), so an agent another panel had turned on since, or an
 * all-agents switch turned on since, was undone. The toggles now call the one-agent routes, which
 * add or remove the one id against the list as stored. A skill with no list at all is on for
 * every agent (the runtime rule, `commandEnabledForAgent`); Access shows it on, and turning one
 * agent off keeps the others on (the route writes the other agents as an explicit list).
 * The basic save no longer sends a `voice_profile` the user did not change (BL-514's changed-
 * fields patch), so a voice engine delete that cleared it is not undone.
 *
 * BL-482: clearing a Subagent's Custom System Prompt sends `''`, which the route stores as no
 * prompt (it sent `undefined`, which JSON drops, so the old prompt stayed).
 *
 * Renders the REAL panel. `/api/agents/<id>` and `/api/subagents/<id>` go to the REAL route
 * handlers on the default lane's Redis fake. The skill and artifact routes are a small fake that
 * answers the way the real ones do (the real ones run a Lua step and the artifact write lock,
 * proven on real Redis in `agentAccessRoutes.test.ts`).
 */

vi.mock('$lib/server/services/codexProfileManager', () => ({
  syncAgentCodexProfiles: vi.fn(async () => {}),
  deleteAgentCodexConfig: vi.fn(async () => {}),
  buildAgentProfileId: (id: string) => `batshit_agent_${id}`
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))
vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: vi.fn() }))

useRedisTestServer()

const USER = 'ssacc_panel_user'
const AGENT = 'ssacc_panel_agent'
const OTHER_AGENTS = ['ssacc_nova', 'ssacc_orla']
const SUB = 'ssacc_panel_sub'
const SKILL = 'ssacc-panel-skill'
const ARTIFACT = 'artifact_ssacc_panel'

const PRESET = {
  id: 'ssacc_panel_preset',
  provider: 'openai',
  modelId: 'gpt-5.5',
  modelName: 'Probe Model A',
  purpose: 'chat',
  connection: { type: 'direct', service: 'openai' },
  settings: { temperature: 0.7 }
}

function probeAgent(extra: Record<string, unknown> = {}) {
  return {
    id: AGENT,
    user_id: USER,
    displayName: 'Panel probe',
    agentType: 'api',
    ...buildPickedPresetModelFields(PRESET as any),
    primary_model_connection: resolveSavedModelConnection(PRESET as any),
    provider_specific_settings: { temperature: 0.7 },
    ...extra
  }
}

function skillRecord(extra: Record<string, unknown> = {}) {
  return {
    id: SKILL,
    user_id: USER,
    name: SKILL,
    displayName: 'Ssacc Panel Skill',
    type: 'skill',
    skill_id: 'ssacc_panel_skill',
    invocation_pattern: '/ssacc-panel-skill',
    enabled_for_all_agents: false,
    enabled_agent_ids: ['ssacc_nova'],
    is_active: true,
    is_system: false,
    created_at: '2026-09-28T10:00:00.000Z',
    updated_at: '2026-09-28T10:00:00.000Z',
    ...extra
  }
}

function artifactRecord(extra: Record<string, unknown> = {}) {
  return {
    id: ARTIFACT,
    user_id: USER,
    name: 'Ssacc Panel Artifact',
    slug: 'ssacc_panel_artifact',
    type: 'html',
    mode: 'edit',
    version: 1,
    brain_type: 'built_in',
    ai_enabled: true,
    metadata: { enforce_batshit_artifact_structure: false, run_only: true },
    zone: null,
    agent_use_enabled: true,
    agent_access_scope: 'selected',
    agent_allowlist: ['ssacc_nova'],
    created_at: '2026-09-28T10:00:00.000Z',
    updated_at: '2026-09-28T10:00:00.000Z',
    ...extra
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
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
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.hasPointerCapture !== 'function') {
    Object.defineProperty(Element.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
    Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value: () => {} })
    Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: () => {} })
  }
}

let agentRoute: typeof import('../../../../routes/api/agents/[id]/+server')
let subagentRoute: typeof import('../../../../routes/api/subagents/[id]/+server')

beforeAll(async () => {
  agentRoute = await import('../../../../routes/api/agents/[id]/+server')
  subagentRoute = await import('../../../../routes/api/subagents/[id]/+server')
}, 60_000)

type Sent = { method: string; path: string; body: Record<string, any> }
let sent: Sent[] = []
let agentReads = 0
/** The stored skill and artifact records the fake routes answer from. */
let skills: Map<string, Record<string, any>>
let artifacts: Map<string, Record<string, any>>

function installRoutes() {
  sent = []
  agentReads = 0
  skills = new Map()
  artifacts = new Map()
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]
    const body = init.body ? JSON.parse(String(init.body)) : null
    if (method !== 'GET') sent.push({ method, path, body })

    if (path === '/api/agents' && method === 'GET') {
      const agent = await redis.json.get(`agent:${AGENT}`)
      return jsonResponse({ agents: agent ? [agent] : [] })
    }
    if (path === `/api/agents/${AGENT}/subagents`) {
      return jsonResponse({ subagents: [] })
    }
    if (path === `/api/agents/${AGENT}`) {
      const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
      if (method !== 'PUT') agentReads += 1
      const handler = method === 'PUT' ? agentRoute.PUT : agentRoute.GET
      return (await handler({ params: { id: AGENT }, request, locals: { user: { id: USER } } } as any)) as Response
    }
    if (path === '/api/subagents' && method === 'GET') {
      const sub = await redis.json.get(`subagent:${SUB}`)
      return jsonResponse({ subagents: sub ? [sub] : [] })
    }
    if (path === `/api/subagents/${SUB}`) {
      const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
      const handler = method === 'PUT' ? subagentRoute.PUT : subagentRoute.GET
      return (await handler({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)) as Response
    }

    // Skills: the list, the whole-record PUT (a list in the body replaces the stored list), and
    // the one-agent route (one id against the list as stored; a record with no list is on for
    // every agent, so turning one off writes the user's other agents).
    if (path === '/api/slash-commands' && method === 'GET') {
      return jsonResponse({ slashCommands: [...skills.values()].map((record) => structuredClone(record)) })
    }
    const skillAccess = path.match(/^\/api\/slash-commands\/([^/]+)\/agent-access$/)
    if (skillAccess && method === 'PUT') {
      const record = skills.get(decodeURIComponent(skillAccess[1]))
      if (!record) return jsonResponse({ error: 'Slash command not found' }, 404)
      const hasList = Object.prototype.hasOwnProperty.call(record, 'enabled_agent_ids')
      const current: string[] = hasList ? [...record.enabled_agent_ids] : []
      let next: string[] | null = null
      if (!hasList) {
        if (!body.enabled) next = [AGENT, ...OTHER_AGENTS, SUB].filter((id) => id !== body.agentId)
      } else if (body.enabled && !current.includes(body.agentId)) {
        next = [...current, body.agentId]
      } else if (!body.enabled && current.includes(body.agentId)) {
        next = current.filter((id) => id !== body.agentId)
      }
      if (next) skills.set(record.id, { ...record, enabled_agent_ids: next, updated_at: new Date().toISOString() })
      return jsonResponse({ slashCommand: structuredClone(skills.get(record.id)), changed: next !== null })
    }
    const skillPut = path.match(/^\/api\/slash-commands\/([^/]+)$/)
    if (skillPut && method === 'PUT') {
      const record = skills.get(decodeURIComponent(skillPut[1]))
      if (!record) return jsonResponse({ error: 'Slash command not found' }, 404)
      const next = {
        ...record,
        ...(Array.isArray(body.enabled_agent_ids) ? { enabled_agent_ids: body.enabled_agent_ids } : {}),
        ...(typeof body.enabled_for_all_agents === 'boolean' ? { enabled_for_all_agents: body.enabled_for_all_agents } : {})
      }
      skills.set(record.id, next)
      return jsonResponse({ slashCommand: structuredClone(next) })
    }

    // Artifacts: the list, the whole-record PUT (merges the body), and the one-agent route (one
    // id against the stored list; Agent Use and the scope stay).
    if (path === '/api/artifacts' && method === 'GET') {
      return jsonResponse([...artifacts.values()].map((record) => structuredClone(record)))
    }
    const artifactAccess = path.match(/^\/api\/artifacts\/([^/]+)\/agent-access$/)
    if (artifactAccess && method === 'PUT') {
      const record = artifacts.get(decodeURIComponent(artifactAccess[1]))
      if (!record) return jsonResponse({ error: 'Artifact not found' }, 404)
      const current: string[] = Array.isArray(record.agent_allowlist) ? record.agent_allowlist : []
      const next = body.enabled
        ? current.includes(body.agentId) ? current : [...current, body.agentId]
        : current.filter((id) => id !== body.agentId)
      artifacts.set(record.id, { ...record, agent_allowlist: next })
      return jsonResponse(structuredClone(artifacts.get(record.id)))
    }
    const artifactPut = path.match(/^\/api\/artifacts\/([^/]+)$/)
    if (artifactPut && method === 'PUT') {
      const record = artifacts.get(decodeURIComponent(artifactPut[1]))
      if (!record) return jsonResponse({ error: 'Artifact not found' }, 404)
      artifacts.set(record.id, { ...record, ...body })
      return jsonResponse(structuredClone(artifacts.get(record.id)))
    }

    if (path === '/api/user/saved-models') return jsonResponse({ models: [PRESET] })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/goons') return jsonResponse({ goons: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function renderPanel(props: Record<string, unknown>) {
  return render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, ...props }
  })
}

/** Renders the panel on the probe agent and waits past the autosave debounce. */
async function openAgentPanel() {
  const view = await renderPanel({ initialAgentId: AGENT })
  await screen.findByDisplayValue('Panel probe', {}, { timeout: 15_000 })
  await waitFor(() => expect(agentReads).toBeGreaterThanOrEqual(1), { timeout: 5_000 })
  await pause(900)
  return view
}

async function openAccessTab() {
  const tab = screen.getAllByRole('tab').find((element) => /Access/.test(element.textContent ?? ''))
  expect(tab).toBeTruthy()
  await fireEvent.mouseDown(tab as HTMLElement)
  await fireEvent.click(tab as HTMLElement)
}

function accessRow(name: string) {
  const label = screen
    .getAllByText(name, { selector: '.batshit-settings-parent-label' })
    .find((element) => element.closest('.batshit-settings-toggle-row'))
  expect(label).toBeTruthy()
  return label!.closest('.batshit-settings-toggle-row') as HTMLElement
}

async function accessSwitch(name: string) {
  await waitFor(() => expect(accessRow(name)).toBeTruthy(), { timeout: 10_000 })
  return accessRow(name).querySelector('[role="switch"]') as HTMLElement
}

function sentTo(pattern: RegExp) {
  return sent.filter((entry) => pattern.test(entry.path))
}

describe('Agents > Access turns one agent on or off (BL-544, the panel half)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ensureBrowserStubs()
    installRoutes()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
    agentStore.setAgents([])
  })

  it('a skill toggle keeps an agent another panel turned on after Access loaded, and never switches Enable For All Agents', async () => {
    await redis.createAgent(probeAgent() as any)
    skills.set(SKILL, skillRecord())
    await openAgentPanel()
    await openAccessTab()
    const toggle = await accessSwitch('Ssacc Panel Skill')
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    // Skills & Prompts (or another window) turned the skill on for Orla after Access loaded.
    skills.set(SKILL, { ...skills.get(SKILL)!, enabled_agent_ids: ['ssacc_nova', 'ssacc_orla'] })

    await fireEvent.click(toggle)
    await waitFor(() => expect(sentTo(/^\/api\/slash-commands\//)).toHaveLength(1), { timeout: 5_000 })

    expect(sentTo(/^\/api\/slash-commands\//)[0]).toEqual({
      method: 'PUT',
      path: `/api/slash-commands/${SKILL}/agent-access`,
      body: { agentId: AGENT, enabled: true }
    })
    expect(skills.get(SKILL)?.enabled_agent_ids).toEqual(['ssacc_nova', 'ssacc_orla', AGENT])
    expect(skills.get(SKILL)?.enabled_for_all_agents).toBe(false)
    await waitFor(() => expect((toggle as HTMLElement).getAttribute('aria-checked')).toBe('true'))
  }, 60_000)

  it('an artifact toggle keeps an agent added elsewhere, and sends no scope', async () => {
    await redis.createAgent(probeAgent() as any)
    artifacts.set(ARTIFACT, artifactRecord())
    await openAgentPanel()
    await openAccessTab()
    const toggle = await accessSwitch('Ssacc Panel Artifact')

    // Another agent was given the artifact after Access loaded it.
    artifacts.set(ARTIFACT, { ...artifacts.get(ARTIFACT)!, agent_allowlist: ['ssacc_nova', 'ssacc_orla'] })

    await fireEvent.click(toggle)
    await waitFor(() => expect(sentTo(/^\/api\/artifacts\//)).toHaveLength(1), { timeout: 5_000 })

    expect(sentTo(/^\/api\/artifacts\//)[0]).toEqual({
      method: 'PUT',
      path: `/api/artifacts/${ARTIFACT}/agent-access`,
      body: { agentId: AGENT, enabled: true }
    })
    expect(artifacts.get(ARTIFACT)?.agent_allowlist).toEqual(['ssacc_nova', 'ssacc_orla', AGENT])
    expect(artifacts.get(ARTIFACT)?.agent_access_scope).toBe('selected')
  }, 60_000)

  it('a skill with no access list shows ON (it is on for every agent); turning it off keeps the other agents on', async () => {
    await redis.createAgent(probeAgent() as any)
    const legacy: Record<string, unknown> = skillRecord()
    delete legacy.enabled_agent_ids
    skills.set(SKILL, legacy)
    await openAgentPanel()
    await openAccessTab()
    const toggle = await accessSwitch('Ssacc Panel Skill')

    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.hasAttribute('disabled') || toggle.getAttribute('data-disabled') !== null).toBe(false)

    await fireEvent.click(toggle)
    await waitFor(() => expect(sentTo(/^\/api\/slash-commands\//)).toHaveLength(1), { timeout: 5_000 })

    expect(sentTo(/^\/api\/slash-commands\//)[0].body).toEqual({ agentId: AGENT, enabled: false })
    expect(skills.get(SKILL)?.enabled_agent_ids).toEqual([...OTHER_AGENTS, SUB])
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  }, 60_000)

  it('the basic save does not send back a voice profile a voice engine delete cleared after Settings opened', async () => {
    await redis.createAgent(
      probeAgent({
        voice_profile: { tts: { providerId: 'ssacc_engine', modelId: 'ssacc-model', voiceId: 'ssacc-voice' } }
      }) as any
    )
    await openAgentPanel()

    // Settings > Voice deletes the engine: the server clears the agent's voice (voiceEngineRegistry).
    await redis.updateAgent(AGENT, { voice_profile: null } as any)
    expect((await redis.json.get(`agent:${AGENT}`) as any).voice_profile).toBeUndefined()

    const input = document.getElementById('agent-display') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'Panel probe renamed' } })
    await waitFor(() => expect(sentTo(new RegExp(`^/api/agents/${AGENT}$`))).toHaveLength(1), { timeout: 5_000 })

    const put = sentTo(new RegExp(`^/api/agents/${AGENT}$`))[0]
    expect(put.body).toEqual({ displayName: 'Panel probe renamed' })
    await waitFor(async () => expect((await redis.json.get(`agent:${AGENT}`) as any).displayName).toBe('Panel probe renamed'), { timeout: 5_000 })
    const record = (await redis.json.get(`agent:${AGENT}`)) as any
    expect(record.displayName).toBe('Panel probe renamed')
    expect(record.voice_profile).toBeUndefined()
  }, 60_000)
})

describe('clearing a Subagent Custom System Prompt in Agent Settings (BL-482, the panel half)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ensureBrowserStubs()
    installRoutes()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
    agentStore.setAgents([])
  })

  it('sends the emptied prompt as an empty string, and the saved Subagent has no prompt', async () => {
    await redis.json.set(`subagent:${SUB}`, '$', {
      id: SUB,
      user_id: USER,
      displayName: 'Ssacc Panel Sub',
      slug: SUB,
      subagentType: 'api',
      specialty: 'general',
      system_prompt: 'Answer only in haiku.',
      created_at: '2026-09-28T00:00:00.000Z',
      updated_at: '2026-09-28T00:00:00.000Z'
    } as any)
    await redis.sAdd(`user:${USER}:subagents`, SUB)
    await redis.createAgent(probeAgent() as any)
    await openAgentPanel()

    // Pick the Subagent in the Agents & Subagents selector.
    const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
    await fireEvent.keyDown(selector, { key: 'ArrowDown' })
    const item = await screen.findByText('Ssacc Panel Sub', { selector: '.batshit-settings-action-row-title' })
    await fireEvent.click(item.closest('button') as HTMLElement)
    await screen.findByDisplayValue('Ssacc Panel Sub', {}, { timeout: 15_000 })
    await pause(900)

    const instructionsTab = screen.getAllByRole('tab').find((element) => /Instructions/.test(element.textContent ?? ''))
    expect(instructionsTab).toBeTruthy()
    await fireEvent.mouseDown(instructionsTab as HTMLElement)
    await fireEvent.click(instructionsTab as HTMLElement)
    const promptRow = screen
      .getAllByText('Custom System Prompt')
      .map((element) => element.closest('.batshit-settings-form-row') as HTMLElement | null)
      .find((row) => row && row.closest('details[name="subagent-instructions-cards"]'))
    expect(promptRow).toBeTruthy()
    await fireEvent.click(within(promptRow!).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue('Answer only in haiku.')
    await fireEvent.input(editor, { target: { value: '' } })
    const dialog = editor.closest('[role="dialog"]') as HTMLElement
    const saveButton = within(dialog)
      .getAllByRole('button')
      .find((button) => /^Save/.test((button.textContent ?? '').trim()))
    expect(saveButton).toBeTruthy()
    await fireEvent.click(saveButton as HTMLElement)

    await waitFor(() => expect(sentTo(new RegExp(`^/api/subagents/${SUB}$`))).toHaveLength(1), { timeout: 5_000 })
    const put = sentTo(new RegExp(`^/api/subagents/${SUB}$`))[0]
    expect(Object.prototype.hasOwnProperty.call(put.body, 'system_prompt')).toBe(true)
    expect(put.body.system_prompt).toBe('')
    // The stub records the PUT before the route runs, so wait for the route's own write (BL-914:
    // the route writes in a script step, which on the default lane is the twin's first call).
    await waitFor(async () => {
      const record = (await redis.json.get(`subagent:${SUB}`)) as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(record, 'system_prompt')).toBe(false)
    }, { timeout: 5_000 })
  }, 60_000)
})
