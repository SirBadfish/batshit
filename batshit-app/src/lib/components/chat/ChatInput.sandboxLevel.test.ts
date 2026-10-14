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
 * BL-941 part C, the chat bar. The agent's SAVED record is the upper bound of a Codex or Claude
 * run: a send runs with the tighter of the chat bar's mode and the record's mode, and for Codex
 * with the tighter of that mode's own Sandbox Level and the saved level (part 1, `9deecc895`).
 * (a) The chat bar shows the level a send runs with when it is not the mode's own level (Agent
 *     Settings saved a tighter one by hand), so the screen says what runs: a line under the chosen
 *     mode INSIDE the mode menu, never in the chip (Josh, 2026-09-29: no more width in the chat
 *     bar). The chip keeps its label, its accessible name, and its tooltip. Opening the menu reads
 *     the record again, so a level another window changed is not shown from an older copy.
 * (b) A send waits for the chat bar's own mode save: the page's copy takes a pick at once, the
 *     server reads the saved record, so a send made before a looser pick landed would run with the
 *     older record, and one made before a failed save would carry a mode that was never saved.
 *
 * Renders the REAL ChatInput on the real agents store; `fetch` sends `/api/agents/<id>` to the
 * REAL route on the default lane's Redis fake (the harness of `ChatInput.blockSaves.test.ts`).
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

useRedisTestServer()

const USER = 'cbsl_user'
const AGENT = 'cbsl_agent'

/** A whole Codex block, as Agent Settings and the chat bar write it. */
function codexBlock(permissionMode: string, sandbox?: string) {
  return {
    permissionMode,
    includeProjectInstructions: true,
    model: 'gpt-6-astra',
    reasoningEffort: 'default',
    serviceTier: 'standard',
    streamingEffect: true,
    search: true,
    ...(sandbox ? { sandbox } : {}),
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
}

const CLAUDE_BLOCK = {
  permissionMode: 'plan',
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
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  global.fetch = originalFetch
  agentStore.setAgents([])
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Gate = { promise: Promise<void>; open: () => void }
function gate(): Gate {
  let open = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

async function openChatBar(
  provider: 'codex' | 'claude',
  block: Record<string, unknown> | null,
  options: {
    onSend?: (message: string, metadata?: any) => boolean
    holdPuts?: () => Promise<void> | null
    failPutsWith?: () => number | null
    /** This window's older copy of the block (another window saved `block` since). */
    staleBlock?: Record<string, unknown>
    /** The agent's own older prefixed keys (a record with no block). */
    providerSettings?: Record<string, unknown>
  } = {}
) {
  const fields = PROVIDER_FIELDS[provider]
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: 'Sandbox level probe',
    agentType: 'cli',
    ...fields.agent,
    ...(block ? { [fields.block]: block } : {}),
    ...(options.providerSettings ? { provider_specific_settings: options.providerSettings } : {})
  } as any)
  const record = (await storedAgent(AGENT)) as any
  agentStore.setAgents([options.staleBlock ? { ...record, [fields.block]: options.staleBlock } : record])
  agentStore.setCurrentAgentId(AGENT)
  const routes = installAgentRoutes({
    agentId: AGENT,
    userId: USER,
    route: routeModule,
    holdPuts: options.holdPuts,
    failPutsWith: options.failPutsWith,
    extra: (path) => {
      if (path === '/api/user/saved-models') return jsonResponse({ models: [] })
      if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
      if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
      return undefined
    }
  })
  puts = routes.puts
  const ChatInput = (await import('./ChatInput.svelte')).default
  render(ChatInput, { props: { data: { user: { id: USER } }, onSend: options.onSend ?? (() => true) } })
  const label = provider === 'codex' ? /^Codex permission mode/ : /^Claude permission mode/
  await waitFor(() => expect(screen.getByLabelText(label)).toBeTruthy(), { timeout: 15_000 })
  await pause(100)
  expect(puts).toEqual([])
}

function codexTrigger() {
  return screen.getByLabelText(/^Codex permission mode/)
}

async function openCodexMenu() {
  await fireEvent.keyDown(codexTrigger(), { key: 'ArrowDown' })
  await screen.findAllByRole('menuitemradio')
}

/** The chip shows its icon and its label, nothing more (no more width in the chat bar). */
function expectChipUnchanged(label: string) {
  const trigger = codexTrigger()
  expect(trigger.textContent?.trim()).toBe(label)
  expect(trigger.className).toBe('chat-mode-selector-trigger mode-selector-trigger codex-mode-selector')
}

async function pickRadio(label: RegExp, index: number) {
  await fireEvent.keyDown(screen.getByLabelText(label), { key: 'ArrowDown' })
  const items = await screen.findAllByRole('menuitemradio')
  await fireEvent.click(items[index])
}

async function typeAndSend(text: string) {
  const box = screen.getByTestId('message-input') as HTMLTextAreaElement
  await fireEvent.input(box, { target: { value: text } })
  await fireEvent.click(screen.getByTestId('send-button'))
}

describe('the chat bar shows the Sandbox Level a Codex send runs with, inside its menu (BL-941 part C)', () => {
  it('Agent with a saved Read-only level: the chosen mode in the menu says so; the chip is unchanged', async () => {
    await openChatBar('codex', codexBlock('agent', 'read-only'))

    const trigger = codexTrigger()
    expect(trigger.getAttribute('data-sandbox-level')).toBe('read-only')
    expectChipUnchanged('Agent')
    expect(trigger.getAttribute('aria-label')).toBe('Codex permission mode')
    expect(trigger.getAttribute('title')).toBe('Codex permission mode')
    expect(screen.queryByTestId('codex-mode-sandbox-level')).toBeNull()

    await openCodexMenu()
    const line = screen.getByTestId('codex-mode-sandbox-level')
    expect(line.textContent).toBe('Sandbox Level from Agent Settings: Read-only')
    // Under the CHOSEN mode, in the menu's own description style.
    const item = line.closest('[role="menuitemradio"]') as HTMLElement
    expect(item.getAttribute('aria-checked')).toBe('true')
    expect(item.textContent).toContain('Agent')
    expect(line.className).toContain('chat-mode-menu-description')
    expect(screen.getAllByTestId('codex-mode-sandbox-level')).toHaveLength(1)
  }, 60_000)

  it('Agent (full access) with a saved Workspace write level: the menu says Workspace write', async () => {
    await openChatBar('codex', codexBlock('agent_full', 'workspace-write'))

    expect(codexTrigger().getAttribute('data-sandbox-level')).toBe('workspace-write')
    expectChipUnchanged('Agent')
    await openCodexMenu()
    expect(screen.getByTestId('codex-mode-sandbox-level').textContent).toBe('Sandbox Level from Agent Settings: Workspace write')
  }, 60_000)

  it("the mode's own level shows no level: Agent with Workspace write", async () => {
    await openChatBar('codex', codexBlock('agent', 'workspace-write'))
    expect(codexTrigger().getAttribute('data-sandbox-level')).toBe('workspace-write')
    expectChipUnchanged('Agent')
    await openCodexMenu()
    expect(screen.queryByTestId('codex-mode-sandbox-level')).toBeNull()
  }, 60_000)

  it("a record with a mode and no saved sandbox runs with the mode's own level, and shows no level", async () => {
    await openChatBar('codex', codexBlock('agent'))
    expect(codexTrigger().getAttribute('data-sandbox-level')).toBe('workspace-write')
    await openCodexMenu()
    expect(screen.queryByTestId('codex-mode-sandbox-level')).toBeNull()
  }, 60_000)

  it('a saved level LOOSER than the mode (Chat with Workspace write) is not what a send runs with: the send runs Read-only, and the menu names no level', async () => {
    await openChatBar('codex', codexBlock('chat', 'workspace-write'))

    expect(codexTrigger().getAttribute('data-sandbox-level')).toBe('read-only')
    await openCodexMenu()
    expect(screen.queryByTestId('codex-mode-sandbox-level')).toBeNull()
  }, 60_000)

  it('a pick writes the mode with its own level, and the line leaves the menu', async () => {
    await openChatBar('codex', codexBlock('agent', 'read-only'))
    expect(codexTrigger().getAttribute('data-sandbox-level')).toBe('read-only')

    await pickRadio(/^Codex permission mode/, 1) // Agent (workspace write)

    await waitFor(() => expect(puts.length).toBe(1), { timeout: 5_000 })
    expect(puts[0].body.codex_settings).toEqual({
      permissionMode: 'agent',
      sandbox: 'workspace-write',
      approval: 'on-request'
    })
    await waitFor(() => expect(codexTrigger().getAttribute('data-sandbox-level')).toBe('workspace-write'))
    await openCodexMenu()
    expect(screen.queryByTestId('codex-mode-sandbox-level')).toBeNull()
  }, 60_000)
})

describe('the menu reads the record again when it opens (BL-941 part C, review M1)', () => {
  it('another window made the level looser since this copy was read: the menu shows no stricter level than runs', async () => {
    // This window's copy: Agent with Read-only. Saved since in another window: Agent's own level.
    await openChatBar('codex', codexBlock('agent', 'workspace-write'), { staleBlock: codexBlock('agent', 'read-only') })
    expect(codexTrigger().getAttribute('data-sandbox-level')).toBe('read-only')

    await openCodexMenu()

    await waitFor(() => expect(codexTrigger().getAttribute('data-sandbox-level')).toBe('workspace-write'))
    expect(screen.queryByTestId('codex-mode-sandbox-level')).toBeNull()
    expect(puts).toEqual([])
  }, 60_000)

  it('another window made the level tighter since: the menu shows it', async () => {
    await openChatBar('codex', codexBlock('agent', 'read-only'), { staleBlock: codexBlock('agent', 'workspace-write') })
    expect(codexTrigger().getAttribute('data-sandbox-level')).toBe('workspace-write')

    await openCodexMenu()

    await waitFor(() =>
      expect(screen.getByTestId('codex-mode-sandbox-level').textContent).toBe('Sandbox Level from Agent Settings: Read-only')
    )
    expect(puts).toEqual([])
  }, 60_000)

  it("a pick made while the menu's read is still on its way: the older read does not take the pick back", async () => {
    await openChatBar('codex', codexBlock('chat', 'read-only'))
    // The menu's read of the record answers with the record as it was when it was read, late.
    const release = gate()
    const routedFetch = global.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    let heldReads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if ((init.method ?? 'GET').toUpperCase() === 'GET' && url.split('?')[0] === `/api/agents/${AGENT}`) {
          const answer = await routedFetch(input, init)
          heldReads += 1
          await release.promise
          return answer
        }
        return routedFetch(input, init)
      })
    )

    await pickRadio(/^Codex permission mode/, 2) // opens the menu (its read starts), then Agent (full access)
    await waitFor(() => expect(heldReads).toBe(1), { timeout: 5_000 })
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 5_000 })
    await waitFor(async () => expect((await storedAgent(AGENT)).codex_settings.permissionMode).toBe('agent_full'))
    release.open()
    await pause(200)

    expect(agentStore.getAgentById(AGENT)?.codex_settings?.permissionMode).toBe('agent_full')
    expect(codexTrigger().getAttribute('data-sandbox-level')).toBe('danger-full-access')
  }, 60_000)

  it('a record with no Codex block and only the older keys: the level comes from those keys', async () => {
    await openChatBar('codex', null, {
      providerSettings: { codex_permission_mode: 'agent', codex_sandbox: 'read-only', codex_approval: 'on-request' }
    })
    expect(codexTrigger().getAttribute('data-sandbox-level')).toBe('read-only')
    await openCodexMenu()
    expect(screen.getByTestId('codex-mode-sandbox-level').textContent).toBe('Sandbox Level from Agent Settings: Read-only')
  }, 60_000)
})

describe('a send waits for the chat bar’s own mode save (BL-941 part C)', () => {
  it('Codex: a send made while a looser pick is still saving goes after the save, with the saved mode', async () => {
    const hold = gate()
    let holding = true
    const sends: Array<{ message: string; metadata: any }> = []
    await openChatBar('codex', codexBlock('chat', 'read-only'), {
      holdPuts: () => (holding ? hold.promise : null),
      onSend: (message, metadata) => {
        sends.push({ message, metadata })
        return true
      }
    })

    await pickRadio(/^Codex permission mode/, 2) // Agent (full access)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 5_000 })
    await typeAndSend('Make the file.')
    await pause(150)
    // The save has not landed: the send has not gone.
    expect(sends).toEqual([])

    holding = false
    hold.open()
    await waitFor(() => expect(sends.length).toBe(1), { timeout: 5_000 })
    expect(sends[0].metadata.codexPermissionMode).toBe('agent_full')
    expect((await storedAgent(AGENT)).codex_settings.permissionMode).toBe('agent_full')
  }, 60_000)

  it('Codex: a send made while a pick is saving that then FAILS carries the mode that is saved, not the failed pick', async () => {
    const hold = gate()
    const failedSends: any[] = []
    await openChatBar('codex', codexBlock('chat', 'read-only'), {
      onSend: (_message, metadata) => {
        failedSends.push(metadata)
        return true
      }
    })
    // The PUT is held, then refused.
    const routedFetch = global.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if ((init.method ?? 'GET').toUpperCase() === 'PUT') {
          puts.push({ body: JSON.parse(String(init.body)) })
          await hold.promise
          return jsonResponse({ error: 'Probe refusal' }, 500)
        }
        return routedFetch(input, init)
      })
    )

    await pickRadio(/^Codex permission mode/, 2) // Agent (full access)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 5_000 })
    await typeAndSend('Make the file.')
    await pause(150)
    expect(failedSends).toEqual([])

    hold.open()
    await waitFor(() => expect(failedSends.length).toBe(1), { timeout: 5_000 })
    expect(failedSends[0].codexPermissionMode).toBe('chat')
    expect((await storedAgent(AGENT)).codex_settings.permissionMode).toBe('chat')
  }, 60_000)

  it('Claude: a send made while a looser pick is still saving goes after the save, with the saved mode', async () => {
    const hold = gate()
    let holding = true
    const sends: any[] = []
    await openChatBar('claude', CLAUDE_BLOCK, {
      holdPuts: () => (holding ? hold.promise : null),
      onSend: (_message, metadata) => {
        sends.push(metadata)
        return true
      }
    })

    await pickRadio(/^Claude permission mode/, 2) // Edit automatically
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 5_000 })
    await typeAndSend('Edit the file.')
    await pause(150)
    expect(sends).toEqual([])

    holding = false
    hold.open()
    await waitFor(() => expect(sends.length).toBe(1), { timeout: 5_000 })
    expect(sends[0].claudePermissionMode).toBe('acceptEdits')
  }, 60_000)

  it('two quick picks: the send waits for both saves and carries the last pick', async () => {
    const hold = gate()
    let holding = true
    const sends: any[] = []
    await openChatBar('codex', codexBlock('chat', 'read-only'), {
      holdPuts: () => (holding ? hold.promise : null),
      onSend: (_message, metadata) => {
        sends.push(metadata)
        return true
      }
    })

    await pickRadio(/^Codex permission mode/, 2) // Agent (full access)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 5_000 })
    await pickRadio(/^Codex permission mode/, 1) // Agent
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 5_000 })
    await typeAndSend('Make the file.')
    await pause(150)
    expect(sends).toEqual([])

    holding = false
    hold.open()
    await waitFor(() => expect(sends.length).toBe(1), { timeout: 5_000 })
    expect(sends[0].codexPermissionMode).toBe('agent')
  }, 60_000)

  it('with no pick in flight a send goes at once', async () => {
    const sends: any[] = []
    await openChatBar('codex', codexBlock('agent', 'read-only'), {
      onSend: (_message, metadata) => {
        sends.push(metadata)
        return true
      }
    })

    await typeAndSend('Read the file.')
    await waitFor(() => expect(sends.length).toBe(1), { timeout: 2_000 })
    expect(sends[0].codexPermissionMode).toBe('agent')
  }, 60_000)
})
