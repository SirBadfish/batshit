import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { loadAgentRoute } from '$lib/test-utils/agentPutRoute'
import { isRetiredSubagentType, retiredSubagentTypeSentences } from '$lib/utils/subagentType'
import { getSubagentTimeoutValidationError } from '$lib/utils/subagentTimeout'
import { getSubagentMaxToolStepsValidationError } from '$lib/utils/subagentToolSteps'

/**
 * SA-139 R5 (D14, mounted check): the CLI Subagent type was removed (Claude Code CLI now, Codex
 * CLI in R1) and a stored one is not migrated. A leftover stays listed so it can be deleted, and
 * opening it in Agent Settings shows only its identity, the retired line and Delete: the name
 * input is disabled, every other row, card and tab is hidden, and NOTHING is written (no
 * hydration, sync or autosave turns it into something else).
 *
 * Renders the REAL panel (the harness of `AgentSettingsPanel.retiredCodexCliOpen.test.ts`).
 * `/api/agents/<id>` and `/api/subagents/<id>` go to the REAL route handlers on the default
 * lane's Redis fake, and every non-GET request the panel sends is recorded.
 */

vi.mock('$lib/server/services/managedProfileFolderDelete', () => ({
  deleteManagedProfileFolder: vi.fn(async () => {})
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))

useRedisTestServer()

const USER = 'r5cli_user'
const PROBE = 'r5cli_probe'
const SUB = 'r5cli_sub'

/** What a Claude Code CLI Subagent from before R5 carries: the provider, the connection and its old block. */
const LEFTOVER_CLAUDE_FIELDS = {
  primary_model_provider: 'anthropic-claude-cli',
  primary_model_name: 'opus',
  primary_model_connection: { id: 'claude-cli', service: 'anthropic-claude-cli', type: 'direct' },
  claude_settings: { permissionMode: 'plan', model: 'opus', chrome: false },
  provider_specific_settings: { claude_model: 'opus', nativeTools: { bashEnabled: false } }
}
/** What a Codex CLI Subagent from before R1 carries. */
const LEFTOVER_CODEX_FIELDS = {
  primary_model_provider: 'openai-codex',
  primary_model_name: 'gpt-5.1-codex',
  primary_model_connection: { id: 'codex-cli', service: 'openai-codex', type: 'direct' },
  codex_settings: { permissionMode: 'chat', includeProjectInstructions: true, model: 'gpt-5.1-codex' }
}

const CLAUDE_DETAILS = (name: string) =>
  `${name} ran on the Claude Code CLI lane, which Batshit no longer supports, so it can only be deleted. To use your Claude plan, create a new Subagent and pick a Claude plan model.`
const CODEX_DETAILS = (name: string) =>
  `${name} ran on Codex CLI, which Batshit no longer supports, so it can only be deleted. For ChatGPT models, create a new Subagent with the ChatGPT plan connection or an OpenAI API key.`

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

/** Every non-GET request the panel sent, in order. */
let sent: Array<{ method: string; path: string; body: Record<string, any> | null }> = []
const agentReads = new Map<string, number>()

function installRoutes() {
  sent = []
  agentReads.clear()
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]
    if (method !== 'GET') sent.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : null })

    if (path === '/api/agents' && method === 'GET') {
      const agent = await redis.json.get(`agent:${PROBE}`)
      return jsonResponse({ agents: agent ? [agent] : [] })
    }
    if (path === `/api/agents/${PROBE}/subagents`) return jsonResponse({ subagents: [] })
    if (path === `/api/agents/${PROBE}`) {
      const request = new Request(`http://localhost${path}`, { method, body: method === 'PUT' ? String(init.body) : undefined })
      if (method !== 'PUT') agentReads.set(PROBE, (agentReads.get(PROBE) ?? 0) + 1)
      const handler = method === 'PUT' ? agentRoute.PUT : agentRoute.GET
      return (await handler({ params: { id: PROBE }, request, locals: { user: { id: USER } } } as any)) as Response
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
    if (path === '/api/user/saved-models') return jsonResponse({ models: [] })
    if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
    if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
    if (path === '/api/goons') return jsonResponse({ ownerId: 'josh', goons: [] })
    if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
    return jsonResponse({ error: `not routed in this test: ${method} ${path}` }, 404)
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function stored(key: string) {
  return (await redis.json.get(key)) as Record<string, any>
}

async function openLeftover(displayName: string) {
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: PROBE }
  })
  await screen.findByDisplayValue('Panel probe', {}, { timeout: 15_000 })
  await waitFor(() => expect(agentReads.get(PROBE) ?? 0).toBeGreaterThanOrEqual(1), { timeout: 5_000 })
  await pause(600)
  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText(displayName, { selector: '.batshit-settings-action-row-title' })
  await fireEvent.click(item.closest('button') as HTMLElement)
  return (await screen.findByDisplayValue(displayName, {}, { timeout: 15_000 })) as HTMLInputElement
}

describe('SA-139 R5: a leftover CLI Subagent opens delete-only in Agent Settings and writes nothing', () => {
  const originalFetch = global.fetch

  beforeEach(async () => {
    agentRoute = await loadAgentRoute()
    ensureBrowserStubs()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
    agentStore.setAgents([])
  })

  it.each([
    ['a Claude Code CLI Subagent', { subagentType: 'cli', ...LEFTOVER_CLAUDE_FIELDS }, CLAUDE_DETAILS],
    ['a Codex CLI Subagent', { subagentType: 'cli', ...LEFTOVER_CODEX_FIELDS }, CODEX_DETAILS],
    // A record from before Subagent types: its Claude Code CLI fields alone make it a leftover.
    ['a typeless Claude Code CLI Subagent', { ...LEFTOVER_CLAUDE_FIELDS }, CLAUDE_DETAILS]
  ] as const)('%s shows only its identity, the retired line and Delete', async (_label, fields, details) => {
    const name = 'Old helper'
    installRoutes()
    await redis.createAgent({ id: PROBE, user_id: USER, displayName: 'Panel probe', agentType: 'api' } as any)
    await redis.json.set(`subagent:${SUB}`, '$', {
      id: SUB,
      user_id: USER,
      displayName: name,
      slug: SUB,
      specialty: 'general',
      timeout_seconds: 45,
      ...fields,
      created_at: '2026-10-20T00:00:00.000Z',
      updated_at: '2026-10-20T00:00:00.000Z'
    } as any)
    await redis.sAdd(`user:${USER}:subagents`, SUB)
    const before = await stored(`subagent:${SUB}`)

    const nameInput = await openLeftover(name)
    // Past the autosave debounces, so a save the opening queued would have gone out.
    await pause(1800)

    expect(nameInput.disabled).toBe(true)
    expect(screen.getByTestId('subagent-retired-type-notice').textContent?.trim()).toBe(details(name))
    // Every other row, card and tab is hidden.
    for (const label of ['Default Model', 'Call Timeout', 'Max Tool Steps']) {
      expect(screen.queryByText(label, { selector: 'label' }), label).toBeNull()
    }
    expect(screen.queryByRole('button', { name: /Upload Avatar/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove Avatar' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Tools' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Instructions' })).toBeNull()
    expect(screen.queryByText('Batshit Permissions & Boundaries')).toBeNull()
    expect(screen.queryByText('Instructions')).toBeNull()

    // Delete is the one action: it stays reachable, and says what it removes.
    const [deleteTrigger] = screen.getAllByRole('button', { name: 'Delete Subagent' })
    await fireEvent.click(deleteTrigger)
    await screen.findByText(/^This saved record uses a Subagent type that Batshit removed\. Deleting it is the only supported action; it also removes its managed CLI settings folder\./)
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete Subagent' }) as HTMLButtonElement[]
    expect(deleteButtons.length).toBe(2)
    expect(deleteButtons.every((button) => !button.disabled)).toBe(true)

    // No write of any kind, and the record is byte-for-byte what it was.
    expect(sent).toEqual([])
    expect(await stored(`subagent:${SUB}`)).toEqual(before)
  }, 90_000)
})

// The panel's own validator, run as the panel runs it (the callback-extraction harness of
// `AgentSettingsPanel.continuations.test.ts`): both the autosave and every editor save call it
// first, so a leftover is refused before any request is built.
function panelFunction(name: string, scope: Record<string, unknown>) {
  const source = readFileSync('src/lib/components/settings/panels/AgentSettingsPanel.svelte', 'utf8').split('<script lang="ts">')[1].split('</script>')[0]
  const file = ts.createSourceFile('panel.ts', source, ts.ScriptTarget.Latest, true)
  const fn = file.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  if (!fn) throw new Error(`Missing function ${name}`)
  const code = ts.transpileModule(fn.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function('scope', `with (scope) { ${code}; return ${name} }`)(scope) as (form: Record<string, unknown>) => string | null
}

describe('SA-139 R5: validateSubagentForm refuses a save of a leftover CLI Subagent', () => {
  const validateSubagentForm = panelFunction('validateSubagentForm', {
    isRetiredSubagentType,
    retiredSubagentTypeSentences,
    getSubagentTimeoutValidationError,
    getSubagentMaxToolStepsValidationError
  })
  const form = { displayName: 'Old helper', timeout_seconds: '', max_tool_steps: '' }

  it('refuses a Claude Code CLI and a Codex CLI leftover with its own sentence, even with a valid form', () => {
    expect(validateSubagentForm({ ...form, subagentType: 'cli', ...LEFTOVER_CLAUDE_FIELDS })).toBe(CLAUDE_DETAILS('Old helper'))
    expect(validateSubagentForm({ ...form, subagentType: 'cli', ...LEFTOVER_CODEX_FIELDS })).toBe(CODEX_DETAILS('Old helper'))
    // Before the ordinary checks: a leftover with no name is still refused as a leftover.
    expect(validateSubagentForm({ ...form, displayName: '', subagentType: 'cli' })).toBe(CLAUDE_DETAILS('This Subagent'))
  })

  it('lets a live API Subagent through to the ordinary checks', () => {
    expect(validateSubagentForm({ ...form, subagentType: 'api' })).toBeNull()
    expect(validateSubagentForm({ ...form, subagentType: 'api', displayName: ' ' })).toBe('Display name is required.')
  })
})
