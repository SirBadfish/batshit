import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import GroupSettingsPanel from './GroupSettingsPanel.svelte'

// BL-482: emptying the Group System Prompt and saving looked saved, but the panel sent the empty
// prompt as `undefined`, JSON dropped it, and the update route merged the body over the stored
// group, so every later group turn still carried the old prompt. The panel now sends `''`.

const GROUP_ID = 'ssacc_group'
const OLD_PROMPT = 'Always answer as the ssacc crew.'

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

function installGroupRoutes() {
  const group = {
    id: GROUP_ID,
    user_id: 'ssacc_user',
    name: 'Ssacc Crew',
    agent_ids: [],
    agent_settings: {},
    group_system_prompt: OLD_PROMPT,
    max_followups_total: 5,
    max_agents: 4,
    driver_mode: false,
    driver_agent_id: null,
    shared_tools: []
  }
  const puts: Array<Record<string, any>> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    if (url === '/api/groups' && method === 'GET') return jsonResponse({ groups: [structuredClone(group)] })
    if (url === `/api/groups/${GROUP_ID}` && method === 'PUT') {
      const payload = JSON.parse(String(init.body))
      puts.push(payload)
      Object.assign(group, payload)
      return jsonResponse({ success: true })
    }
    if (url === `/api/groups/${GROUP_ID}` && method === 'GET') return jsonResponse(structuredClone(group))
    if (method === 'GET') return jsonResponse({})
    throw new Error(`Unhandled fetch: ${method} ${url}`)
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
  return { puts }
}

describe('Group System Prompt: clearing it sends the empty prompt (BL-482)', () => {
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

  it('saving an emptied prompt sends group_system_prompt as an empty string', async () => {
    const routes = installGroupRoutes()
    render(GroupSettingsPanel, { props: { data: { user: { id: 'ssacc_user' } } } })

    await screen.findByDisplayValue('Ssacc Crew')
    const promptRow = screen
      .getByText('Group System Prompt', { selector: 'p' })
      .closest('.batshit-settings-form-row') as HTMLElement
    await fireEvent.click(within(promptRow).getByRole('button', { name: /Edit/ }))
    const editor = await screen.findByDisplayValue(OLD_PROMPT)
    await fireEvent.input(editor, { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: /Save Prompt/ }))

    await waitFor(() => expect(routes.puts).toHaveLength(1))
    expect(Object.prototype.hasOwnProperty.call(routes.puts[0], 'group_system_prompt')).toBe(true)
    expect(routes.puts[0].group_system_prompt).toBe('')
  })
})
