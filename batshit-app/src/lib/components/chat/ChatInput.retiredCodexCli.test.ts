import { cleanup, render, screen, waitFor, within } from '@testing-library/svelte'
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
 * SA-139 R1 and R4 (D14, mounted check): the Codex CLI lane (R1) and the Claude Code CLI Primary
 * lane (R4) were removed, and a stored `cli` Primary is not migrated. The chat bar shows such a
 * leftover agent no model control at all: no Claude Code controls, no API model selector and no
 * reasoning control (`ChatInput.svelte` `isRetiredPrimaryAgent`), and opening it saves nothing.
 * The server refuses its send (409 `primary_agent_type_retired`); the page only shows it.
 *
 * Renders the REAL ChatInput on the real agents store; `fetch` sends `/api/agents/<id>` to the
 * REAL route on the default lane's Redis fake (the harness of `ChatInput.sandboxLevel.test.ts`).
 */

vi.mock('$lib/server/services/managedProfileFolderDelete', () => ({
  deleteManagedProfileFolder: vi.fn(async () => {})
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))

useRedisTestServer()

const USER = 'cbrc_user'
const AGENT = 'cbrc_agent'

/** A stored Codex CLI agent from before R1. */
const LEFTOVER_CODEX_CLI = {
  displayName: 'Rook',
  agentType: 'cli',
  primary_model_provider: 'openai-codex',
  primary_model_name: 'gpt-5.1-codex',
  primary_model_connection: { id: 'codex-cli', service: 'openai-codex', type: 'direct' }
} as const

/** A stored Claude Code CLI Primary from before R4, with its saved Claude settings. */
const LEFTOVER_CLAUDE_CLI = {
  displayName: 'Bram',
  agentType: 'cli',
  primary_model_provider: 'claude-cli',
  primary_model_name: 'claude-cli',
  primary_model_connection: { type: 'cli', service: 'claude-cli' },
  claude_settings: { permissionMode: 'plan', model: 'sonnet', configScope: 'managed' }
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
  agentStore.setCurrentAgentId(null)
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function openChatBar(record: Record<string, unknown>) {
  await redis.createAgent({ id: AGENT, user_id: USER, ...record } as any)
  const stored = (await storedAgent(AGENT)) as any
  agentStore.setAgents([stored])
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
  render(ChatInput, { props: { data: { user: { id: USER } }, onSend: () => true } })
  await waitFor(
    () => expect(within(screen.getByTestId('agent-selector')).getByText(String(record.displayName))).toBeTruthy(),
    { timeout: 15_000 }
  )
}

describe('SA-139 R1/R4: the chat bar shows a leftover CLI Primary no model control', () => {
  it.each([
    ['Codex-named', LEFTOVER_CODEX_CLI],
    ['Claude-named', LEFTOVER_CLAUDE_CLI]
  ] as const)('a %s leftover cli Primary: no model or Claude controls, and nothing saves on mount', async (_name, record) => {
    await openChatBar(record)
    // Past the first effects, so a control that mounts late would have mounted.
    await pause(500)

    expect(screen.queryByTestId('model-selector')).toBeNull()
    expect(screen.queryByTestId('model-reasoning-selector')).toBeNull()
    expect(screen.queryByTestId('claude-model-selector')).toBeNull()
    expect(screen.queryByLabelText(/^Claude permission mode/)).toBeNull()
    expect(screen.queryByLabelText(/^Claude thinking mode/)).toBeNull()
    // The chat bar itself is still there (the server refuses the send, not the page).
    expect(screen.getByTestId('message-input')).toBeTruthy()
    expect(puts).toEqual([])
  }, 60_000)

  it('an API agent whose OpenAI model id contains "codex" still shows the API model selector', async () => {
    await openChatBar({
      displayName: 'Sol',
      agentType: 'api',
      primary_model_provider: 'openai',
      primary_model_name: 'gpt-5-codex',
      primary_model_connection: { type: 'direct', id: 'direct:openai', service: 'openai' }
    })
    await waitFor(() => expect(screen.getByTestId('model-selector')).toBeTruthy(), { timeout: 15_000 })
    expect(screen.queryByTestId('claude-model-selector')).toBeNull()
  }, 60_000)
})
