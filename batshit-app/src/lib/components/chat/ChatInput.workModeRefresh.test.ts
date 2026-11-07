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
 * BL-2048 (SA-137 Round 2 UI review): whether Refreshed File Reads can run reads an API agent's Bash
 * permissions mode and command location (`refreshedFileReadsRecordInputs`), so the chat bar's Work
 * mode save, which writes both, asks every open chat's badge facts again once the save landed, when
 * either changed. Before, only Agent Settings and the Global Tool Grid did, and the open chat's Read
 * File badges kept the old facts until the reply ended or the chat was reopened.
 *
 * Renders the REAL ChatInput on the real agents store; `fetch` sends `/api/agents/<id>` to the REAL
 * route on the default lane's Redis fake (the harness of `ChatInput.sandboxLevel.test.ts`). Only the
 * badge re-ask is a spy.
 */

const deadCopies = vi.hoisted(() => ({ refreshAll: vi.fn(async () => {}) }))
vi.mock('$lib/stores/zipDeadCopies.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/zipDeadCopies.svelte')>()),
  refreshAllDeadCopies: deadCopies.refreshAll
}))

useRedisTestServer()

const USER = 'cbwm_user'
const AGENT = 'cbwm_agent'

let routeModule: Awaited<ReturnType<typeof loadAgentRoute>>
let puts: AgentPut[] = []
let failNextPut = false
/** Each PUT in turn waits on the next gate here, if any (it is recorded first). */
let putGates: Array<Promise<void>> = []
const originalFetch = global.fetch

beforeAll(async () => {
  routeModule = await loadAgentRoute()
}, 60_000)

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  deadCopies.refreshAll.mockClear()
  failNextPut = false
  putGates = []
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  global.fetch = originalFetch
  agentStore.setAgents([])
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function openChatBar(nativeTools: Record<string, unknown>) {
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: 'Work mode probe',
    agentType: 'api',
    primary_model_name: 'claude-sonnet-5',
    provider_specific_settings: { nativeTools: { bashEnabled: true, ...nativeTools } }
  } as any)
  agentStore.setAgents([(await storedAgent(AGENT)) as any])
  agentStore.setCurrentAgentId(AGENT)
  const routes = installAgentRoutes({
    agentId: AGENT,
    userId: USER,
    route: routeModule,
    failPutsWith: () => {
      if (!failNextPut) return null
      failNextPut = false
      return 500
    },
    holdPuts: () => putGates.shift() ?? null,
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
  await waitFor(() => expect(screen.getByLabelText('Work mode')).toBeTruthy(), { timeout: 15_000 })
  await pause(100)
  expect(puts).toEqual([])
}

async function pickWorkMode(name: RegExp) {
  await fireEvent.keyDown(screen.getByLabelText('Work mode'), { key: 'ArrowDown' })
  const items = await screen.findAllByRole('menuitemradio')
  const item = items.find((entry) => name.test((entry.textContent ?? '').trim()))
  if (!item) throw new Error(`No Work mode option matches ${name}`)
  await fireEvent.click(item)
}

async function waitForPuts(count: number) {
  await waitFor(() => expect(puts.length).toBe(count), { timeout: 8_000 })
  // Let the save's answer land in the chat bar before the next step.
  await pause(300)
}

describe('the chat bar Work mode save re-asks the badges\' Refreshed File Reads facts (BL-2048)', () => {
  it('Agent to Batshit Crazy (Dangerous) moves the command location to Local: re-asked once, after the save landed', async () => {
    await openChatBar({ bashAccessMode: 'agent', executionBackend: 'apple_container' })
    let land = () => {}
    putGates.push(new Promise<void>((resolve) => { land = resolve }))
    await pickWorkMode(/^Batshit Crazy/)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    // Sent, not landed: nothing re-asked yet.
    await pause(300)
    expect(deadCopies.refreshAll).not.toHaveBeenCalled()
    land()
    await waitForPuts(1)
    expect(puts[0].body.provider_specific_settings.nativeTools).toMatchObject({ bashAccessMode: 'dangerous', executionBackend: 'local' })
    await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalledTimes(1))
    const saved = (await storedAgent(AGENT)) as any
    expect(saved.provider_specific_settings.nativeTools).toMatchObject({ bashAccessMode: 'dangerous', executionBackend: 'local' })
  }, 60_000)

  it('Agent to Plan changes the mode alone (the sandbox stays): re-asked', async () => {
    await openChatBar({ bashAccessMode: 'agent', executionBackend: 'apple_container' })
    await pickWorkMode(/^Plan/)
    await waitForPuts(1)
    expect(puts[0].body.provider_specific_settings.nativeTools).toMatchObject({ bashAccessMode: 'plan', executionBackend: 'apple_container' })
    await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalledTimes(1))
  }, 60_000)

  it('picking the mode it already has saves it again and re-asks nothing (nothing the rule reads moved)', async () => {
    await openChatBar({ bashAccessMode: 'agent', executionBackend: 'apple_container' })
    await pickWorkMode(/^Agent/)
    await waitForPuts(1)
    await pause(200)
    expect(deadCopies.refreshAll).not.toHaveBeenCalled()
  }, 60_000)

  // Review NIT 1: the save's own result decides, not the store's copy a later pick already holds.
  it('a pick that lands while a later pick is still in flight re-asks for its own change', async () => {
    await openChatBar({ bashAccessMode: 'agent', executionBackend: 'apple_container' })
    let landFirst = () => {}
    let landSecond = () => {}
    putGates.push(new Promise<void>((resolve) => { landFirst = resolve }), new Promise<void>((resolve) => { landSecond = resolve }))
    await pickWorkMode(/^Batshit Crazy/)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    // Agent again while the first is in flight: the store's copy goes back to the starting values.
    await pickWorkMode(/^Agent/)
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    landFirst()
    await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalledTimes(1))
    landSecond()
    await waitFor(() => expect(deadCopies.refreshAll).toHaveBeenCalledTimes(2))
    expect(((await storedAgent(AGENT)) as any).provider_specific_settings.nativeTools).toMatchObject({ bashAccessMode: 'agent', executionBackend: 'apple_container' })
  }, 60_000)

  it('a refused save re-asks nothing', async () => {
    await openChatBar({ bashAccessMode: 'agent', executionBackend: 'apple_container' })
    failNextPut = true
    await pickWorkMode(/^Batshit Crazy/)
    await waitForPuts(1)
    await pause(200)
    expect(deadCopies.refreshAll).not.toHaveBeenCalled()
  }, 60_000)
})
