import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import {
  installAgentRoutes,
  jsonResponse,
  loadAgentRoute,
  storedAgent,
  type AgentPut
} from '$lib/test-utils/agentPutRoute'

/**
 * BL-848, the chat bar half. Every save the chat bar makes of `codex_settings` and
 * `claude_settings` (the Codex and Claude mode controls, the Claude thinking control, the Codex
 * and Claude model selectors, the Codex reasoning selector) sends ONLY the keys the user changed,
 * against the agents store's copy of the block, which may be OLDER than the record (another
 * window saved since). Before, each sent the whole block, so a stale copy took back a model,
 * reasoning setting, sandbox or folder chosen elsewhere.
 *
 * Renders the REAL ChatInput (with the real selectors inside it) on the real agents store.
 * `fetch` sends `/api/agents/<id>` to the REAL route on the default lane's Redis fake, so each
 * test sees the body the browser sent and the record after the other window's change.
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

// A listed model the Codex picker offers that supports neither the Extra High reasoning effort
// nor the fast service tier (every model the list holds today supports both).
vi.mock('$lib/data/codex-models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/data/codex-models')>()
  return {
    ...actual,
    CODEX_SUBMODEL_CHOICES: [...actual.CODEX_SUBMODEL_CHOICES, { value: 'gpt-legacy-probe', label: 'GPT Legacy Probe' }]
  }
})

useRedisTestServer()

const USER = 'cbbs_user'
const AGENT = 'cbbs_agent'

/** A Codex block as the chat bar's own defaults leave it: nothing for a control to fill in. */
const CODEX_STALE = {
  permissionMode: 'chat',
  includeProjectInstructions: true,
  model: 'gpt-6-astra',
  reasoningEffort: 'default',
  serviceTier: 'standard',
  streamingEffect: true,
  search: true,
  sandbox: 'read-only',
  approval: 'never',
  addDirs: [] as string[],
  enableFeatures: [] as string[],
  disableFeatures: [] as string[],
  configOverrides: [] as unknown[],
  workingDirectoryMode: 'project',
  customWorkingDirectory: '',
  configScope: 'managed',
  unifiedExec: true,
  historyPersistence: 'none'
}

/** The same for Claude. */
const CLAUDE_STALE = {
  permissionMode: 'default',
  includeCoreSystemPrompt: false,
  includeProjectInstructions: true,
  model: 'sonnet',
  alwaysThinkingEnabled: false,
  configScope: 'managed',
  systemPromptMode: 'replace',
  systemPrompt: 'You are a helpful assistant.',
  systemPromptFile: '',
  chrome: false,
  addDirs: [] as string[],
  allowedTools: [] as string[],
  disallowedTools: [] as string[],
  configOverrides: [] as unknown[],
  workingDirectoryMode: 'project',
  customWorkingDirectory: ''
}

type Provider = 'codex' | 'claude'

const PROVIDER_FIELDS = {
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

let routeModule: Awaited<ReturnType<typeof loadAgentRoute>>
let puts: AgentPut[] = []
const originalFetch = global.fetch

beforeAll(async () => {
  routeModule = await loadAgentRoute()
}, 60_000)

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  // Unmount first: a mounted chat bar still fetches, and must not reach the real `fetch`.
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  global.fetch = originalFetch
  agentStore.setAgents([])
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The record in Redis holds `record` (what another window saved); this window's store holds
 * `stale` (an older copy) - the chat bar renders from the store.
 */
async function openChatBar(
  provider: Provider,
  blocks: { stale: Record<string, unknown> | null; record: Record<string, unknown> | null }
) {
  const { block, agent } = PROVIDER_FIELDS[provider]
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: 'Chat bar probe',
    agentType: 'cli',
    ...agent,
    [block]: blocks.record
  } as any)
  const record = await storedAgent(AGENT)
  agentStore.setAgents([{ ...record, [block]: blocks.stale } as any])
  agentStore.setCurrentAgentId(AGENT)
  const routes = installAgentRoutes({
    agentId: AGENT,
    userId: USER,
    route: routeModule,
    extra: (path) => {
      if (path === '/api/user/saved-models') return jsonResponse({ models: [] })
      if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
      if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
      return undefined
    }
  })
  puts = routes.puts
  const ChatInput = (await import('./ChatInput.svelte')).default
  render(ChatInput, { props: { data: { user: { id: USER } } } })
  await waitFor(
    () => expect(screen.getByLabelText(provider === 'codex' ? 'Codex permission mode' : 'Claude permission mode')).toBeTruthy(),
    { timeout: 15_000 }
  )
  // Past anything the opening itself would save: it must save nothing.
  await pause(100)
  expect(puts).toEqual([])
}

async function openMenu(label: string) {
  await fireEvent.keyDown(screen.getByLabelText(label), { key: 'ArrowDown' })
}

/** Opens the menu of `label` and clicks its `index`-th radio item. */
async function pickRadio(label: string, index: number) {
  await openMenu(label)
  const items = await screen.findAllByRole('menuitemradio')
  await fireEvent.click(items[index])
}

/** Opens the menu of `label` and clicks the item whose text starts with `name`. */
async function pickItem(label: string, role: 'menuitem' | 'menuitemradio', name: RegExp) {
  await openMenu(label)
  await fireEvent.click(await screen.findByRole(role, { name }))
}

async function waitForPuts(count: number) {
  await waitFor(() => expect(puts.length).toBe(count), { timeout: 5_000 })
  // Let the save reach the record and the browser copy before the next step.
  await pause(50)
}

async function waitForRecord(read: (record: Record<string, any>) => unknown, expected: unknown) {
  await waitFor(async () => expect(read(await storedAgent(AGENT))).toEqual(expected), { timeout: 5_000 })
}

describe('the chat bar sends only the Codex settings keys the user changed (BL-848)', () => {
  it('the Codex mode control sends its three keys (mode, sandbox, approval) and nothing else; a model chosen in another window survives', async () => {
    const record = { ...CODEX_STALE, model: 'gpt-5.5', reasoningEffort: 'high', addDirs: ['/elsewhere'] }
    await openChatBar('codex', { stale: CODEX_STALE, record })

    await pickRadio('Codex permission mode', 2) // Agent (full access)

    await waitForPuts(1)
    // A Codex mode is one choice of three keys: all three go out, whatever the copy shows.
    expect(puts[0].body).toEqual({
      codex_settings: { permissionMode: 'agent_full', sandbox: 'danger-full-access', approval: 'never' },
      provider_specific_settings: { codex_permission_mode: 'agent_full' }
    })
    await waitForRecord((stored) => stored.codex_settings, {
      ...record,
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access'
    })
    // The browser copy took the same keys. (Since BL-941 part C, opening the Codex menu reads the
    // record again, so the copy may also hold the other window's keys by now.)
    expect(agentStore.getAgentById(AGENT)?.codex_settings).toMatchObject({
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })
  }, 60_000)

  it('the Codex model selector sends the model alone; a sandbox chosen in another window survives', async () => {
    const record = { ...CODEX_STALE, permissionMode: 'agent', sandbox: 'workspace-write', approval: 'on-request' }
    await openChatBar('codex', { stale: CODEX_STALE, record })

    await pickItem('Codex model', 'menuitem', /GPT-6 Sol/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ codex_settings: { model: 'gpt-6-sol' } })
    await waitForRecord((stored) => stored.codex_settings, { ...record, model: 'gpt-6-sol' })
  }, 60_000)

  it('the Codex reasoning selector sends the reasoning effort alone (and its own provider key); a model chosen in another window survives', async () => {
    const record = { ...CODEX_STALE, model: 'gpt-5.5' }
    await openChatBar('codex', { stale: CODEX_STALE, record })

    await pickItem('Codex reasoning effort', 'menuitemradio', /^High/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({
      codex_settings: { reasoningEffort: 'high' },
      provider_specific_settings: { codex_reasoning_effort: 'high' }
    })
    await waitForRecord((stored) => stored.codex_settings, { ...record, reasoningEffort: 'high' })
  }, 60_000)

  it('the mode control sends its three keys even when this copy already shows that mode (the record may hold another)', async () => {
    await openChatBar('codex', { stale: CODEX_STALE, record: CODEX_STALE })

    await pickRadio('Codex permission mode', 0) // Chat, as it already is

    await waitForPuts(1)
    expect(puts[0].body).toEqual({
      codex_settings: { permissionMode: 'chat', sandbox: 'read-only', approval: 'never' },
      provider_specific_settings: { codex_permission_mode: 'chat' }
    })
  }, 60_000)

  it('the worst case: this tab shows Agent, another window set Full access, and picking Agent again writes the whole Agent mode', async () => {
    const agentMode = { permissionMode: 'agent', sandbox: 'workspace-write', approval: 'on-request' }
    const fullMode = { permissionMode: 'agent_full', sandbox: 'danger-full-access', approval: 'never' }
    await openChatBar('codex', { stale: { ...CODEX_STALE, ...agentMode }, record: { ...CODEX_STALE, ...fullMode } })

    await pickRadio('Codex permission mode', 1) // Agent (workspace write)

    await waitForPuts(1)
    expect(puts[0].body.codex_settings).toEqual(agentMode)
    // Not a mixed record: the sandbox and approval follow the mode.
    await waitForRecord((stored) => stored.codex_settings, { ...CODEX_STALE, ...agentMode })
  }, 60_000)

  it('the mild case: a pick of Full access from a tab that shows Chat sends the approval too, though it equals the copy', async () => {
    const agentMode = { permissionMode: 'agent', sandbox: 'workspace-write', approval: 'on-request' }
    await openChatBar('codex', { stale: CODEX_STALE, record: { ...CODEX_STALE, ...agentMode } })

    await pickRadio('Codex permission mode', 2) // Agent (full access)

    await waitForPuts(1)
    expect(puts[0].body.codex_settings).toEqual({
      permissionMode: 'agent_full',
      sandbox: 'danger-full-access',
      approval: 'never'
    })
    await waitForRecord((stored) => stored.codex_settings.approval, 'never')
  }, 60_000)

  it('the model selector sends the model even when the copy already shows it (the record may hold another)', async () => {
    await openChatBar('codex', { stale: CODEX_STALE, record: { ...CODEX_STALE, model: 'gpt-5.5' } })

    await pickItem('Codex model', 'menuitem', /GPT-6 Astra/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ codex_settings: { model: 'gpt-6-astra' } })
    await waitForRecord((stored) => stored.codex_settings.model, 'gpt-6-astra')
  }, 60_000)

  it('a model that supports the reasoning effort and speed another window chose leaves them alone', async () => {
    const record = { ...CODEX_STALE, reasoningEffort: 'xhigh', serviceTier: 'fast' }
    await openChatBar('codex', { stale: { ...CODEX_STALE, reasoningEffort: 'high' }, record })

    await pickItem('Codex model', 'menuitem', /GPT-6 Sol/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ codex_settings: { model: 'gpt-6-sol' } })
    await waitForRecord((stored) => stored.codex_settings, { ...record, model: 'gpt-6-sol' })
  }, 60_000)

  it('a model that supports neither Extra High nor fast: the pick sends the model with the reasoning effort and speed it needs, though they equal the copy', async () => {
    // Another window chose Extra High and fast; this tab's copy shows High and standard.
    const record = { ...CODEX_STALE, reasoningEffort: 'xhigh', serviceTier: 'fast' }
    await openChatBar('codex', { stale: { ...CODEX_STALE, reasoningEffort: 'high' }, record })

    await pickItem('Codex model', 'menuitem', /GPT Legacy Probe/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({
      codex_settings: { model: 'gpt-legacy-probe', reasoningEffort: 'high', serviceTier: 'standard' }
    })
    await waitForRecord((stored) => stored.codex_settings, {
      ...record,
      model: 'gpt-legacy-probe',
      reasoningEffort: 'high',
      serviceTier: 'standard'
    })
  }, 60_000)

  it('the reasoning selector sends the effort even when the copy already shows it (the record may hold another)', async () => {
    await openChatBar('codex', {
      stale: { ...CODEX_STALE, reasoningEffort: 'high' },
      record: { ...CODEX_STALE, reasoningEffort: 'low' }
    })

    await pickItem('Codex reasoning effort', 'menuitemradio', /^High/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({
      codex_settings: { reasoningEffort: 'high' },
      provider_specific_settings: { codex_reasoning_effort: 'high' }
    })
    await waitForRecord((stored) => stored.codex_settings.reasoningEffort, 'high')
  }, 60_000)

  it('an agent with no Codex block yet gets one whole (a create): the defaults and the change', async () => {
    await openChatBar('codex', { stale: null, record: null })

    await pickItem('Codex reasoning effort', 'menuitemradio', /^High/)

    await waitForPuts(1)
    expect(puts[0].body.codex_settings).toEqual({
      permissionMode: 'chat',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
      serviceTier: 'standard',
      streamingEffect: true,
      search: true,
      sandbox: 'read-only',
      approval: 'never',
      addDirs: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [],
      workingDirectoryMode: 'project',
      customWorkingDirectory: '',
      configScope: 'managed',
      unifiedExec: true
    })
    await waitForRecord((stored) => stored.codex_settings?.reasoningEffort, 'high')
  }, 60_000)

  it('a block saved by Agent Settings (no reasoning key) is not filled with the chat bar defaults by a model pick', async () => {
    // Agent Settings leaves reasoningEffort, serviceTier and customWorkingDirectory out of its block.
    const {
      reasoningEffort: _reasoning,
      serviceTier: _tier,
      customWorkingDirectory: _dir,
      ...panelBlock
    } = CODEX_STALE
    const record = { ...panelBlock, reasoningEffort: 'high' }
    await openChatBar('codex', { stale: panelBlock, record })

    await pickItem('Codex model', 'menuitem', /GPT-6 Sol/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ codex_settings: { model: 'gpt-6-sol' } })
    // The reasoning effort another window set is not taken back by a default the copy never held.
    await waitForRecord((stored) => stored.codex_settings, { ...record, model: 'gpt-6-sol' })
  }, 60_000)
})

describe('the chat bar sends only the Claude settings keys the user changed (BL-848)', () => {
  it('the Claude mode control sends the mode alone; a model chosen in another window survives', async () => {
    const record = { ...CLAUDE_STALE, model: 'claude-opus-5-5', chrome: true }
    await openChatBar('claude', { stale: CLAUDE_STALE, record })

    await pickItem('Claude permission mode', 'menuitemradio', /^Plan/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({
      claude_settings: { permissionMode: 'plan' },
      provider_specific_settings: { claude_permission_mode: 'plan' }
    })
    await waitForRecord((stored) => stored.claude_settings, { ...record, permissionMode: 'plan' })
  }, 60_000)

  it('the Claude model selector sends the model alone; a mode chosen in another window survives', async () => {
    const record = { ...CLAUDE_STALE, permissionMode: 'plan', chrome: true }
    await openChatBar('claude', { stale: CLAUDE_STALE, record })

    await pickItem('Claude model', 'menuitem', /Opus 5\.5/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ claude_settings: { model: 'claude-opus-5-5' } })
    await waitForRecord((stored) => stored.claude_settings, { ...record, model: 'claude-opus-5-5' })
  }, 60_000)

  it('choosing the CLI default removes the model key and nothing else', async () => {
    const record = { ...CLAUDE_STALE, permissionMode: 'plan' }
    await openChatBar('claude', { stale: CLAUDE_STALE, record })

    await pickItem('Claude model', 'menuitem', /CLI default/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ claude_settings: { model: null } })
    const { model: _removed, ...withoutModel } = record
    await waitForRecord((stored) => stored.claude_settings, withoutModel)
  }, 60_000)

  it('the Claude thinking control turns thinking on with the switch alone (the server\'s default budget applies); a model chosen in another window survives', async () => {
    const record = { ...CLAUDE_STALE, model: 'claude-opus-5-5' }
    await openChatBar('claude', { stale: CLAUDE_STALE, record })

    await pickItem('Claude thinking mode', 'menuitemradio', /Thinking on/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ claude_settings: { alwaysThinkingEnabled: true } })
    await waitForRecord((stored) => stored.claude_settings, { ...record, alwaysThinkingEnabled: true })
  }, 60_000)

  it('picking Thinking on from a copy that shows it off, while the record has it on with a budget saved elsewhere, sends the switch alone and keeps that budget', async () => {
    const record = { ...CLAUDE_STALE, alwaysThinkingEnabled: true, maxThinkingTokens: 2048 }
    await openChatBar('claude', { stale: CLAUDE_STALE, record })

    await pickItem('Claude thinking mode', 'menuitemradio', /Thinking on/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ claude_settings: { alwaysThinkingEnabled: true } })
    await waitForRecord((stored) => stored.claude_settings, record)
  }, 60_000)

  it('picking Thinking on from a copy that shows it off with a budget of its own sends the switch alone', async () => {
    const offWithBudget = { ...CLAUDE_STALE, alwaysThinkingEnabled: false, maxThinkingTokens: 3072 }
    const record = { ...CLAUDE_STALE, alwaysThinkingEnabled: true, maxThinkingTokens: 2048 }
    await openChatBar('claude', { stale: offWithBudget, record })

    await pickItem('Claude thinking mode', 'menuitemradio', /Thinking on/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ claude_settings: { alwaysThinkingEnabled: true } })
    await waitForRecord((stored) => stored.claude_settings, record)
  }, 60_000)

  it('turning thinking off removes the budget key, and sends no other key', async () => {
    const thinking = { ...CLAUDE_STALE, alwaysThinkingEnabled: true, maxThinkingTokens: 2048 }
    const record = { ...thinking, model: 'claude-opus-5-5' }
    await openChatBar('claude', { stale: thinking, record })

    await pickItem('Claude thinking mode', 'menuitemradio', /Thinking off/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ claude_settings: { alwaysThinkingEnabled: false, maxThinkingTokens: null } })
    await waitForRecord((stored) => stored.claude_settings, {
      ...CLAUDE_STALE,
      model: 'claude-opus-5-5'
    })
  }, 60_000)

  it('the Claude mode control sends the mode even when the copy already shows it (the record may hold another)', async () => {
    await openChatBar('claude', {
      stale: { ...CLAUDE_STALE, permissionMode: 'plan' },
      record: { ...CLAUDE_STALE, permissionMode: 'bypassPermissions' }
    })

    await pickItem('Claude permission mode', 'menuitemradio', /^Plan/)

    await waitForPuts(1)
    expect(puts[0].body.claude_settings).toEqual({ permissionMode: 'plan' })
    await waitForRecord((stored) => stored.claude_settings.permissionMode, 'plan')
  }, 60_000)

  it('the Claude model selector sends the model even when the copy already shows it (the record may hold another)', async () => {
    await openChatBar('claude', { stale: CLAUDE_STALE, record: { ...CLAUDE_STALE, model: 'claude-opus-5-5' } })

    await pickItem('Claude model', 'menuitem', /Sonnet \(latest alias\)/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ claude_settings: { model: 'sonnet' } })
    await waitForRecord((stored) => stored.claude_settings.model, 'sonnet')
  }, 60_000)

  it('picking Thinking on from a copy that shows it on sends the switch alone: a budget saved in another window stays', async () => {
    // The budget is not the chat bar's choice (only Agent Settings sets it): this copy shows 2048,
    // the record holds 4096 from another window.
    const shown = { ...CLAUDE_STALE, alwaysThinkingEnabled: true, maxThinkingTokens: 2048 }
    const record = { ...shown, maxThinkingTokens: 4096 }
    await openChatBar('claude', { stale: shown, record })

    await pickItem('Claude thinking mode', 'menuitemradio', /Thinking on/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ claude_settings: { alwaysThinkingEnabled: true } })
    await waitForRecord((stored) => stored.claude_settings, record)
  }, 60_000)

  it('picking Thinking on from a copy that shows it on, while the record has it off, turns it on and adds no budget', async () => {
    const shown = { ...CLAUDE_STALE, alwaysThinkingEnabled: true, maxThinkingTokens: 2048 }
    await openChatBar('claude', { stale: shown, record: CLAUDE_STALE })

    await pickItem('Claude thinking mode', 'menuitemradio', /Thinking on/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ claude_settings: { alwaysThinkingEnabled: true } })
    await waitForRecord((stored) => stored.claude_settings, { ...CLAUDE_STALE, alwaysThinkingEnabled: true })
  }, 60_000)

  it('turning thinking off from a copy that shows it off removes the budget the record holds', async () => {
    await openChatBar('claude', {
      stale: CLAUDE_STALE,
      record: { ...CLAUDE_STALE, alwaysThinkingEnabled: true, maxThinkingTokens: 4096 }
    })

    await pickItem('Claude thinking mode', 'menuitemradio', /Thinking off/)

    await waitForPuts(1)
    expect(puts[0].body).toEqual({ claude_settings: { alwaysThinkingEnabled: false, maxThinkingTokens: null } })
    await waitForRecord((stored) => stored.claude_settings, CLAUDE_STALE)
  }, 60_000)

  it('an agent with no Claude block yet gets one whole (a create)', async () => {
    await openChatBar('claude', { stale: null, record: null })

    await pickItem('Claude permission mode', 'menuitemradio', /^Plan/)

    await waitForPuts(1)
    expect(puts[0].body.claude_settings).toMatchObject({
      permissionMode: 'plan',
      alwaysThinkingEnabled: false,
      configScope: 'managed',
      addDirs: [],
      workingDirectoryMode: 'project'
    })
    expect(Object.keys(puts[0].body.claude_settings).length).toBeGreaterThan(8)
    await waitForRecord((stored) => stored.claude_settings?.permissionMode, 'plan')
  }, 60_000)
})
