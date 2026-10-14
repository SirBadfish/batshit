import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import {
  CODEX_PERMISSION_ORDER,
  CODEX_PERMISSION_PRESETS,
  CODEX_SANDBOX_LABELS
} from '$lib/utils/codexRunAccess'
import { buildCodexRuntimeSettings } from '$lib/server/services/codexSettings'
import {
  installAgentRoutes,
  jsonResponse,
  loadAgentRoute,
  storedAgent,
  type AgentPut
} from '$lib/test-utils/agentPutRoute'

/**
 * BL-848, the Agent Settings half. The Codex and Claude sections of a CLI Primary Agent sent the
 * whole `codex_settings` / `claude_settings` block on every save, from the copy the panel loaded.
 * A model, reasoning setting, sandbox or folder chosen since (the chat bar's controls, a second
 * Settings window) was taken back by the next edit of any other key, and the record now writes
 * these blocks key by key, so a key the form dropped (reasoning set back to Auto) must be named
 * as `null` or it stays saved. The panel keeps each section as it was loaded or last saved and
 * sends `diffAgentBlockWithGroups` against it: only the changed keys, a removed key as `null`, and
 * a GROUP of keys that is one choice whole when any key of it differs (BL-919: the Codex
 * `permissionMode`, `sandbox` and `approval`; Claude's `alwaysThinkingEnabled` and
 * `maxThinkingTokens`); an agent with no block yet gets the whole block, as before.
 *
 * Renders the REAL panel. `fetch` sends `/api/agents/<id>` to the REAL route on the default
 * lane's Redis fake, so each test sees the body the panel sent and the record after another
 * window's change. A CLI Subagent's sections send the same partial blocks to the Subagent route
 * (BL-914, which writes them key by key): the full Subagent coverage is
 * `AgentSettingsPanel.subagentBlockSaves.test.ts`, and one pin sits at the end of this file.
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
// A CLI Subagent's save writes its managed profile folder under the real home: not in a test.
vi.mock('$lib/server/services/cliSubagentProfileSync', () => ({
  syncManagedCliSubagentProfile: vi.fn(async () => ({ written: true })),
  deleteManagedCliSubagentProfile: vi.fn(async () => {}),
  holdManagedCliSubagentProfileFolder: vi.fn(async () => {}),
  planManagedCliSubagentProfileDeletion: vi.fn(async () => null)
}))

useRedisTestServer()

const USER = 'ssblk_user'
const AGENT = 'ssblk_agent'
const SUB = 'ssblk_sub'
const SUB_NAME = 'Ssblk Panel Sub'

/** A Codex block as the panel's own defaults leave it: nothing for a save to fill in. */
const CODEX_BASE = {
  permissionMode: 'chat',
  includeProjectInstructions: true,
  model: 'gpt-6-astra',
  streamingEffect: true,
  unifiedExec: true,
  search: true,
  sandbox: 'read-only',
  approval: 'never',
  configScope: 'managed',
  addDirs: [] as string[],
  enableFeatures: [] as string[],
  disableFeatures: [] as string[],
  configOverrides: [] as unknown[],
  workingDirectoryMode: 'project',
  historyPersistence: 'none'
}

function codexBlockWithoutSandbox(permissionMode: (typeof CODEX_PERMISSION_ORDER)[number]) {
  return { permissionMode, model: CODEX_BASE.model }
}

const CLAUDE_BASE = {
  permissionMode: 'acceptEdits',
  includeCoreSystemPrompt: false,
  includeProjectInstructions: true,
  model: 'sonnet',
  alwaysThinkingEnabled: false,
  configScope: 'managed',
  systemPromptMode: 'replace',
  chrome: false,
  addDirs: [] as string[],
  allowedTools: [] as string[],
  disallowedTools: [] as string[],
  configOverrides: [] as unknown[],
  workingDirectoryMode: 'project'
}

type Provider = 'codex' | 'claude'

const PROVIDERS = {
  codex: {
    block: 'codex_settings',
    agent: {
      primary_model_provider: 'codex',
      primary_model_name: 'gpt-6-astra',
      primary_model_connection: { type: 'cli', service: 'codex' }
    }
  },
  claude: {
    block: 'claude_settings',
    agent: {
      primary_model_provider: 'claude-cli',
      primary_model_name: 'claude-cli',
      primary_model_connection: { type: 'cli', service: 'claude-cli' }
    }
  }
} as const

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

let routeModule: Awaited<ReturnType<typeof loadAgentRoute>>
let subagentRoute: typeof import('../../../../routes/api/subagents/[id]/+server')
let puts: AgentPut[] = []
let subagentPuts: Array<{ body: Record<string, any> }> = []
let failNextPuts = 0
/** While set, the next Subagent PUT answers 500 without touching the record. */
let failNextSubagentPut = false
/** While set, the next Subagent PUT waits for it before it reaches the route (a slow round trip). */
let holdNextSubagentPut: Promise<void> | null = null
const originalFetch = global.fetch

beforeAll(async () => {
  routeModule = await loadAgentRoute()
  subagentRoute = await import('../../../../routes/api/subagents/[id]/+server')
}, 60_000)

beforeEach(() => {
  ensureBrowserStubs()
  failNextPuts = 0
  failNextSubagentPut = false
  holdNextSubagentPut = null
  subagentPuts = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  global.fetch = originalFetch
  agentStore.setAgents([])
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Creates the CLI agent (with `block` as its settings block, or none) and renders the panel on it. */
async function openPanel(provider: Provider, block: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  const { block: field, agent } = PROVIDERS[provider]
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: 'Block probe',
    agentType: 'cli',
    ...agent,
    ...(block ? { [field]: block } : {}),
    ...extra
  } as any)
  const routes = installAgentRoutes({
    agentId: AGENT,
    userId: USER,
    route: routeModule,
    failPutsWith: () => {
      if (failNextPuts > 0) {
        failNextPuts -= 1
        return 500
      }
      return null
    },
    extra: async (path, method, init) => {
      if (path === '/api/agents' && method === 'GET') return jsonResponse({ agents: [await storedAgent(AGENT)] })
      if (path === `/api/agents/${AGENT}/subagents`) return jsonResponse({ subagents: [] })
      if (path === '/api/subagents' && method === 'GET') {
        const sub = await redis.json.get(`subagent:${SUB}`)
        return jsonResponse({ subagents: sub ? [sub] : [] })
      }
      if (path === `/api/subagents/${SUB}`) {
        if (method === 'PUT') {
          subagentPuts.push({ body: JSON.parse(String(init.body)) })
          if (failNextSubagentPut) {
            failNextSubagentPut = false
            return jsonResponse({ error: 'The Subagent could not be saved just now.' }, 500)
          }
          if (holdNextSubagentPut) {
            const gate = holdNextSubagentPut
            holdNextSubagentPut = null
            await gate
          }
        }
        const request = new Request(`http://localhost${path}`, {
          method,
          body: method === 'PUT' ? String(init.body) : undefined
        })
        const handler = method === 'PUT' ? subagentRoute.PUT : subagentRoute.GET
        return (await handler({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)) as Response
      }
      if (path === '/api/user/saved-models') return jsonResponse({ models: [] })
      if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
      if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
      if (path === '/api/goons') return jsonResponse({ goons: [] })
      if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
      return undefined
    }
  })
  puts = routes.puts
  render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue('Block probe', {}, { timeout: 15_000 })
  // Past the autosave debounces, so a save the opening queued would have gone out.
  await pause(1500)
  expect(puts).toEqual([])
}

/** Another window (the chat bar, a second Settings window) changes the block after this panel loaded. */
async function changeElsewhere(provider: Provider, changes: Record<string, unknown>) {
  const { block } = PROVIDERS[provider]
  const record = await storedAgent(AGENT)
  await redis.json.set(`agent:${AGENT}`, `$.${block}`, { ...(record[block] ?? {}), ...changes } as any)
}

async function waitForPuts(count: number) {
  await waitFor(() => expect(puts.length).toBe(count), { timeout: 8_000 })
  // Let the save's answer land in the panel before the next step.
  await pause(400)
}

/** The PUTs that carry `block` (a Tool Approval pick also sends the basic form's own save). */
function putsOf(block: 'codex_settings' | 'claude_settings') {
  return puts.filter((put) => block in put.body)
}

async function waitForBlockPuts(block: 'codex_settings' | 'claude_settings', count: number) {
  await waitFor(() => expect(putsOf(block).length).toBe(count), { timeout: 8_000 })
  // Past every other save the pick queued, and the answer landing in the panel.
  await pause(1200)
  expect(putsOf(block).length).toBe(count)
}

/**
 * Another window (the chat bar, a second Settings window) saves through the REAL agent route with
 * `body`, the way the chat bar sends it. It is not one of this panel's PUTs (`puts` does not see it).
 */
async function anotherWindowSaves(body: Record<string, unknown>) {
  const request = new Request(`http://localhost/api/agents/${AGENT}`, { method: 'PUT', body: JSON.stringify(body) })
  const response = await routeModule.PUT({ params: { id: AGENT }, request, locals: { user: { id: USER } } } as any)
  expect(response.status).toBe(200)
}

/** What the chat bar's Codex mode control sends for a mode: the whole group, and the legacy mode key. */
function chatBarCodexMode(mode: 'chat' | 'agent' | 'agent_full') {
  const preset =
    mode === 'agent_full'
      ? { sandbox: 'danger-full-access', approval: 'never' }
      : mode === 'agent'
        ? { sandbox: 'workspace-write', approval: 'on-request' }
        : { sandbox: 'read-only', approval: 'never' }
  return {
    codex_settings: { permissionMode: mode, ...preset },
    provider_specific_settings: { codex_permission_mode: mode }
  }
}

/** The three keys of a Codex permission choice, as the record holds them. */
async function storedCodexTrio() {
  const { permissionMode, sandbox, approval } = (await storedAgent(AGENT)).codex_settings
  return { permissionMode, sandbox, approval }
}

describe('BL-941 Part S: stored CLI access defaults remain display-only until a choice changes', () => {
  it.each(CODEX_PERMISSION_ORDER)(
    'Codex %s with no stored sandbox shows its shared mode preset without filling or saving the block',
    async (mode) => {
      const conflictingLegacy = {
        codex_permission_mode: mode === 'agent' ? 'chat' : 'agent',
        codex_model: 'gpt-5.5',
        codex_sandbox: mode === 'agent_full' ? 'read-only' : 'danger-full-access'
      }
      await openPanel('codex', codexBlockWithoutSandbox(mode), { provider_specific_settings: conflictingLegacy })
      const record = await storedAgent(AGENT)
      const runtime = buildCodexRuntimeSettings(record.codex_settings)

      expect(selectTrigger(CODEX_SANDBOX_LABELS[runtime.sandbox])).toBeTruthy()
      expect(record.codex_settings).toEqual(codexBlockWithoutSandbox(mode))
      expect(record.codex_settings).not.toHaveProperty('sandbox')
      expect(record.provider_specific_settings).toMatchObject(conflictingLegacy)
      expect(puts).toEqual([])
    },
    90_000
  )

  it('Codex Agent (full access) with no stored sandbox fixes the Danger full access display without filling the record', async () => {
      await openPanel('codex', codexBlockWithoutSandbox('agent_full'))
      const group = screen.getByRole('group', { name: 'Codex permissions mode' })
      const fullMode = within(group).getAllByRole('radio').find((radio) => radio.getAttribute('data-value') === 'agent_full')
      const record = await storedAgent(AGENT)
      const runtime = buildCodexRuntimeSettings(record.codex_settings)
      const sandbox = selectTrigger(CODEX_SANDBOX_LABELS[runtime.sandbox])

      expect(fullMode?.getAttribute('aria-checked')).toBe('true')
      expect(fullMode?.textContent).toContain('Agent (full access)')
      expect(sandbox).toBeTruthy()
      expect(isInFlightLocked(sandbox as HTMLElement)).toBe(true)
    expect(screen.getByTestId('agent-codex-full-sandbox-note').textContent).toContain('To limit the sandbox, pick Agent.')
    expect(record.codex_settings).toEqual(codexBlockWithoutSandbox('agent_full'))
    expect(puts).toEqual([])
  }, 90_000)

  it('an invalid structured sandbox displays the shared runtime fallback without rewriting the saved value', async () => {
    const invalidSandbox = 'insecure-unknown-level'
    await openPanel('codex', { ...CODEX_BASE, permissionMode: 'agent', sandbox: invalidSandbox })
    const stored = await storedAgent(AGENT)
    const runtime = buildCodexRuntimeSettings(stored.codex_settings)

    expect(runtime.sandbox).toBe('read-only')
    expect(selectTrigger(CODEX_SANDBOX_LABELS[runtime.sandbox])).toBeTruthy()
    expect(stored.codex_settings.sandbox).toBe(invalidSandbox)
    expect(puts).toEqual([])
  }, 90_000)

  it.each(['read-only', 'workspace-write'] as const)(
    'older Agent (full access) with saved %s keeps the tight level on open and unrelated edits',
    async (savedSandbox) => {
      await openPanel('codex', { ...CODEX_BASE, permissionMode: 'agent_full', sandbox: savedSandbox })
      const group = screen.getByRole('group', { name: 'Codex permissions mode' })
      const fullMode = within(group).getAllByRole('radio').find((radio) => radio.getAttribute('data-value') === 'agent_full')
      const storedBefore = await storedAgent(AGENT)
      const runtimeBefore = buildCodexRuntimeSettings(storedBefore.codex_settings)
      const sandbox = selectTrigger(CODEX_SANDBOX_LABELS[runtimeBefore.sandbox])
      expect(fullMode?.getAttribute('aria-checked')).toBe('true')
      expect(fullMode?.textContent).toContain('Agent (full access)')
      expect(sandbox).toBeTruthy()
      expect(isInFlightLocked(sandbox as HTMLElement)).toBe(true)
      const note = screen.getByTestId('agent-codex-full-sandbox-note')
      const noteText = note.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      expect(noteText).toContain(`This agent keeps its saved ${CODEX_SANDBOX_LABELS[savedSandbox]} Sandbox Level.`)
      expect(noteText).toContain('To limit the sandbox, pick Agent.')
      expect(storedBefore.codex_settings).toMatchObject({ permissionMode: 'agent_full', sandbox: savedSandbox })
      expect(runtimeBefore.sandbox).toBe(savedSandbox)
      expect(puts).toEqual([])

      await pickSelectOption('Auto', /^High/)
      await waitForPuts(1)
      expect(putsOf('codex_settings')[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
      expect(await storedCodexTrio()).toEqual({ permissionMode: 'agent_full', sandbox: savedSandbox, approval: 'never' })
      const storedAfter = await storedAgent(AGENT)
      expect(storedAfter.codex_settings.reasoningEffort).toBe('high')
      expect(buildCodexRuntimeSettings(storedAfter.codex_settings).sandbox).toBe(savedSandbox)
      await pause(1200)
      expect(putsOf('codex_settings')).toHaveLength(1)
    },
    90_000
  )

  it.each(['read-only', 'workspace-write'] as const)(
    'an unrelated reasoning edit preserves older Agent (full access) sandbox %s',
    async (savedSandbox) => {
      await openPanel('codex', { ...CODEX_BASE, permissionMode: 'agent_full', sandbox: savedSandbox })

      await pickSelectOption('Auto', /^High/)
      await waitForBlockPuts('codex_settings', 1)

      expect(putsOf('codex_settings')[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
      expect(await storedCodexTrio()).toEqual({ permissionMode: 'agent_full', sandbox: savedSandbox, approval: 'never' })
      const stored = await storedAgent(AGENT)
      expect(stored.codex_settings.reasoningEffort).toBe('high')
      expect(buildCodexRuntimeSettings(stored.codex_settings).sandbox).toBe(savedSandbox)
    },
    90_000
  )

  it('a missing structured Codex block keeps its legacy mode, model, and saved sandbox on open', async () => {
    const legacy = {
      codex_permission_mode: 'agent_full',
      codex_model: 'gpt-5.5',
      codex_sandbox: 'workspace-write'
    }
    await openPanel('codex', null, { provider_specific_settings: legacy })
    const group = screen.getByRole('group', { name: 'Codex permissions mode' })
    const fullMode = within(group).getAllByRole('radio').find((radio) => radio.getAttribute('data-value') === 'agent_full')
    const sandbox = selectTrigger(CODEX_SANDBOX_LABELS['workspace-write'])

    expect(fullMode?.getAttribute('aria-checked')).toBe('true')
    expect(fullMode?.textContent).toContain('Agent (full access)')
    expect(sandbox).toBeTruthy()
    expect(isInFlightLocked(sandbox as HTMLElement)).toBe(true)
    const stored = await storedAgent(AGENT)
    expect(stored).not.toHaveProperty('codex_settings')
    expect(stored.provider_specific_settings).toMatchObject(legacy)
    const runtime = buildCodexRuntimeSettings(stored.provider_specific_settings)
    expect(CODEX_SANDBOX_LABELS[runtime.sandbox]).toBe('Workspace write')
    expect(selectTrigger(CODEX_SANDBOX_LABELS[runtime.sandbox])).toBeTruthy()
    expect(puts).toEqual([])
  }, 90_000)

  it.each(['default', 'chat'] as const)(
    'Claude saved %s displays Ask before edits without rewriting the stored block',
    async (mode) => {
      await openPanel('claude', { ...CLAUDE_BASE, permissionMode: mode })
      const group = screen.getByRole('group', { name: 'Claude permissions mode' })
      const ask = within(group).getByRole('radio', { name: /Ask before edits/ })

      expect(ask.getAttribute('aria-checked')).toBe('true')
      expect((await storedAgent(AGENT)).claude_settings.permissionMode).toBe(mode)
      expect(puts).toEqual([])
    },
    90_000
  )

  it('an explicit Claude Plan to Ask before edits choice saves the canonical default value', async () => {
    await openPanel('claude', { ...CLAUDE_BASE, permissionMode: 'plan' })
    expect(puts).toEqual([])

    await pickPermissionMode('claude', /Ask before edits/)

    await waitForBlockPuts('claude_settings', 1)
    expect(putsOf('claude_settings')[0].body).toEqual({ claude_settings: { permissionMode: 'default' } })
    expect((await storedAgent(AGENT)).claude_settings.permissionMode).toBe('default')
    expect(putsOf('claude_settings')).toHaveLength(1)
  }, 90_000)
})

/** The permissions mode toggle of the section (an item by its visible label). */
async function pickPermissionMode(provider: Provider, label: RegExp) {
  const group = screen.getByRole('group', { name: provider === 'codex' ? 'Codex permissions mode' : 'Claude permissions mode' })
  await fireEvent.click(within(group).getByRole('radio', { name: label }))
}

/**
 * Picks an option of the select whose visible value is `current`. The popper stays
 * `visibility: hidden` in jsdom (no layout), so its options have no accessible name: they are
 * found hidden and picked by their text.
 */
function selectTrigger(current: string) {
  return screen
    .getAllByRole('button', { hidden: true })
    .find((element) => element.hasAttribute('data-select-trigger') && (element.textContent ?? '').trim() === current)
}

async function pickSelectOption(current: string, optionText: RegExp) {
  const trigger = selectTrigger(current)
  expect(trigger, `the select showing "${current}"`).toBeTruthy()
  await fireEvent.keyDown(trigger as HTMLElement, { key: 'ArrowDown' })
  await waitFor(() => expect(screen.queryAllByRole('option', { hidden: true }).length).toBeGreaterThan(0))
  const option = screen
    .getAllByRole('option', { hidden: true })
    .find((element) => optionText.test((element.textContent ?? '').trim()))
  expect(option, `an option matching ${optionText}`).toBeTruthy()
  await fireEvent.pointerUp(option as HTMLElement, { pointerType: 'mouse' })
}

/** The switch in the row that carries `label` (the nearest ancestor of the text that holds a switch). */
function switchOf(label: string) {
  for (let element = screen.getByText(label) as HTMLElement | null; element; element = element.parentElement) {
    const found = element.querySelector('[role="switch"]')
    if (found) return found as HTMLElement
  }
  throw new Error(`no switch beside "${label}"`)
}

function isInFlightLocked(element: HTMLElement | null) {
  return Boolean(element && (element.matches(':disabled') || element.closest('fieldset:disabled, [inert]')))
}

describe('Agent Settings sends only the Codex settings keys the user changed (BL-848)', () => {
  it('a reasoning pick sends the reasoning effort alone; a model and a folder saved in another window survive', async () => {
    await openPanel('codex', CODEX_BASE)
    await changeElsewhere('codex', { model: 'gpt-5.5', addDirs: ['/elsewhere'] })

    await pickSelectOption('Auto', /^High/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
    expect((await storedAgent(AGENT)).codex_settings).toEqual({
      ...CODEX_BASE,
      model: 'gpt-5.5',
      addDirs: ['/elsewhere'],
      reasoningEffort: 'high'
    })
    // The agents store copy (the chat bar reads it) took the same key over the block it held.
    expect(agentStore.getAgentById(AGENT)?.codex_settings).toEqual({ ...CODEX_BASE, reasoningEffort: 'high' })
  }, 90_000)

  it('the permissions mode sends the whole group (mode, sandbox, approval); a reasoning setting saved in another window survives, and so does no mix (BL-919)', async () => {
    await openPanel('codex', CODEX_BASE)
    // Another window picked Agent (its sandbox and approval) and set a reasoning effort.
    await changeElsewhere('codex', {
      permissionMode: 'agent',
      sandbox: 'workspace-write',
      approval: 'on-request',
      reasoningEffort: 'high'
    })

    await pickPermissionMode('codex', /^Agent \(full access\)/)

    await waitForPuts(1)
    expect(puts[0].body.codex_settings).toEqual({
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })
    expect((await storedAgent(AGENT)).codex_settings).toEqual({
      ...CODEX_BASE,
      reasoningEffort: 'high',
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })
  }, 90_000)

  it('a key the form drops is named as null, so it is removed (reasoning set back to Auto)', async () => {
    await openPanel('codex', { ...CODEX_BASE, reasoningEffort: 'high' })

    await pickSelectOption('High', /^Auto/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ codex_settings: { reasoningEffort: null } })
    expect((await storedAgent(AGENT)).codex_settings).toEqual(CODEX_BASE)
  }, 90_000)

  it('each later edit sends only its own key: the baseline moves to what the last save stored', async () => {
    await openPanel('codex', CODEX_BASE)

    await pickSelectOption('Auto', /^High/)
    await waitForPuts(1)
    await pickPermissionMode('codex', /^Agent \(full access\)/)
    await waitForPuts(2)

    expect(puts[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
    // The mode pick is a group: it goes out whole (BL-919), the reasoning effort not again.
    expect(puts[1].body.codex_settings).toEqual({
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })
  }, 90_000)

  it('a failed save leaves the baseline as it was: the next edit sends the failed change again, with its own', async () => {
    await openPanel('codex', CODEX_BASE)

    failNextPuts = 1
    await pickSelectOption('Auto', /^High/)
    await waitForPuts(1)
    expect((await storedAgent(AGENT)).codex_settings.reasoningEffort).toBeUndefined()

    await pickPermissionMode('codex', /^Agent \(full access\)/)
    await waitForPuts(2)
    expect(puts[1].body.codex_settings).toEqual({
      reasoningEffort: 'high',
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })
    expect((await storedAgent(AGENT)).codex_settings).toMatchObject({ reasoningEffort: 'high', permissionMode: 'agent_full' })
  }, 90_000)

  it('a block that names only some keys is not filled in with defaults: an edit adds its own key alone', async () => {
    await openPanel('codex', { model: 'gpt-5.5', permissionMode: 'chat' })

    await pickSelectOption('Auto', /^High/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
    expect((await storedAgent(AGENT)).codex_settings).toEqual({
      model: 'gpt-5.5',
      permissionMode: 'chat',
      reasoningEffort: 'high'
    })
  }, 90_000)

  it('an agent with no Codex block yet gets the whole block on its first edit (older settings are kept in it)', async () => {
    await openPanel('codex', null, { provider_specific_settings: { codex_model: 'gpt-5.5' } })

    await pickSelectOption('Auto', /^High/)

    await waitForPuts(1)
    const sent = puts[0].body.codex_settings
    expect(sent).toMatchObject({
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      permissionMode: 'chat',
      sandbox: 'read-only',
      approval: 'never',
      // What the older provider settings say (`codex_include_project_instructions` is not set).
      includeProjectInstructions: false
    })
    expect((await storedAgent(AGENT)).codex_settings).toMatchObject({ model: 'gpt-5.5', reasoningEffort: 'high', permissionMode: 'chat' })
  }, 90_000)

  it('a change only the derived approval key sees sends the whole group (the shared approval policy in Agent mode; BL-919)', async () => {
    await openPanel('codex', { ...CODEX_BASE, permissionMode: 'agent', sandbox: 'workspace-write' })

    await pickSelectOption('Never', /^On Request/)

    await waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(1), { timeout: 8_000 })
    await pause(1200)
    const codexPuts = puts.filter((put) => 'codex_settings' in put.body)
    expect(codexPuts).toHaveLength(1)
    expect(codexPuts[0].body).toEqual({
      codex_settings: { permissionMode: 'agent', sandbox: 'workspace-write', approval: 'on-request' }
    })
  }, 90_000)
})

/**
 * Holds the next PUT to the agent until `release()` (a slow round trip). `started()` counts the
 * PUTs that reached the hold.
 */
function holdNextAgentPut() {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const inner = global.fetch
  let held = false
  let started = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!held && (init.method ?? 'GET').toUpperCase() === 'PUT' && url.split('?')[0] === `/api/agents/${AGENT}`) {
        held = true
        started += 1
        await gate
      }
      return inner(input, init)
    })
  )
  return { release, started: () => started }
}

describe('a save that lands does not put the loaded section over what was changed while it was in flight (BL-848)', () => {
  it('a Codex choice stays read-only during its save, then a deliberate next choice saves separately', async () => {
    await openPanel('codex', CODEX_BASE)
    const hold = holdNextAgentPut()

    await pickSelectOption('Auto', /^High/)
    await waitFor(() => expect(hold.started()).toBe(1), { timeout: 8_000 })
    const fullMode = within(screen.getByRole('group', { name: 'Codex permissions mode' }))
      .getByRole('radio', { name: /^Agent \(full access\)/ })
    await waitFor(() => expect(isInFlightLocked(fullMode)).toBe(true), { timeout: 8_000 })
    // Native activation honors the disabled fieldset; fireEvent bypasses that browser rule.
    fullMode.click()
    await pause(50)
    expect(fullMode.getAttribute('aria-checked')).toBe('false')

    hold.release()
    await waitForPuts(1)
    expect(puts[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
    await waitFor(async () => expect((await storedAgent(AGENT)).codex_settings.reasoningEffort).toBe('high'), {
      timeout: 8_000
    })
    await waitFor(() => expect(isInFlightLocked(fullMode)).toBe(false), { timeout: 8_000 })

    await pickPermissionMode('codex', /^Agent \(full access\)/)
    await waitForPuts(2)
    expect(puts[1].body.codex_settings).toEqual({
      permissionMode: 'agent_full', sandbox: 'danger-full-access', approval: 'never'
    })
    expect((await storedAgent(AGENT)).codex_settings).toMatchObject({
      reasoningEffort: 'high', permissionMode: 'agent_full', sandbox: 'danger-full-access'
    })
    await pause(1000)
    expect(puts).toHaveLength(2)
  }, 90_000)
})

describe('Agent Settings sends only the Claude settings keys the user changed (BL-848)', () => {
  it('the permissions mode sends the mode alone; a model saved in another window survives', async () => {
    await openPanel('claude', CLAUDE_BASE)
    await changeElsewhere('claude', { model: 'opus', addDirs: ['/elsewhere'] })

    await pickPermissionMode('claude', /Plan/i)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ claude_settings: { permissionMode: 'plan' } })
    expect((await storedAgent(AGENT)).claude_settings).toEqual({
      ...CLAUDE_BASE,
      model: 'opus',
      addDirs: ['/elsewhere'],
      permissionMode: 'plan'
    })
  }, 90_000)

  it('turning extended thinking on names its budget; turning it off removes the budget (a dropped key goes as null)', async () => {
    await openPanel('claude', CLAUDE_BASE)

    const thinkingSwitch = switchOf('Always Enable Extended Thinking')
    await fireEvent.click(thinkingSwitch)
    await waitForPuts(1)
    expect(puts[0].body.claude_settings).toMatchObject({ alwaysThinkingEnabled: true })
    expect(typeof puts[0].body.claude_settings.maxThinkingTokens).toBe('number')
    expect(Object.keys(puts[0].body.claude_settings).sort()).toEqual(['alwaysThinkingEnabled', 'maxThinkingTokens'])

    await fireEvent.click(thinkingSwitch)
    await waitForPuts(2)
    expect(puts[1].body).toEqual({ claude_settings: { alwaysThinkingEnabled: false, maxThinkingTokens: null } })
    const stored = (await storedAgent(AGENT)).claude_settings
    expect(stored.alwaysThinkingEnabled).toBe(false)
    expect('maxThinkingTokens' in stored).toBe(false)
    // The agents store copy took the removal too.
    const copy = agentStore.getAgentById(AGENT)?.claude_settings as Record<string, unknown>
    expect(copy.alwaysThinkingEnabled).toBe(false)
    expect('maxThinkingTokens' in copy).toBe(false)
    expect(copy.model).toBe('sonnet')
  }, 90_000)

  it('a failed save leaves the baseline as it was: the next edit sends the failed change again, with its own', async () => {
    await openPanel('claude', CLAUDE_BASE)

    failNextPuts = 1
    await pickPermissionMode('claude', /Plan/i)
    await waitForPuts(1)
    expect((await storedAgent(AGENT)).claude_settings.permissionMode).toBe('acceptEdits')

    await fireEvent.click(switchOf('Always Enable Extended Thinking'))
    await waitForPuts(2)
    expect(puts[1].body.claude_settings).toMatchObject({ permissionMode: 'plan', alwaysThinkingEnabled: true })
  }, 90_000)

  it('an agent with no Claude block yet gets the whole block on its first edit', async () => {
    await openPanel('claude', null, { provider_specific_settings: { claude_model: 'opus' } })

    await pickPermissionMode('claude', /Plan/i)

    await waitForPuts(1)
    expect(puts[0].body.claude_settings).toMatchObject({
      model: 'opus',
      permissionMode: 'plan',
      includeProjectInstructions: true,
      configScope: 'managed'
    })
  }, 90_000)
})

/**
 * BL-919. A Codex permission choice is ONE choice of three keys (`permissionMode`, `sandbox`,
 * `approval`); the run reads the saved mode and sandbox, and derives its approval from the mode and
 * Tool Approval (the saved approval reaches only the managed config file). Settings holds its own
 * copy of the block from when it loaded, so a pick sent only the keys that differed from it and a
 * key that equaled that older copy was left out: when the chat bar (or another window) had picked
 * another mode since, the record ended as a MIX of the two picks. Now a change to any of the three
 * sends all three, whatever the copy says (the chat bar's rule, `chatBarBlockSave`'s `group`); a key
 * outside the group is still sent by difference. Claude's thinking switch and its budget are the
 * same kind of pair. The "other window" writes through the real agent route, the way the chat bar does.
 */
describe('a Codex permission choice never leaves a mixed record (BL-919)', () => {
  it('condition A: the chat bar picked Agent after Settings loaded; the older Settings picks Agent (full access): the record holds ONE mode', async () => {
    await openPanel('codex', CODEX_BASE)
    await anotherWindowSaves(chatBarCodexMode('agent'))
    expect(await storedCodexTrio()).toEqual({
      permissionMode: 'agent',
      sandbox: 'workspace-write',
      approval: 'on-request'
    })

    await pickPermissionMode('codex', /^Agent \(full access\)/)

    await waitForBlockPuts('codex_settings', 1)
    // Settings shows Agent (full access): no approval prompts, full access. The record must say the same.
    expect(await storedCodexTrio()).toEqual({
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })
    expect(putsOf('codex_settings')[0].body.codex_settings).toEqual({
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })
  }, 90_000)

  it('condition B: another window picked Agent (full access); the older Settings (Chat, a sandbox chosen by hand) picks Agent: no looser sandbox than the screen shows', async () => {
    // Chat mode with the Workspace write sandbox chosen by hand.
    await openPanel('codex', { ...CODEX_BASE, sandbox: 'workspace-write' })
    await anotherWindowSaves(chatBarCodexMode('agent_full'))
    expect(await storedCodexTrio()).toEqual({
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })

    await pickPermissionMode('codex', /^Agent$/)

    await waitForBlockPuts('codex_settings', 1)
    // Settings shows Agent with Workspace write and tool approval Off.
    expect(await storedCodexTrio()).toEqual({
      permissionMode: 'agent',
      sandbox: 'workspace-write',
      approval: 'never'
    })
    expect(putsOf('codex_settings')[0].body.codex_settings).toEqual({
      permissionMode: 'agent',
      sandbox: 'workspace-write',
      approval: 'never'
    })
  }, 90_000)

  it('a sandbox-only edit in an older window sends the whole group', async () => {
    await openPanel('codex', CODEX_BASE)
    await anotherWindowSaves(chatBarCodexMode('agent_full'))

    await pickSelectOption('Read-only', /^Workspace write/)

    await waitForBlockPuts('codex_settings', 1)
    // Settings shows Chat with Workspace write; nothing of the other window's Agent (full access) stays.
    expect(await storedCodexTrio()).toEqual({
      permissionMode: 'chat',
      sandbox: 'workspace-write',
      approval: 'never'
    })
    expect(putsOf('codex_settings')[0].body.codex_settings).toEqual({
      permissionMode: 'chat',
      sandbox: 'workspace-write',
      approval: 'never'
    })
  }, 90_000)

  it('an approval-only edit in an older window sends the whole group', async () => {
    await openPanel('codex', { ...CODEX_BASE, permissionMode: 'agent', sandbox: 'workspace-write' })
    await anotherWindowSaves(chatBarCodexMode('agent_full'))

    await pickSelectOption('Never', /^On Request/)

    await waitForBlockPuts('codex_settings', 1)
    // Settings shows Agent, Workspace write, ask when needed.
    expect(await storedCodexTrio()).toEqual({
      permissionMode: 'agent',
      sandbox: 'workspace-write',
      approval: 'on-request'
    })
    expect(putsOf('codex_settings')[0].body.codex_settings).toEqual({
      permissionMode: 'agent',
      sandbox: 'workspace-write',
      approval: 'on-request'
    })
  }, 90_000)

  it('a change OUTSIDE the group still goes alone: a reasoning pick leaves another window\'s mode as it is', async () => {
    await openPanel('codex', CODEX_BASE)
    await anotherWindowSaves(chatBarCodexMode('agent_full'))

    await pickSelectOption('Auto', /^High/)

    await waitForBlockPuts('codex_settings', 1)
    expect(putsOf('codex_settings')[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
    expect(await storedCodexTrio()).toEqual({
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })
    expect((await storedAgent(AGENT)).codex_settings.reasoningEffort).toBe('high')
  }, 90_000)

  it("a FRESH Settings after a chat-bar Agent pick starts from the derived approval: a sandbox-only edit writes approval never with the sandbox (intended: the screen's choice; the chat bar's fixed on-request and Settings' derived approval disagree, a known separate bug)", async () => {
    // The chat bar's Agent preset writes approval on-request whatever Tool Approval says
    // (`ChatInput.svelte`), and this Settings opens after it. Tool Approval is Off, so Settings
    // derives its approval from it: never (hydrate, and `resolveCodexApprovalPolicy`).
    await openPanel('codex', { ...CODEX_BASE, ...chatBarCodexMode('agent').codex_settings })
    expect(await storedCodexTrio()).toEqual({
      permissionMode: 'agent',
      sandbox: 'workspace-write',
      approval: 'on-request'
    })

    await pickSelectOption('Workspace write', /^Read-only/)

    await waitForBlockPuts('codex_settings', 1)
    // Settings shows Agent, Read-only and an Approval Policy of Never: the whole trio goes out, so
    // the record says what the screen shows, on-request replaced. This pins that as intended; the
    // disagreement between the chat bar's preset and Settings' derived approval is a separate bug.
    expect(putsOf('codex_settings')[0].body.codex_settings).toEqual({
      permissionMode: 'agent',
      sandbox: 'read-only',
      approval: 'never'
    })
    expect(await storedCodexTrio()).toEqual({
      permissionMode: 'agent',
      sandbox: 'read-only',
      approval: 'never'
    })
  }, 90_000)

  it('Claude: another window turned thinking Off; the older Settings edits the budget: the switch and the budget go out together', async () => {
    await openPanel('claude', { ...CLAUDE_BASE, alwaysThinkingEnabled: true, maxThinkingTokens: 4000 })
    // The chat bar's thinking control Off: the switch and a removed budget.
    await anotherWindowSaves({ claude_settings: { alwaysThinkingEnabled: false, maxThinkingTokens: null } })
    const before = (await storedAgent(AGENT)).claude_settings
    expect(before.alwaysThinkingEnabled).toBe(false)
    expect('maxThinkingTokens' in before).toBe(false)

    await fireEvent.input(screen.getByPlaceholderText('1024'), { target: { value: '5000' } })

    await waitForBlockPuts('claude_settings', 1)
    // Settings shows thinking On with a budget of 5000: the record must not hold Off with a budget.
    const stored = (await storedAgent(AGENT)).claude_settings
    expect({ alwaysThinkingEnabled: stored.alwaysThinkingEnabled, maxThinkingTokens: stored.maxThinkingTokens }).toEqual({
      alwaysThinkingEnabled: true,
      maxThinkingTokens: 5000
    })
    expect(putsOf('claude_settings')[0].body).toEqual({
      claude_settings: { alwaysThinkingEnabled: true, maxThinkingTokens: 5000 }
    })
  }, 90_000)

  it('Claude: a change outside the thinking pair still goes alone: a mode pick leaves another window\'s thinking Off', async () => {
    await openPanel('claude', { ...CLAUDE_BASE, alwaysThinkingEnabled: true, maxThinkingTokens: 4000 })
    await anotherWindowSaves({ claude_settings: { alwaysThinkingEnabled: false, maxThinkingTokens: null } })

    await pickPermissionMode('claude', /Plan/i)

    await waitForBlockPuts('claude_settings', 1)
    expect(putsOf('claude_settings')[0].body).toEqual({ claude_settings: { permissionMode: 'plan' } })
    const stored = (await storedAgent(AGENT)).claude_settings
    expect(stored.alwaysThinkingEnabled).toBe(false)
    expect('maxThinkingTokens' in stored).toBe(false)
  }, 90_000)
})

/** Seeds a CLI Subagent (Codex) beside the probe agent, renders the panel and selects the Subagent. */
async function openCliSubagent() {
  await redis.json.set(`subagent:${SUB}`, '$', {
    id: SUB,
    user_id: USER,
    displayName: SUB_NAME,
    slug: SUB,
    subagentType: 'cli',
    specialty: 'general',
    primary_model_provider: 'codex',
    primary_model_name: 'gpt-6-astra',
    primary_model_connection: { type: 'cli', service: 'codex' },
    codex_settings: CODEX_BASE,
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z'
  } as any)
  await redis.sAdd(`user:${USER}:subagents`, SUB)
  await openPanel('codex', CODEX_BASE)

  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents' })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText(SUB_NAME, { selector: '.batshit-settings-action-row-title' })
  await fireEvent.click(item.closest('button') as HTMLElement)
  await screen.findByDisplayValue(SUB_NAME, {}, { timeout: 15_000 })
  await pause(1500)
  expect(subagentPuts).toEqual([])
}

async function storedSubagent() {
  return (await redis.json.get(`subagent:${SUB}`)) as Record<string, any>
}

describe('a CLI Subagent\'s Codex settings go by difference too (BL-914: the Subagent route writes the block key by key)', () => {
  it('a reasoning pick on a CLI Subagent sends only the reasoning, to the Subagent route (the Primary Agent route is not used)', async () => {
    await openCliSubagent()

    await pickSelectOption('Auto', /^High/)

    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    await pause(400)
    expect(subagentPuts[0].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
    // The record holds the whole block: the other keys were not named, so they stayed.
    expect(await storedSubagent()).toMatchObject({ codex_settings: { ...CODEX_BASE, reasoningEffort: 'high' } })
    // The Primary Agent route was not used for it.
    expect(puts).toEqual([])
  }, 120_000)
})

describe('a Subagent section save that lands leaves an unsaved core edit alone (BL-844, re-review fix)', () => {
  it('a Codex save landing while a name is typed but not saved: the name stays in the field, and the next save sends exactly it', async () => {
    await openCliSubagent()
    let release: () => void = () => {}
    holdNextSubagentPut = new Promise<void>((resolve) => {
      release = resolve
    })

    await pickSelectOption('Auto', /^High/)
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(Object.keys(subagentPuts[0].body)).toEqual(['codex_settings'])

    // A core field is typed while the Codex save is in flight; its own save waits in its debounce.
    const nameInput = screen.getByDisplayValue(SUB_NAME) as HTMLInputElement
    await fireEvent.input(nameInput, { target: { value: 'Ssblk R' } })
    release()

    await waitFor(async () => expect((await storedSubagent()).codex_settings.reasoningEffort).toBe('high'), {
      timeout: 8_000
    })
    await pause(200)
    expect(subagentPuts.length).toBe(1)
    expect(nameInput.value).toBe('Ssblk R')

    await waitFor(() => expect(subagentPuts.length).toBe(2), { timeout: 8_000 })
    expect(subagentPuts[1].body).toEqual({ displayName: 'Ssblk R' })
    await pause(500)
    const record = await storedSubagent()
    expect(record.displayName).toBe('Ssblk R')
    expect(record.codex_settings.reasoningEffort).toBe('high')
    expect(nameInput.value).toBe('Ssblk R')
    // Nothing follows: the form equals what was saved.
    await pause(1200)
    expect(subagentPuts.length).toBe(2)
  }, 120_000)

  it('a core save that failed, then a Codex save that works: the failed text is still in the field, the error stays, and the next core edit sends it again', async () => {
    await openCliSubagent()

    failNextSubagentPut = true
    const nameInput = screen.getByDisplayValue(SUB_NAME) as HTMLInputElement
    await fireEvent.input(nameInput, { target: { value: 'Ssblk R' } })
    await waitFor(() => expect(subagentPuts.length).toBe(1), { timeout: 8_000 })
    expect(subagentPuts[0].body).toEqual({ displayName: 'Ssblk R' })
    expect(await screen.findByText(/could not be saved just now/)).toBeTruthy()

    await pickSelectOption('Auto', /^High/)
    await waitFor(() => expect(subagentPuts.length).toBe(2), { timeout: 8_000 })
    expect(Object.keys(subagentPuts[1].body)).toEqual(['codex_settings'])
    await pause(1500)

    // The Codex save worked; the failed name is still in the field, was not marked as saved, and its
    // error is still on screen (nothing sent it again yet).
    expect(nameInput.value).toBe('Ssblk R')
    expect((await storedSubagent()).displayName).toBe(SUB_NAME)
    expect(screen.getByText(/could not be saved just now/)).toBeTruthy()
    expect(subagentPuts.length).toBe(2)

    // The next core edit sends the failed name again, with its own change.
    await fireEvent.input(document.getElementById('subagent-timeout') as HTMLInputElement, { target: { value: '60' } })
    await waitFor(() => expect(subagentPuts.length).toBe(3), { timeout: 8_000 })
    expect(subagentPuts[2].body).toEqual({ displayName: 'Ssblk R', timeout_seconds: 60 })
    await pause(400)
    expect((await storedSubagent()).displayName).toBe('Ssblk R')
  }, 120_000)
})
