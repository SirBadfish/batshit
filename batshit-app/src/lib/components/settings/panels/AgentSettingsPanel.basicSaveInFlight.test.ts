import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import * as agentStore from '$lib/stores/agents.svelte'
import { buildPickedPresetModelFields } from '$lib/utils/modelPresetPick'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import {
  installAgentRoutes,
  jsonResponse,
  loadAgentRoute,
  storedAgent,
  type AgentPut
} from '$lib/test-utils/agentPutRoute'

/**
 * BL-911: a landed Primary basic save put its pre-typing snapshot over the live form
 * (`persistBasic` assigned `basicForm = nextForm`), so text typed while the save was in flight
 * was lost from the field, and text typed on after that landed on the older text. BL-844's fix for
 * the Subagent form is the model: a landed save moves ONLY the baseline (`basicPersistedForm`) and
 * the persisted signature to the saved snapshot; the live form is never replaced by the snapshot,
 * so the next autosave sends just the new keystrokes, and the multiline editors lay their change
 * over the live form as their save lands (`applyToLive`).
 *
 * A save that lands after the SAME agent was read again (`hydrateAgent`: a switch away and back,
 * the delete fallback, `onMount`, the `initialAgentId` effect) must not move only the baseline:
 * that read put the record as it was when it read into the form AND the baseline, possibly older
 * than the save, and a baseline moved under a form holding the older record makes the next
 * autosave send the older values back (BL-911, review). `persistBasic` compares
 * `agentHydrationRequestId` with the value read when the body was built; when a read started since
 * it leaves the form and the baseline to that read and, when nothing is unsaved, reads the record
 * again (it holds the save now).
 *
 * Renders the REAL panel. `/api/agents/<id>` goes to the REAL route handler on the default lane's
 * Redis fake; `holdPuts` holds a PUT after it is recorded and before it writes (a slow round trip).
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

// The Tool Grid card is replaced by a stand-in that hands the test the card's own callbacks (the
// panel's save code is what runs), as `AgentSettingsPanel.toolGridSaves.test.ts` does.
vi.mock('$lib/components/settings/agent/AgentMcpDefaultsCard.svelte', async () => ({
  default: (await import('../../mcps/__tests__/AgentMcpDefaultsCardStub.test.svelte')).default
}))

useRedisTestServer()

const USER = 'ss911_user'
const AGENT = 'ss911_agent'
const NAME = 'Basic save probe'
const OTHER = 'ss911_other'
const OTHER_NAME = 'Other save probe'

const PRESET = {
  id: 'ss911_preset',
  provider: 'openai',
  modelId: 'gpt-5.5',
  modelName: 'Probe Model A',
  purpose: 'chat',
  connection: { type: 'direct', service: 'openai' },
  settings: { temperature: 0.7 }
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

let routeModule: Awaited<ReturnType<typeof loadAgentRoute>>
let puts: AgentPut[] = []
/** Each agent PUT that is recorded waits for the next of these, in order (a slow round trip). */
let heldPuts: Array<Promise<void>> = []
let failNextPuts = 0
/** What happened to the agent, in order (the ordering tests of the re-read cases read it). */
let events: string[] = []
let rendered: ReturnType<typeof render> | null = null
/** While set, the next answer to the agent's GET waits for it AFTER the record was read (a slow answer). */
let holdNextGetAnswer: Promise<void> | null = null
const originalFetch = global.fetch

beforeAll(async () => {
  routeModule = await loadAgentRoute()
}, 60_000)

beforeEach(() => {
  ensureBrowserStubs()
  heldPuts = []
  failNextPuts = 0
  events = []
  holdNextGetAnswer = null
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

/** Holds the next PUT that is not held yet until `release()`; call it again to hold the one after. */
function holdNext() {
  let release: () => void = () => {}
  heldPuts.push(
    new Promise<void>((resolve) => {
      release = resolve
    })
  )
  return release
}

/**
 * Creates the API agent (and a second one when `withOther`, to switch away and back) and renders
 * the panel on it, past the autosave debounces.
 */
async function openPanel(extra: Record<string, unknown> = {}, withOther = false) {
  if (withOther) {
    await redis.createAgent({
      id: OTHER,
      user_id: USER,
      displayName: OTHER_NAME,
      agentType: 'api',
      ...buildPickedPresetModelFields(PRESET as any),
      primary_model_connection: resolveSavedModelConnection(PRESET as any),
      provider_specific_settings: { temperature: 0.7 }
    } as any)
  }
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: NAME,
    agentType: 'api',
    ...buildPickedPresetModelFields(PRESET as any),
    primary_model_connection: resolveSavedModelConnection(PRESET as any),
    provider_specific_settings: { temperature: 0.7 },
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
    holdPuts: () => {
      const gate = heldPuts.shift() ?? null
      if (gate) events.push('put-recorded')
      return gate
    },
    extra: async (path, method, init) => {
      if (path === '/api/agents' && method === 'GET') {
        const agents = [await storedAgent(AGENT)]
        if (withOther) agents.push(await storedAgent(OTHER))
        return jsonResponse({ agents })
      }
      if (withOther && path === `/api/agents/${OTHER}/subagents`) return jsonResponse({ subagents: [] })
      if (withOther && path === `/api/agents/${OTHER}`) {
        const request = new Request(`http://localhost${path}`, {
          method,
          body: method === 'PUT' ? String(init.body) : undefined
        })
        const handler = method === 'PUT' ? routeModule.PUT : routeModule.GET
        return (await handler({ params: { id: OTHER }, request, locals: { user: { id: USER } } } as any)) as Response
      }
      if (path === `/api/agents/${AGENT}/subagents`) return jsonResponse({ subagents: [] })
      if (path === '/api/subagents' && method === 'GET') return jsonResponse({ subagents: [] })
      if (path === '/api/user/saved-models') return jsonResponse({ models: [PRESET] })
      if (path === '/api/models') return jsonResponse({ data: { connections: [] } })
      if (path === '/api/settings/api-keys') return jsonResponse({ keys: {} })
      if (path === '/api/goons') return jsonResponse({ goons: [] })
      if (path === '/api/mcp/gateways') return jsonResponse({ gateways: [] })
      if (path === '/api/cli-tools') return jsonResponse({ tools: [] })
      if (path === '/api/icons/library') return jsonResponse({ icons: [], prefs: { favorites: [], recents: [] } })
      return undefined
    }
  })
  puts = routes.puts
  // The agent's GET: the record is read first, and its answer may be held (a slow answer that read
  // an older record); `events` says when each answer went out.
  const routed = global.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const isAgentGet = url.split('?')[0] === `/api/agents/${AGENT}` && (init.method ?? 'GET').toUpperCase() === 'GET'
      const response = await routed(input, init)
      if (isAgentGet) {
        const gate = holdNextGetAnswer
        holdNextGetAnswer = null
        if (gate) {
          events.push('get-read')
          await gate
        }
        events.push('get-answered')
      }
      return response
    })
  )
  rendered = render((await import('./AgentSettingsPanel.svelte')).default, {
    props: { data: { user: { id: USER } } as any, initialAgentId: AGENT }
  })
  await screen.findByDisplayValue(NAME, {}, { timeout: 15_000 })
  await pause(1500)
  expect(puts).toEqual([])
}

function nameInput() {
  return document.getElementById('agent-display') as HTMLInputElement
}

async function waitForPuts(count: number) {
  await waitFor(() => expect(puts.length).toBe(count), { timeout: 8_000 })
  // Let the save's answer land in the panel before the next step.
  await pause(400)
}

/**
 * Types `first`, waits until its save is on the wire (held), types `second` during the round
 * trip, and lets the save land. Returns the field, with the second save (built from `second`)
 * still waiting in its debounce.
 */
async function typeDuringASave(first: string, second: string) {
  await openPanel()
  const release = holdNext()
  const input = nameInput()
  await fireEvent.input(input, { target: { value: first } })
  await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
  expect(puts[0].body).toEqual({ displayName: first })

  await fireEvent.input(input, { target: { value: second } })
  release()
  // The save landed (the record holds `first`), and the second save has not fired yet.
  await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(first), { timeout: 8_000 })
  await pause(200)
  expect(puts.length).toBe(1)
  return input
}

describe('a Primary basic save that lands keeps what was typed while it was in flight (BL-911)', () => {
  it('the field still shows the text typed during the round trip, and the next save sends exactly that text', async () => {
    const input = await typeDuringASave(`${NAME} R`, `${NAME} R!`)

    expect(input.value).toBe(`${NAME} R!`)
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    expect(puts[1].body).toEqual({ displayName: `${NAME} R!` })
    await pause(400)
    expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R!`)
    expect(input.value).toBe(`${NAME} R!`)
    // Nothing else follows: the form equals what was saved.
    await pause(1200)
    expect(puts.length).toBe(2)
  }, 120_000)

  it('typing on after the save landed adds to the text that was typed during it: no character is lost', async () => {
    const input = await typeDuringASave(`${NAME} R`, `${NAME} R!`)

    // The user keeps typing at the end of what the field shows.
    await fireEvent.input(input, { target: { value: `${input.value}?` } })

    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    expect(puts[1].body).toEqual({ displayName: `${NAME} R!?` })
    await pause(400)
    expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R!?`)
    expect(input.value).toBe(`${NAME} R!?`)
  }, 120_000)

  it('a different field changed during the round trip stays in the form too, and is the only thing the next save sends', async () => {
    await openPanel()
    const release = holdNext()
    await fireEvent.input(nameInput(), { target: { value: `${NAME} R` } })
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })

    // A switch flipped during the round trip (Display Reasoning is on by default for an API agent).
    const row = screen
      .getAllByText('Display Reasoning', { selector: '.batshit-settings-parent-label' })
      .map((element) => element.closest('.batshit-settings-toggle-row') as HTMLElement | null)
      .find((element) => element?.querySelector('[role="switch"]'))
    const toggle = row!.querySelector('[role="switch"]') as HTMLElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    release()

    // The first save landed (the record holds the name) and the second is still in its debounce:
    // the switch still shows what the user chose.
    await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R`), { timeout: 8_000 })
    await pause(200)
    expect(puts.length).toBe(1)
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    // Only the switch: the name is in the baseline now, so it is no difference from it.
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    expect(puts[1].body).toMatchObject({ show_reasoning: false })
    expect('displayName' in puts[1].body).toBe(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await pause(400)
    const record = await storedAgent(AGENT)
    expect(record.displayName).toBe(`${NAME} R`)
    expect(record.show_reasoning).toBe(false)
    await pause(1200)
    expect(puts.length).toBe(2)
  }, 120_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a failed multiline editor save leaves the baseline and the form: the retry sends the same change again', async () => {
    await openPanel({ provider_specific_settings: { temperature: 0.7, nativeTools: { bashNeverAllowList: ['rm -rf *'] } } })

    const blockListRow = screen
      .getAllByText('rm -rf *')
      .map((element) => element.closest('.batshit-settings-muted-panel') as HTMLElement | null)
      .find((element) => element)
    await fireEvent.click(within(blockListRow!).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue('rm -rf *')
    await fireEvent.input(editor, { target: { value: 'rm -rf *\nterraform destroy' } })
    const dialog = editor.closest('[role="dialog"]') as HTMLElement
    const saveButton = () =>
      within(dialog)
        .getAllByRole('button')
        .find((button) => /^Save/.test((button.textContent ?? '').trim())) as HTMLElement

    failNextPuts = 1
    await fireEvent.click(saveButton())
    await waitForPuts(1)
    const expectedBody = {
      provider_specific_settings: { nativeTools: { bashNeverAllowList: ['rm -rf *', 'terraform destroy'] } }
    }
    expect(puts[0].body).toEqual(expectedBody)
    // The editor's usual visible error; the record and the form still hold the older list.
    expect(await within(dialog).findByText(/Probe refusal/)).toBeTruthy()
    expect((await storedAgent(AGENT)).provider_specific_settings.nativeTools.bashNeverAllowList).toEqual(['rm -rf *'])
    expect(screen.queryAllByText('2 rules')).toEqual([])

    // The baseline was not moved: the same change goes again.
    await fireEvent.click(saveButton())
    await waitForPuts(2)
    expect(puts[1].body).toEqual(expectedBody)
    expect((await storedAgent(AGENT)).provider_specific_settings.nativeTools.bashNeverAllowList).toEqual([
      'rm -rf *',
      'terraform destroy'
    ])
  }, 120_000)

  it('a multiline editor saved while a name was being typed: both are in the form, and only the name is saved after', async () => {
    await openPanel({ provider_specific_settings: { temperature: 0.7, nativeTools: { bashNeverAllowList: ['rm -rf *'] } } })

    // Permissions: the Always Block List, edited in its editor.
    const previews = screen.getAllByText('rm -rf *')
    const blockListRow = previews
      .map((element) => element.closest('.batshit-settings-muted-panel') as HTMLElement | null)
      .find((element) => element)
    await fireEvent.click(within(blockListRow!).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue('rm -rf *')
    await fireEvent.input(editor, { target: { value: 'rm -rf *\nterraform destroy' } })
    const dialog = editor.closest('[role="dialog"]') as HTMLElement
    const saveButton = within(dialog)
      .getAllByRole('button')
      .find((button) => /^Save/.test((button.textContent ?? '').trim()))

    const release = holdNext()
    await fireEvent.click(saveButton as HTMLElement)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({
      provider_specific_settings: { nativeTools: { bashNeverAllowList: ['rm -rf *', 'terraform destroy'] } }
    })

    // A name typed during the list's round trip: the form is not clean when the list lands.
    await fireEvent.input(nameInput(), { target: { value: `${NAME} R` } })
    release()

    // The name goes on its own: the list is in the form, so it is no difference from the baseline.
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    expect(puts[1].body).toEqual({ displayName: `${NAME} R` })
    await pause(400)
    const record = await storedAgent(AGENT)
    expect(record.displayName).toBe(`${NAME} R`)
    expect(record.provider_specific_settings.nativeTools.bashNeverAllowList).toEqual(['rm -rf *', 'terraform destroy'])
    expect(nameInput().value).toBe(`${NAME} R`)
    // The form shows the saved list (2 rules), not the older one.
    expect(screen.getAllByText('2 rules').length).toBeGreaterThan(0)
    await pause(1200)
    expect(puts.length).toBe(2)
  }, 120_000)

  it('regression guard, not a proof of a fix (green on the parent code too): a multiline editor saved on its own is in the form afterwards, and nothing is saved for it again', async () => {
    await openPanel({ provider_specific_settings: { temperature: 0.7, nativeTools: { bashNeverAllowList: ['rm -rf *'] } } })

    const blockListRow = screen
      .getAllByText('rm -rf *')
      .map((element) => element.closest('.batshit-settings-muted-panel') as HTMLElement | null)
      .find((element) => element)
    await fireEvent.click(within(blockListRow!).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue('rm -rf *')
    await fireEvent.input(editor, { target: { value: 'rm -rf *\nterraform destroy' } })
    const dialog = editor.closest('[role="dialog"]') as HTMLElement
    const saveButton = within(dialog)
      .getAllByRole('button')
      .find((button) => /^Save/.test((button.textContent ?? '').trim()))
    await fireEvent.click(saveButton as HTMLElement)

    await waitForPuts(1)
    expect((await storedAgent(AGENT)).provider_specific_settings.nativeTools.bashNeverAllowList).toEqual([
      'rm -rf *',
      'terraform destroy'
    ])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5_000 })
    expect(screen.getAllByText('2 rules').length).toBeGreaterThan(0)
    await pause(1500)
    expect(puts.length).toBe(1)
  }, 120_000)
})

describe('a store refresh does not replace the Primary form while a keystroke is unsaved (BL-911)', () => {
  it('regression guard, not a proof of a fix (the Primary form has no store-refresh effect: only `hydrateAgent` re-reads the record, and it is called by `onMount`, the `initialAgentId` effect, `selectAgent` for another agent, the delete fallbacks and the landing re-read of `persistBasic`): the agents store takes another window\'s change while a keystroke waits, and the field keeps the keystroke', async () => {
    await openPanel()
    const release = holdNext()
    const input = nameInput()
    await fireEvent.input(input, { target: { value: `${NAME} R` } })
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    await fireEvent.input(input, { target: { value: `${NAME} R!` } })

    // The chat bar (or a second window) changes the same agent, and the store answers with the record.
    agentStore.updateAgent(AGENT, { displayName: 'Changed elsewhere' } as any)
    release()

    await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R`), { timeout: 8_000 })
    await pause(300)
    expect(input.value).toBe(`${NAME} R!`)
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    expect(puts[1].body).toEqual({ displayName: `${NAME} R!` })
    await pause(400)
    expect(input.value).toBe(`${NAME} R!`)
  }, 120_000)
})

/** Switches the panel to the agent named `name` through the selector menu. */
async function switchTo(name: string) {
  // The multiline editor's sheet may still be open behind the menu: the trigger is then hidden
  // from the accessibility tree, but it is the same button.
  const selector = screen.getByRole('button', { name: 'Select Agents & Subagents', hidden: true })
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  const item = await screen.findByText(name, { selector: '.batshit-settings-action-row-title' })
  await fireEvent.click(item.closest('button') as HTMLElement)
}

/** Switches away and back, and waits until the agent's own GET has answered into the form. */
async function switchAwayAndBack() {
  await switchTo(OTHER_NAME)
  await waitFor(() => expect(nameInput().value).toBe(OTHER_NAME), { timeout: 15_000 })
  await switchTo(NAME)
  await waitFor(() => expect(nameInput().value).toBe(NAME), { timeout: 15_000 })
}

describe('a save that lands after the same agent was read again does not put the older record back (BL-911, review)', () => {
  it('an autosave in flight: the read answers with the older record first; the landing leaves it alone, sends nothing more, and the form shows the saved edit', async () => {
    await openPanel({}, true)
    const release = holdNext()
    await fireEvent.input(nameInput(), { target: { value: `${NAME} R` } })
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
    expect(puts[0].body).toEqual({ displayName: `${NAME} R` })
    const afterPut = events.length

    // The agent is read again while the save is in flight, and the record still holds the OLD name
    // (the held PUT has not written): the form and its baseline now hold the older record.
    await switchAwayAndBack()
    expect((await storedAgent(AGENT)).displayName).toBe(NAME)
    expect(nameInput().value).toBe(NAME)
    // The order the test depends on: the GET answered after the PUT went out and before it landed.
    expect(events.slice(afterPut - 1)).toContain('get-answered')
    expect(events.indexOf('put-recorded')).toBeLessThan(events.lastIndexOf('get-answered'))
    release()
    events.push('put-released')

    // The save lands (the record holds the edit) ...
    await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R`), { timeout: 8_000 })
    // ... and nothing sends the older name back, however long the autosave would take.
    await pause(2500)
    expect(puts.length).toBe(1)
    expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R`)
    // The form shows the saved edit: the landing read the record again.
    expect(nameInput().value).toBe(`${NAME} R`)
    expect(events.lastIndexOf('get-answered')).toBeGreaterThan(events.indexOf('put-released'))
  }, 120_000)

  it('regression guard for the re-read, green on the parent code too (there `applyToLive` lays the list over the older read): a multiline editor save in flight, the read answers with the older record first: the re-read at the landing displays the saved list, and nothing is sent again', async () => {
    await openPanel({ provider_specific_settings: { temperature: 0.7, nativeTools: { bashNeverAllowList: ['rm -rf *'] } } }, true)

    const blockListRow = screen
      .getAllByText('rm -rf *')
      .map((element) => element.closest('.batshit-settings-muted-panel') as HTMLElement | null)
      .find((element) => element)
    await fireEvent.click(within(blockListRow!).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue('rm -rf *')
    await fireEvent.input(editor, { target: { value: 'rm -rf *\nterraform destroy' } })
    const dialog = editor.closest('[role="dialog"]') as HTMLElement
    const saveButton = within(dialog)
      .getAllByRole('button')
      .find((button) => /^Save/.test((button.textContent ?? '').trim()))

    const release = holdNext()
    await fireEvent.click(saveButton as HTMLElement)
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })

    // Read again while the save is in flight: the record still holds the older list.
    await switchAwayAndBack()
    expect((await storedAgent(AGENT)).provider_specific_settings.nativeTools.bashNeverAllowList).toEqual(['rm -rf *'])
    expect(screen.queryAllByText('2 rules')).toEqual([])
    expect(events.indexOf('put-recorded')).toBeLessThan(events.lastIndexOf('get-answered'))
    release()
    events.push('put-released')

    await waitFor(
      async () =>
        expect((await storedAgent(AGENT)).provider_specific_settings.nativeTools.bashNeverAllowList).toEqual([
          'rm -rf *',
          'terraform destroy'
        ]),
      { timeout: 8_000 }
    )
    await pause(2500)
    expect(puts.length).toBe(1)
    // The form shows the saved list (the landing read the record again), not the older one.
    expect(screen.getAllByText('2 rules').length).toBeGreaterThan(0)
  }, 120_000)

  it('the read is still on its way when the save lands: the landing supersedes it, so the older answer that follows changes nothing', async () => {
    await openPanel({}, true)
    const release = holdNext()
    await fireEvent.input(nameInput(), { target: { value: `${NAME} R` } })
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })

    // Switch away; on the way back the agent's GET reads the OLD record, and its answer is slow.
    await switchTo(OTHER_NAME)
    await waitFor(() => expect(nameInput().value).toBe(OTHER_NAME), { timeout: 15_000 })
    let answer: () => void = () => {}
    holdNextGetAnswer = new Promise<void>((resolve) => {
      answer = resolve
    })
    await switchTo(NAME)
    await waitFor(() => expect(events).toContain('get-read'), { timeout: 8_000 })
    expect((await storedAgent(AGENT)).displayName).toBe(NAME)

    // The save lands while that answer is still held: the panel reads the record again.
    release()
    events.push('put-released')
    await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R`), { timeout: 8_000 })
    await waitFor(() => expect(nameInput().value).toBe(`${NAME} R`), { timeout: 8_000 })
    // Now the slow, older answer arrives: it belongs to a read that was superseded.
    answer()
    await pause(2500)
    expect(nameInput().value).toBe(`${NAME} R`)
    expect(puts.length).toBe(1)
    expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R`)
  }, 120_000)
})

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

/** A Codex CLI agent, without the API preset the other tests give theirs. */
const CODEX_AGENT = {
  agentType: 'cli',
  primary_model_provider: 'codex',
  primary_model_name: 'gpt-6-astra',
  primary_model_connection: { type: 'cli', service: 'codex' },
  primary_model_preset_id: undefined,
  primary_model_temperature: null,
  provider_specific_settings: undefined,
  codex_settings: CODEX_BASE
}

function selectTrigger(current: string) {
  return screen
    .getAllByRole('button', { hidden: true })
    .find((element) => element.hasAttribute('data-select-trigger') && (element.textContent ?? '').trim() === current)
}

/**
 * Picks an option of the select whose visible value is `current`. The popper stays
 * `visibility: hidden` in jsdom (no layout), so its options have no accessible name: they are
 * found hidden and picked by their text.
 */
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

const card = () => (globalThis as any).__mcpCardProps as Record<string, any>

async function openToolsTab() {
  const tab = screen.getAllByRole('tab').find((element) => /Tools/.test(element.textContent ?? ''))
  expect(tab).toBeTruthy()
  await fireEvent.mouseDown(tab as HTMLElement)
  await fireEvent.click(tab as HTMLElement)
  await waitFor(() => expect(card()).toBeTruthy(), { timeout: 10_000 })
}

/**
 * Types a new name and waits until its autosave is on the wire (held), then reads the agent again
 * (a switch away and back): the GET answers with the OLD record because the PUT has not written.
 * Returns what releases the save. The order is asserted: the PUT went out, the GET answered, and the
 * record still holds the old name.
 */
async function nameSaveInFlightThenReadOlderRecord() {
  const release = holdNext()
  await fireEvent.input(nameInput(), { target: { value: `${NAME} R` } })
  await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })
  await switchAwayAndBack()
  expect((await storedAgent(AGENT)).displayName).toBe(NAME)
  expect(nameInput().value).toBe(NAME)
  expect(events.indexOf('put-recorded')).toBeLessThan(events.lastIndexOf('get-answered'))
  return release
}

function primarySettingsFieldset() {
  return document.querySelector('.batshit-settings-surface fieldset') as HTMLFieldSetElement | null
}

function isReadWaitLocked(element: HTMLElement | null) {
  return Boolean(element && (element.matches(':disabled') || element.closest('fieldset:disabled, [inert]')))
}

/** Releases the name write and waits for the deferred same-agent GET to confirm the saved value. */
async function releaseNameAndWaitForDeferredRead(release: () => void) {
  const answeredBefore = events.filter((event) => event === 'get-answered').length
  release()
  events.push('put-released')
  await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R`), { timeout: 8_000 })
  await waitFor(
    () => expect(events.filter((event) => event === 'get-answered').length).toBeGreaterThan(answeredBefore),
    { timeout: 8_000 }
  )
  await waitFor(() => expect(screen.queryByTestId('primary-settings-read-wait')).toBeNull(), { timeout: 8_000 })
  await waitFor(() => expect(isReadWaitLocked(primarySettingsFieldset())).toBe(false), { timeout: 8_000 })
}

describe('the landing re-read waits until every section is at rest (BL-911, second review)', () => {
  it('the Codex group is read-only during the name save, then saves after the deferred read settles', async () => {
    await openPanel(CODEX_AGENT, true)
    const release = await nameSaveInFlightThenReadOlderRecord()

    const control = selectTrigger('Auto') as HTMLElement
    expect(isReadWaitLocked(control)).toBe(true)
    expect(isReadWaitLocked(primarySettingsFieldset())).toBe(true)
    expect(puts).toEqual([{ body: { displayName: `${NAME} R` } }])

    await releaseNameAndWaitForDeferredRead(release)
    await pickSelectOption('Auto', /^High/)
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    await pause(2500)
    expect(puts.length).toBe(2)
    expect(puts[1].body).toEqual({ codex_settings: { reasoningEffort: 'high' } })
    const record = await storedAgent(AGENT)
    expect(record.codex_settings.reasoningEffort).toBe('high')
    expect(record.displayName).toBe(`${NAME} R`)
    // The form still shows the Codex edit.
    expect(selectTrigger('High')).toBeTruthy()
  }, 120_000)

  it('the Tool Grid is inside the read-only surface during the name save, then saves after the read settles', async () => {
    await openPanel({}, true)
    const release = await nameSaveInFlightThenReadOlderRecord()

    expect(isReadWaitLocked(primarySettingsFieldset())).toBe(true)
    expect(puts).toEqual([{ body: { displayName: `${NAME} R` } }])

    await releaseNameAndWaitForDeferredRead(release)
    await openToolsTab()
    card().onZipAiViewModeChange('appended')
    await tick()
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    await pause(2500)
    expect(puts.length).toBe(2)
    expect(puts[1].body).toEqual({ zip_ai_view_mode: 'appended' })
    const record = await storedAgent(AGENT)
    expect(record.zip_ai_view_mode).toBe('appended')
    expect(record.displayName).toBe(`${NAME} R`)
  }, 120_000)

  it('the shown agent read again WITHOUT a reset (the initialAgentId effect) while its answer is on its way: the older answer leaves the unsaved name alone, and nothing takes it back', async () => {
    await openPanel({}, false)
    const release = holdNext()
    await fireEvent.input(nameInput(), { target: { value: `${NAME} R` } })
    await waitFor(() => expect(puts.length).toBe(1), { timeout: 8_000 })

    // The prop changes away and back: the effect reads the shown agent again, no reset, the form
    // still holds the typed name (it differs from the baseline). The GET reads the OLD record and
    // its answer is slow.
    let answer: () => void = () => {}
    holdNextGetAnswer = new Promise<void>((resolve) => {
      answer = resolve
    })
    await rendered!.rerender({ initialAgentId: null })
    await rendered!.rerender({ initialAgentId: AGENT })
    await waitFor(() => expect(events).toContain('get-read'), { timeout: 8_000 })
    expect((await storedAgent(AGENT)).displayName).toBe(NAME)
    expect(nameInput().value).toBe(`${NAME} R`)

    release()
    events.push('put-released')
    await waitFor(async () => expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R`), { timeout: 8_000 })
    // The equal second PUT is held on the wire when it is recorded, so the agents store can be read
    // between the older answer and the second landing.
    const releaseSecond = holdNext()
    // The slow, older answer arrives now. The basic form is not at rest (it holds the unsaved
    // name), so the read leaves it alone (BL-912); the landing belonged to an older read and moved
    // nothing, so the section's effect sends the equal name once more when the read ends: a
    // second PUT of an equal change, which is harmless (BRIEF-2 S7).
    answer()
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    expect(nameInput().value).toBe(`${NAME} R`)
    // The read put the older record into the agents store (the chat bar's copy) before the form
    // was left alone: it shows the older name until the second landing, and the saved one after.
    // This pins a KNOWN condition, not a wanted state: if the second PUT failed, that store copy
    // would stay older, because a failed section is never at rest (listed on the bug list).
    expect(agentStore.getAgentById(AGENT)?.displayName).toBe(NAME)
    releaseSecond()
    await pause(2500)
    expect(agentStore.getAgentById(AGENT)?.displayName).toBe(`${NAME} R`)
    expect(nameInput().value).toBe(`${NAME} R`)
    expect(puts.map((put) => put.body)).toEqual([{ displayName: `${NAME} R` }, { displayName: `${NAME} R` }])
    expect((await storedAgent(AGENT)).displayName).toBe(`${NAME} R`)
  }, 120_000)
})

describe('a multiline editor save after a name save settles (BL-911, second review)', () => {
  it('the editor is read-only during the name save, then saves its list without replacing the name', async () => {
    await openPanel({ provider_specific_settings: { temperature: 0.7, nativeTools: { bashNeverAllowList: ['rm -rf *'] } } }, true)

    const releaseName = await nameSaveInFlightThenReadOlderRecord()
    const blockListRow = screen
      .getAllByText('rm -rf *')
      .map((element) => element.closest('.batshit-settings-muted-panel') as HTMLElement | null)
      .find((element) => element)
    const editButton = within(blockListRow!).getByRole('button', { name: /Edit/ })
    expect(isReadWaitLocked(editButton)).toBe(true)
    expect(isReadWaitLocked(primarySettingsFieldset())).toBe(true)
    expect(puts).toEqual([{ body: { displayName: `${NAME} R` } }])

    await releaseNameAndWaitForDeferredRead(releaseName)
    await fireEvent.click(editButton)
    const editor = await screen.findByDisplayValue('rm -rf *')
    await fireEvent.input(editor, { target: { value: 'rm -rf *\nterraform destroy' } })
    const dialog = editor.closest('[role="dialog"]') as HTMLElement
    const saveButton = within(dialog)
      .getAllByRole('button')
      .find((button) => /^Save/.test((button.textContent ?? '').trim()))
    const releaseList = holdNext()
    await fireEvent.click(saveButton as HTMLElement)
    await waitFor(() => expect(puts.length).toBe(2), { timeout: 8_000 })
    expect(puts[1].body).toEqual({
      provider_specific_settings: { nativeTools: { bashNeverAllowList: ['rm -rf *', 'terraform destroy'] } }
    })

    releaseList()
    events.push('put-released')
    await waitFor(
      async () =>
        expect((await storedAgent(AGENT)).provider_specific_settings.nativeTools.bashNeverAllowList).toEqual([
          'rm -rf *',
          'terraform destroy'
        ]),
      { timeout: 8_000 }
    )
    await pause(2500)

    // The name committed before the editor opened and remains untouched by its partial save.
    expect(puts.filter((put) => put.body.displayName === NAME)).toEqual([])
    expect(puts.length).toBe(2)
    const record = await storedAgent(AGENT)
    expect(record.displayName).toBe(`${NAME} R`)
    expect(record.provider_specific_settings.nativeTools.bashNeverAllowList).toEqual(['rm -rf *', 'terraform destroy'])
    expect(nameInput().value).toBe(`${NAME} R`)
    expect(screen.getAllByText('2 rules').length).toBeGreaterThan(0)
  }, 120_000)
})
