import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SlashCommandSettingsPanel from './SlashCommandSettingsPanel.svelte'

// BL-544: Settings > Skills & Prompts kept its own copy of a skill's per-agent access list
// (`enabled_agent_ids`) from the moment the skill was opened, and every autosave sent that whole
// copy back. The route replaces the list with what it is sent, so an agent turned on in
// Settings > Agents > Access after the skill was opened lost the skill again at the next
// Skills & Prompts save (a Status or Trust change). The panel never edits that list (Access owns
// it), so an edit now sends only the fields the user changed and never the list.
//
// The panel is driven against a small fake of `/api/slash-commands` that keeps the stored records
// and merges a PUT the way the real route does: a list in the body replaces the stored list.

const USER_ID = 'ssacc_user'
const SKILL_ID = 'ssacc-notes'

type StoredCommand = Record<string, any>

function storedSkill(overrides: Partial<StoredCommand> = {}): StoredCommand {
  return {
    id: SKILL_ID,
    user_id: USER_ID,
    name: SKILL_ID,
    displayName: 'Ssacc Notes',
    description: 'Probe skill for the access list tests.',
    type: 'skill',
    instructions: '',
    parameters: [],
    skill_id: 'ssacc_notes',
    skill_source: 'custom',
    skill_summary: 'Probe skill for the access list tests.',
    skill_dependencies: [],
    skill_metadata: {},
    skill_allowed_tools: [],
    skill_standards_status: 'full',
    skill_standards_issues: [],
    trust_level: 'untrusted',
    has_scripts: false,
    has_references: false,
    has_assets: false,
    invocation_pattern: '/ssacc-notes',
    can_be_attached_to_agents: false,
    can_be_invoked_in_chat: true,
    enabled_for_all_agents: false,
    enabled_agent_ids: [],
    category: 'skills',
    tags: [],
    icon_ref: null,
    usage_count: 0,
    is_active: true,
    is_system: false,
    created_at: '2026-09-28T10:00:00.000Z',
    updated_at: '2026-09-28T10:00:00.000Z',
    ...overrides
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
}

function installSlashCommandRoutes(initial: StoredCommand) {
  const records = new Map<string, StoredCommand>([[initial.id, initial]])
  const puts: Array<Record<string, any>> = []

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()

    if (url === '/api/slash-commands' && method === 'GET') {
      return jsonResponse({ slashCommands: [...records.values()].map((record) => structuredClone(record)) })
    }
    const commandId = url.startsWith('/api/slash-commands/')
      ? decodeURIComponent(url.slice('/api/slash-commands/'.length))
      : ''
    const record = records.get(commandId)
    if (record && method === 'PUT') {
      const body = JSON.parse(String(init.body))
      puts.push(body)
      // The real route's merge: every field it is sent replaces the stored one, the list too.
      const enabledAgentIds = Array.isArray(body.enabled_agent_ids) ? body.enabled_agent_ids : record.enabled_agent_ids
      const enabledForAllAgents =
        typeof body.enabled_for_all_agents === 'boolean' ? body.enabled_for_all_agents : record.enabled_for_all_agents
      const next = {
        ...record,
        ...(typeof body.is_active === 'boolean' ? { is_active: body.is_active } : {}),
        ...(body.skill?.trustLevel ? { trust_level: body.skill.trustLevel } : {}),
        enabled_agent_ids: enabledAgentIds,
        enabled_for_all_agents: enabledForAllAgents,
        can_be_attached_to_agents: enabledForAllAgents || enabledAgentIds.length > 0,
        updated_at: new Date().toISOString()
      }
      records.set(commandId, next)
      return jsonResponse({ slashCommand: structuredClone(next) })
    }
    if (url === '/api/agents') return jsonResponse({ agents: [] })
    if (url.startsWith('/api/slash-commands/cli')) return jsonResponse({ commands: [] })
    if (url.startsWith('/api/skill-sources')) return jsonResponse({ sources: [] })
    if (url.startsWith('/api/icons/library')) return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    if (method === 'GET') return jsonResponse({})
    throw new Error(`Unhandled fetch: ${method} ${url}`)
  })

  // @ts-expect-error test override
  global.fetch = fetchMock
  return { records, puts }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function openSkill() {
  const title = await screen.findByText('Ssacc Notes', { selector: '.settings-sidebar-item-title' })
  await fireEvent.click(title.closest('button') as HTMLElement)
  await screen.findByText('Active')
}

function statusSwitch() {
  const row = screen.getByText('Status', { selector: 'label' }).closest('.batshit-settings-toggle-row') as HTMLElement
  return row.querySelector('[role="switch"]') as HTMLElement
}

describe('Skills & Prompts never sends back the per-agent access list it loaded (BL-544)', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ensureBrowserStubs()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it('a Status change after Access turned the skill on for an agent keeps that agent', async () => {
    const routes = installSlashCommandRoutes(storedSkill())
    render(SlashCommandSettingsPanel, { props: { data: { user: { id: USER_ID } } } as any })
    await openSkill()

    // Settings > Agents > Access turns the skill on for Nova while this panel stays open.
    const stored = routes.records.get(SKILL_ID) as StoredCommand
    routes.records.set(SKILL_ID, { ...stored, enabled_agent_ids: ['ssacc_nova'], can_be_attached_to_agents: true })

    await fireEvent.click(statusSwitch())
    await waitFor(() => expect(routes.puts).toHaveLength(1), { timeout: 3000 })

    expect(routes.puts[0]).toEqual({ is_active: false })
    expect(routes.records.get(SKILL_ID)?.enabled_agent_ids).toEqual(['ssacc_nova'])
    expect(routes.records.get(SKILL_ID)?.is_active).toBe(false)
  })

  it('turning on Enable For All Agents sends only that switch, nothing derived from the old list', async () => {
    const routes = installSlashCommandRoutes(storedSkill({ enabled_agent_ids: [] }))
    render(SlashCommandSettingsPanel, { props: { data: { user: { id: USER_ID } } } as any })
    await openSkill()

    // Access turned the skill on for ssacc_new after the panel loaded it with no agents.
    const stored = routes.records.get(SKILL_ID) as StoredCommand
    routes.records.set(SKILL_ID, { ...stored, enabled_agent_ids: ['ssacc_new'], can_be_attached_to_agents: true })

    const row = screen.getByText('Enable For All Agents', { selector: 'p' }).closest('.batshit-settings-toggle-row') as HTMLElement
    await fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement)
    await waitFor(() => expect(routes.puts).toHaveLength(1), { timeout: 3000 })

    expect(routes.puts[0]).toEqual({ enabled_for_all_agents: true })
    expect(routes.records.get(SKILL_ID)?.enabled_agent_ids).toEqual(['ssacc_new'])
  })

  it('a built-in skill sends only the switch the user changed, never the list or the all-agents flag', async () => {
    const routes = installSlashCommandRoutes(
      storedSkill({ is_system: true, skill_source: 'system', enabled_agent_ids: ['ssacc_old'] })
    )
    render(SlashCommandSettingsPanel, { props: { data: { user: { id: USER_ID } } } as any })
    await openSkill()

    // Access took the skill away from ssacc_old after the panel loaded it.
    const stored = routes.records.get(SKILL_ID) as StoredCommand
    routes.records.set(SKILL_ID, { ...stored, enabled_agent_ids: [] })

    await fireEvent.click(statusSwitch())
    await waitFor(() => expect(routes.puts).toHaveLength(1), { timeout: 3000 })
    // Longer than the autosave debounce: the save that landed is the only one.
    await pause(900)

    expect(routes.puts).toEqual([{ is_active: false }])
    expect(routes.records.get(SKILL_ID)?.enabled_agent_ids).toEqual([])
  })
})
