import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MCPGateway, MCPToolGrouping } from '$lib/types/database'

import GatewayInlineSettingsCards from './GatewayInlineSettingsCards.svelte'
import { resetGatewaySaveStateForTest } from './gatewaySaveState'

// BL-1369 and BL-1370: one card instance holds every gateway the user picks in Settings > MCPs
// (the panel passes the new gateway down; the `rerender` here is the panel's part). A save is
// captured whole when it is queued and sent at once when another gateway is picked, to the
// gateway it was made for; a gateway picked back while its own save is on its way is read-only
// until that save answers. Both card sections (Gateway Settings, MCP Groups) are covered. The
// routes are a small fake that keeps the stored gateways and records every PUT (URL and body).
// A failed save here is a 409, which proves nothing was stored (BL-1393); a failure that may
// follow a stored write, and the read of the saved gateway it needs, are proven with the real
// panel in MCPSettingsPanel.gatewaySaves.test.ts.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('svelte-sonner', () => ({ toast }))

const USER = 'bl1369_user'
const ARGS_A = '-y\n@modelcontextprotocol/server-filesystem\n/tmp'
const ARGS_B = '-y\n@modelcontextprotocol/server-filesystem\n/Users/example/b'
const T0 = '2026-10-11T15:00:00.000Z'

function stdio(id: string, name: string, args: string, extra: Partial<MCPGateway> = {}): MCPGateway {
  return {
    id,
    name,
    type: 'stdio',
    enabled: true,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: T0,
    stdioConfig: {
      command: 'npx',
      args: args.split('\n'),
      cwdPolicy: 'none',
      startupTimeoutMs: 10000,
      toolCallTimeoutMs: 60000,
      lastTestStatus: 'never'
    },
    ...extra
  }
}

const FILESYSTEM = () => stdio('gw-a', 'Filesystem', ARGS_A)
const OTHER = () => stdio('gw-x', 'Other', '-y\nother-server')
const CUSTOM = (): MCPGateway => ({
  id: 'gw-c',
  name: 'Remote Search',
  type: 'custom',
  url: 'https://search.example.com/mcp',
  authKeyName: 'search_key',
  enabled: true,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: T0
})
const DOCKER = (): MCPGateway => ({
  id: 'gw-d',
  name: 'Docker MCP Gateway',
  type: 'docker-catalog',
  url: 'http://localhost:8080/mcp',
  enabled: true,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: T0,
  metadata: { dockerProfile: 'default', catalogNote: 'kept' }
})
const N8N_CLIENT = (): MCPGateway => ({
  id: 'gw-n',
  name: 'n8n Workflows',
  type: 'n8n-mcp-client',
  url: 'http://localhost:5678/mcp/client',
  enabled: true,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: T0
})

type PutRequest = { url: string; id: string; body: any }
type PutAnswer = { status: number; body: unknown }

let stored: Map<string, MCPGateway>
let puts: PutRequest[]
let stamp: number
// Each PUT gets its answer from here; a test may hold one back and answer it later.
let answerPut: (request: PutRequest, index: number) => PutAnswer | Promise<PutAnswer>
// Each tool list read gets its answer from here (the MCP Groups editor lists these tools).
let answerTools: (gatewayId: string) => unknown | Promise<unknown>

function applyPut(request: PutRequest): MCPGateway {
  const current = stored.get(request.id)
  if (!current) throw new Error(`no stored gateway ${request.id}`)
  stamp += 1
  const next: MCPGateway = {
    ...current,
    ...(request.body.name !== undefined ? { name: request.body.name } : {}),
    ...(request.body.url !== undefined ? { url: request.body.url } : {}),
    ...(request.body.metadata !== undefined ? { metadata: request.body.metadata } : {}),
    ...(request.body.toolGroupings !== undefined ? { toolGroupings: request.body.toolGroupings } : {}),
    ...(request.body.stdioConfig !== undefined
      ? { stdioConfig: { ...current.stdioConfig!, ...request.body.stdioConfig } }
      : {}),
    updated_at: new Date(Date.parse(T0) + stamp * 1000).toISOString()
  }
  stored.set(request.id, next)
  return next
}

function saved(request: PutRequest): PutAnswer {
  return { status: 200, body: { success: true, gateway: applyPut(request) } }
}

const NOT_STORED: PutAnswer = { status: 409, body: { error: 'nothing was saved' } }

// Saves still held when a test ends are answered then, and the shared save state is reset, so
// each test starts with no saves on their way.
const unanswered: Array<(answer: PutAnswer) => void> = []

function held() {
  let release: (answer: PutAnswer) => void = () => {}
  const answer = new Promise<PutAnswer>((resolve) => {
    release = resolve
  })
  unanswered.push(release)
  return { answer, release }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  stored = new Map([FILESYSTEM(), OTHER(), CUSTOM(), DOCKER(), N8N_CLIENT()].map((gateway) => [gateway.id, gateway]))
  puts = []
  stamp = 0
  answerPut = (request) => saved(request)
  answerTools = () => ({ mcps: [] })
  toast.error.mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/settings/api-keys')) return jsonResponse(200, { success: true, keys: {} })
      if (url.includes('/tools')) {
        const id = decodeURIComponent(url.split('/api/mcp/gateways/')[1].split('/tools')[0])
        return jsonResponse(200, await answerTools(id))
      }
      if (init?.method === 'PUT') {
        const id = decodeURIComponent(url.split('/api/mcp/gateways/')[1].split('?')[0])
        const request = { url, id, body: JSON.parse(String(init.body)) }
        puts.push(request)
        const answer = await answerPut(request, puts.length - 1)
        return jsonResponse(answer.status, answer.body)
      }
      throw new Error(`unexpected fetch ${url}`)
    })
  )
})

afterEach(async () => {
  cleanup()
  for (const release of unanswered.splice(0)) release(NOT_STORED)
  await settle(50)
  resetGatewaySaveStateForTest()
  vi.unstubAllGlobals()
})

const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms))

function field(container: HTMLElement, selector: string) {
  const element = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null
  if (!element) throw new Error(`no field ${selector}`)
  return element
}

/** What a browser allows: no disabled control, no disabled fieldset, no inert ancestor. */
function editable(element: Element) {
  return !(element as HTMLInputElement).disabled && !element.closest('fieldset[disabled]') && !element.closest('[inert]')
}

async function edit(element: Element, value: string) {
  await fireEvent.input(element, { target: { value } })
}

/** jsdom runs handlers on disabled fields, so type only where a browser would let the user. */
async function editIfAllowed(element: Element, value: string) {
  if (!editable(element)) return false
  await edit(element, value)
  return true
}

function addGroupButton(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent?.includes('Add MCP Group'))
  if (!button) throw new Error('no Add MCP Group button')
  return button as HTMLButtonElement
}

async function addGroup(container: HTMLElement, groupName: string) {
  await fireEvent.click(addGroupButton(container))
  const input = await waitFor(() => {
    const element = container.querySelector('input[placeholder="New MCP group name"]')
    if (!element) throw new Error('no group input yet')
    return element as HTMLInputElement
  })
  await fireEvent.input(input, { target: { value: groupName } })
  await fireEvent.keyDown(input, { key: 'Enter' })
}

async function addGroupIfAllowed(container: HTMLElement, groupName: string) {
  const button = addGroupButton(container)
  if (!editable(button)) return false
  await addGroup(container, groupName)
  return true
}

function groupNames(groupings: MCPToolGrouping[] | undefined) {
  return (groupings ?? []).map((group) => group.mcpName)
}

function storedArgs(id: string) {
  return stored.get(id)?.stdioConfig?.args?.join('\n')
}

function argsOf(request: PutRequest) {
  return request.body.stdioConfig?.args?.join('\n')
}

function toastText() {
  return toast.error.mock.calls.map((call) => String(call[0]))
}

async function mount(gateway: MCPGateway, onGatewayUpdated = vi.fn()) {
  const view = render(GatewayInlineSettingsCards, { props: { gateway, userId: USER, onGatewayUpdated } })
  await waitFor(() => expect(addGroupButtonOrNull(view.container, gateway)).toBeTruthy())
  return {
    view,
    onGatewayUpdated,
    pick: (next: MCPGateway) => view.rerender({ gateway: next, userId: USER, onGatewayUpdated })
  }
}

function addGroupButtonOrNull(container: HTMLElement, gateway: MCPGateway) {
  if (gateway.type === 'n8n-mcp-client') return true
  return container.querySelector(`#gateway-name-${gateway.id}`)
}

describe('BL-1369: a pick inside the 600 ms debounce sends the waiting save to its own gateway', () => {
  it('Gateway Settings: the waiting edit goes to the gateway it was typed for, with its own body, and none to the picked one', async () => {
    const { view, pick, onGatewayUpdated } = await mount(FILESYSTEM())
    await edit(field(view.container, '#stdio-args-gw-a'), ARGS_B)
    // A custom (URL) gateway: a save built from the live gateway would send its URL and auth key.
    await pick(CUSTOM())

    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(1), { timeout: 2000 })
    await settle()
    expect(puts.map((request) => request.id)).toEqual(['gw-a'])
    expect(puts[0].url).toBe(`/api/mcp/gateways/gw-a?userId=${USER}`)
    expect(argsOf(puts[0])).toBe(ARGS_B)
    expect(puts[0].body.name).toBe('Filesystem')
    expect(puts[0].body).not.toHaveProperty('url')
    expect(puts[0].body).not.toHaveProperty('authKeyName')
    expect(storedArgs('gw-a')).toBe(ARGS_B)
    // Every landed save still reaches the panel, here for a gateway that is no longer shown.
    expect(onGatewayUpdated.mock.calls[0][0].id).toBe('gw-a')
    // The shown card (the custom gateway) is not told it saved.
    expect(view.container.textContent).not.toContain('Settings Saved')
    expect(field(view.container, '#gateway-url-gw-c').value).toBe('https://search.example.com/mcp')
  })

  it('Gateway Settings: a Docker edit carries its own URL and metadata, not the picked STDIO gateway', async () => {
    const { view, pick } = await mount(DOCKER())
    await edit(field(view.container, '#docker-profile-gw-d'), 'work')
    await pick(FILESYSTEM())

    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await settle()
    expect(puts.map((request) => request.id)).toEqual(['gw-d'])
    expect(puts[0].body.url).toBe('http://localhost:8080/mcp')
    // BL-1377: only the profile this form manages; the stored catalogNote stays on the server.
    expect(puts[0].body.metadata).toEqual({ dockerProfile: 'work' })
    expect(puts[0].body).not.toHaveProperty('stdioConfig')
  })

  it('MCP Groups: a group added inside the debounce is saved to its own gateway, and none to the picked one', async () => {
    const { view, pick, onGatewayUpdated } = await mount(FILESYSTEM())
    await addGroup(view.container, 'github')
    await pick(OTHER())

    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(1), { timeout: 2000 })
    await settle()
    expect(puts.map((request) => request.id)).toEqual(['gw-a'])
    expect(puts[0].url).toBe(`/api/mcp/gateways/gw-a?userId=${USER}`)
    expect(puts[0].body).toEqual({ toolGroupings: [{ mcpName: 'github', toolIds: [] }] })
    expect(groupNames(stored.get('gw-a')!.toolGroupings)).toEqual(['github'])
    expect(onGatewayUpdated.mock.calls[0][0].id).toBe('gw-a')
  })

  it('Gateway Settings: picking an n8n MCP client source (read-only) still saves the waiting edit', async () => {
    const { view, pick } = await mount(FILESYSTEM())
    await edit(field(view.container, '#stdio-args-gw-a'), ARGS_B)
    await pick(N8N_CLIENT())

    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await settle()
    expect(puts.map((request) => request.id)).toEqual(['gw-a'])
    expect(argsOf(puts[0])).toBe(ARGS_B)
  })

  it('MCP Groups: picking an n8n MCP client source (read-only) still saves the waiting group', async () => {
    const { view, pick } = await mount(FILESYSTEM())
    await addGroup(view.container, 'github')
    await pick(N8N_CLIENT())

    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await settle()
    expect(puts.map((request) => request.id)).toEqual(['gw-a'])
    expect(puts[0].body).toEqual({ toolGroupings: [{ mcpName: 'github', toolIds: [] }] })
  })

  it('Gateway Settings: a save that fails after its gateway was left says which gateway, and the shown card shows no error', async () => {
    answerPut = (request) =>
      request.id === 'gw-a' ? NOT_STORED : saved(request)
    const { view, pick, onGatewayUpdated } = await mount(FILESYSTEM())
    await edit(field(view.container, '#stdio-args-gw-a'), ARGS_B)
    await pick(OTHER())

    await waitFor(() => expect(toast.error).toHaveBeenCalled(), { timeout: 2000 })
    expect(toastText()).toEqual(['Could not save Gateway Settings for "Filesystem": nothing was saved'])
    expect(view.container.textContent).not.toContain('nothing was saved')
    expect(onGatewayUpdated).not.toHaveBeenCalled()
    await settle()
    expect(puts.map((request) => request.id)).toEqual(['gw-a'])
  })

  it('MCP Groups: a group save that fails after its gateway was left says which gateway, and the shown card shows no error', async () => {
    answerPut = (request) =>
      request.id === 'gw-a' ? NOT_STORED : saved(request)
    const { view, pick, onGatewayUpdated } = await mount(FILESYSTEM())
    await addGroup(view.container, 'github')
    await pick(OTHER())

    await waitFor(() => expect(toast.error).toHaveBeenCalled(), { timeout: 2000 })
    expect(toastText()).toEqual(['Could not save MCP Groups for "Filesystem": nothing was saved'])
    expect(view.container.textContent).not.toContain('nothing was saved')
    expect(onGatewayUpdated).not.toHaveBeenCalled()
    await settle()
    expect(puts.map((request) => request.id)).toEqual(['gw-a'])
  })

  it('Gateway Settings and MCP Groups: picking away and back and a new copy write nothing', async () => {
    const withGroups = { ...FILESYSTEM(), toolGroupings: [{ mcpName: 'docs-group', toolIds: [] }] }
    stored.set('gw-a', withGroups)
    const { view, pick } = await mount(withGroups)
    await pick({ ...OTHER(), toolGroupings: [{ mcpName: 'other-group', toolIds: [] }] })
    await pick(CUSTOM())
    await pick(withGroups)
    // A Refresh's list reload: the same launch and groups, a newer stamp, a check result.
    await pick({
      ...withGroups,
      updated_at: '2026-10-11T15:00:30.000Z',
      stdioConfig: { ...withGroups.stdioConfig!, lastTestStatus: 'passed', toolCount: 3 }
    })

    await settle()
    expect(puts).toEqual([])
    expect(toast.error).not.toHaveBeenCalled()
    expect(field(view.container, '#stdio-args-gw-a').value).toBe(ARGS_A)
    expect(view.container.textContent).toContain('docs-group')
  })
})

describe('BL-1370: a gateway picked back while its own save is on its way is read-only until it answers', () => {
  it('Gateway Settings, the save lands: no edit before it, the saved launch after it, and the next edit keeps it', async () => {
    const first = held()
    answerPut = (request, index) => (index === 0 ? first.answer : saved(request))
    const { view, pick, onGatewayUpdated } = await mount(FILESYSTEM())
    await edit(field(view.container, '#stdio-args-gw-a'), ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })

    await pick(OTHER())
    // The panel still holds the copy from before the save.
    await pick(FILESYSTEM())
    const readOnlyAtPickBack = !editable(field(view.container, '#gateway-name-gw-a'))
    const noteAtPickBack = view.container.textContent?.includes('Waiting for saved gateway settings')
    const editedEarly = await editIfAllowed(field(view.container, '#gateway-name-gw-a'), 'Files')

    first.release(saved(puts[0]))
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(1))
    await pick(onGatewayUpdated.mock.calls[0][0])
    if (!editedEarly) {
      expect(await editIfAllowed(field(view.container, '#gateway-name-gw-a'), 'Files')).toBe(true)
    }
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })
    await settle()

    // The landed launch is never sent back as the old one.
    expect(puts.map(argsOf)).toEqual([ARGS_B, ARGS_B])
    expect(puts[1].body.name).toBe('Files')
    expect(storedArgs('gw-a')).toBe(ARGS_B)
    expect(readOnlyAtPickBack).toBe(true)
    expect(noteAtPickBack).toBe(true)
    expect(editedEarly).toBe(false)
    expect(field(view.container, '#stdio-args-gw-a').value).toBe(ARGS_B)
    expect(view.container.textContent).not.toContain('Waiting for saved gateway settings')
  })

  it('Gateway Settings, the save stores nothing (409): the form opens with the stored copy, the failure names the gateway, nothing is sent again', async () => {
    const first = held()
    answerPut = (request, index) => (index === 0 ? first.answer : saved(request))
    const { view, pick, onGatewayUpdated } = await mount(FILESYSTEM())
    await edit(field(view.container, '#stdio-args-gw-a'), ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })

    await pick(OTHER())
    await pick(FILESYSTEM())
    const readOnlyAtPickBack = !editable(field(view.container, '#stdio-args-gw-a'))

    first.release(NOT_STORED)
    await waitFor(() => expect(toast.error).toHaveBeenCalled(), { timeout: 2000 })
    await settle()

    expect(toastText()).toEqual(['Could not save Gateway Settings for "Filesystem": nothing was saved'])
    expect(puts).toHaveLength(1)
    expect(onGatewayUpdated).not.toHaveBeenCalled()
    expect(readOnlyAtPickBack).toBe(true)
    expect(editable(field(view.container, '#stdio-args-gw-a'))).toBe(true)
    expect(field(view.container, '#stdio-args-gw-a').value).toBe(ARGS_A)
    expect(view.container.textContent).not.toContain('Waiting for saved gateway settings')
  })

  it('Gateway Settings, two saves answer out of order: the read-only form takes the newest copy, and the next edit keeps it', async () => {
    const first = held()
    const second = held()
    answerPut = (request, index) => (index === 0 ? first.answer : index === 1 ? second.answer : saved(request))
    const ARGS_C = '-y\n@modelcontextprotocol/server-filesystem\n/Users/example/c'
    const { view, pick, onGatewayUpdated } = await mount(FILESYSTEM())
    await edit(field(view.container, '#stdio-args-gw-a'), ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    // Typed while the first save is on its way: a second save goes out (BL-550).
    await edit(field(view.container, '#stdio-args-gw-a'), ARGS_C)
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })

    await pick(OTHER())
    await pick(FILESYSTEM())
    // The server stored them in order (B, then C); the answers come back C first, then B.
    const storedB = saved(puts[0])
    const storedC = saved(puts[1])
    second.release(storedC)
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(1))
    await pick(onGatewayUpdated.mock.calls[0][0])
    const stillReadOnly = !editable(field(view.container, '#gateway-name-gw-a'))
    first.release(storedB)
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(2))
    // The panel takes every landed copy, so it now passes the older one down.
    await pick(onGatewayUpdated.mock.calls[1][0])

    expect(await editIfAllowed(field(view.container, '#gateway-name-gw-a'), 'Files')).toBe(true)
    await waitFor(() => expect(puts).toHaveLength(3), { timeout: 2000 })
    await settle()

    expect(argsOf(puts[2])).toBe(ARGS_C)
    expect(storedArgs('gw-a')).toBe(ARGS_C)
    expect(stillReadOnly).toBe(true)
  })

  it('MCP Groups, the save lands: no group change before it, the saved groups after it, and the next change keeps them', async () => {
    const first = held()
    answerPut = (request, index) => (index === 0 ? first.answer : saved(request))
    const { view, pick, onGatewayUpdated } = await mount(FILESYSTEM())
    await addGroup(view.container, 'github')
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })

    await pick(OTHER())
    await pick(FILESYSTEM())
    const readOnlyAtPickBack = !editable(addGroupButton(view.container))
    const noteAtPickBack = view.container.textContent?.includes('Waiting for saved MCP groups')
    const changedEarly = await addGroupIfAllowed(view.container, 'slack')

    first.release(saved(puts[0]))
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(1))
    await pick(onGatewayUpdated.mock.calls[0][0])
    if (!changedEarly) {
      expect(await addGroupIfAllowed(view.container, 'slack')).toBe(true)
    }
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })
    await settle()

    expect(puts.map((request) => groupNames(request.body.toolGroupings))).toEqual([['github'], ['github', 'slack']])
    expect(groupNames(stored.get('gw-a')!.toolGroupings)).toEqual(['github', 'slack'])
    expect(readOnlyAtPickBack).toBe(true)
    expect(noteAtPickBack).toBe(true)
    expect(changedEarly).toBe(false)
  })

  it('MCP Groups, the save stores nothing (409): the editor opens with the stored groups, the failure names the gateway, nothing is sent again', async () => {
    const first = held()
    answerPut = (request, index) => (index === 0 ? first.answer : saved(request))
    const { view, pick, onGatewayUpdated } = await mount(FILESYSTEM())
    await addGroup(view.container, 'github')
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })

    await pick(OTHER())
    await pick(FILESYSTEM())
    const readOnlyAtPickBack = !editable(addGroupButton(view.container))

    first.release(NOT_STORED)
    await waitFor(() => expect(toast.error).toHaveBeenCalled(), { timeout: 2000 })
    await settle()

    expect(toastText()).toEqual(['Could not save MCP Groups for "Filesystem": nothing was saved'])
    expect(puts).toHaveLength(1)
    expect(onGatewayUpdated).not.toHaveBeenCalled()
    expect(readOnlyAtPickBack).toBe(true)
    expect(editable(addGroupButton(view.container))).toBe(true)
    expect(view.container.textContent).not.toContain('github')
    expect(view.container.textContent).not.toContain('Waiting for saved MCP groups')
  })
})

describe('BL-1370: only the gateway picked back is read-only, and the rule survives a card that goes away', () => {
  it('MCP Groups, two saves answer out of order: the read-only editor takes the newest copy, and the next change keeps it', async () => {
    const first = held()
    const second = held()
    answerPut = (request, index) => (index === 0 ? first.answer : index === 1 ? second.answer : saved(request))
    const { view, pick, onGatewayUpdated } = await mount(FILESYSTEM())
    await addGroup(view.container, 'github')
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await addGroup(view.container, 'slack')
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })

    await pick(OTHER())
    await pick(FILESYSTEM())
    const storedGithub = saved(puts[0])
    const storedBoth = saved(puts[1])
    second.release(storedBoth)
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(1))
    await pick(onGatewayUpdated.mock.calls[0][0])
    const stillReadOnly = !editable(addGroupButton(view.container))
    first.release(storedGithub)
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(2))
    await pick(onGatewayUpdated.mock.calls[1][0])

    expect(await addGroupIfAllowed(view.container, 'linear')).toBe(true)
    await waitFor(() => expect(puts).toHaveLength(3), { timeout: 2000 })
    await settle()

    expect(groupNames(puts[2].body.toolGroupings)).toEqual(['github', 'slack', 'linear'])
    expect(stillReadOnly).toBe(true)
  })

  it('MCP Groups: a change typed while its own save is on its way is not blocked, and goes next', async () => {
    const first = held()
    answerPut = (request, index) => (index === 0 ? first.answer : saved(request))
    const { view, onGatewayUpdated } = await mount(FILESYSTEM())
    await addGroup(view.container, 'github')
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })

    const changed = await addGroupIfAllowed(view.container, 'slack')
    first.release(saved(puts[0]))
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(2), { timeout: 2000 })

    expect(changed).toBe(true)
    expect(groupNames(puts[1].body.toolGroupings)).toEqual(['github', 'slack'])
    expect(view.container.textContent).not.toContain('Waiting for saved MCP groups')
  })

  it('Gateway Settings: a gateway picked back through an n8n source is read-only, and another gateway stays editable meanwhile', async () => {
    const first = held()
    answerPut = (request, index) => (index === 0 ? first.answer : saved(request))
    const { view, pick, onGatewayUpdated } = await mount(FILESYSTEM())
    await edit(field(view.container, '#stdio-args-gw-a'), ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })

    await pick(N8N_CLIENT())
    await pick(FILESYSTEM())
    const readOnlyAfterN8n = !editable(field(view.container, '#stdio-args-gw-a'))
    // Another gateway while the first one's save is still on its way: nothing of the lock follows.
    await pick(OTHER())
    const otherEditable = editable(field(view.container, '#gateway-name-gw-x'))
    expect(await editIfAllowed(field(view.container, '#gateway-name-gw-x'), 'Other 2')).toBe(true)
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })
    first.release(saved(puts[0]))
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(2), { timeout: 2000 })
    await settle()

    expect(readOnlyAfterN8n).toBe(true)
    expect(otherEditable).toBe(true)
    expect(view.container.textContent).not.toContain('Waiting for saved gateway settings')
    expect(puts.map((request) => request.id)).toEqual(['gw-a', 'gw-x'])
    expect(puts[1].body.name).toBe('Other 2')
    expect(argsOf(puts[0])).toBe(ARGS_B)
  })

  it('Gateway Settings: a card that goes away sends its waiting save at once, and the next card is read-only for that gateway until it lands', async () => {
    const first = held()
    answerPut = (request, index) => (index === 0 ? first.answer : saved(request))
    // The panel outlives the card (the Tools tab changed and came back): one handler for both cards.
    const onGatewayUpdated = vi.fn()
    const old = await mount(FILESYSTEM(), onGatewayUpdated)
    await edit(field(old.view.container, '#stdio-args-gw-a'), ARGS_B)
    old.view.unmount()
    // Sent at once, not 600 ms later from a card that is gone.
    expect(puts.map(argsOf)).toEqual([ARGS_B])

    const next = await mount(FILESYSTEM(), onGatewayUpdated)
    const readOnlyAtMount = !editable(field(next.view.container, '#gateway-name-gw-a'))
    const noteAtMount = next.view.container.textContent?.includes('Waiting for saved gateway settings')
    const editedEarly = await editIfAllowed(field(next.view.container, '#gateway-name-gw-a'), 'Files')

    first.release(saved(puts[0]))
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalled())
    await next.pick(onGatewayUpdated.mock.calls.at(-1)![0])
    if (!editedEarly) {
      expect(await editIfAllowed(field(next.view.container, '#gateway-name-gw-a'), 'Files')).toBe(true)
    }
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })
    await settle()

    expect(puts.map(argsOf)).toEqual([ARGS_B, ARGS_B])
    expect(puts[1].body.name).toBe('Files')
    expect(readOnlyAtMount).toBe(true)
    expect(noteAtMount).toBe(true)
    expect(editedEarly).toBe(false)
  })

  it('MCP Groups: Settings closed and opened while a group save is on its way: the new card is read-only for MCP Groups until it lands, and its panel gets the landed copy', async () => {
    const first = held()
    answerPut = (request, index) => (index === 0 ? first.answer : saved(request))
    // The old panel is gone with its card; the new panel read the list before the save landed.
    const oldPanel = vi.fn()
    const newPanel = vi.fn()
    const old = await mount(FILESYSTEM(), oldPanel)
    await addGroup(old.view.container, 'github')
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    old.view.unmount()

    const next = await mount(FILESYSTEM(), newPanel)
    const readOnlyAtMount = !editable(addGroupButton(next.view.container))
    const changedEarly = await addGroupIfAllowed(next.view.container, 'slack')

    first.release(saved(puts[0]))
    await waitFor(() => expect(newPanel).toHaveBeenCalledTimes(1))
    expect(groupNames(newPanel.mock.calls[0][0].toolGroupings)).toEqual(['github'])
    await next.pick(newPanel.mock.calls[0][0])
    if (!changedEarly) {
      expect(await addGroupIfAllowed(next.view.container, 'slack')).toBe(true)
    }
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })
    await settle()

    expect(puts.map((request) => groupNames(request.body.toolGroupings))).toEqual([['github'], ['github', 'slack']])
    expect(readOnlyAtMount).toBe(true)
    expect(changedEarly).toBe(false)
  })

  it('MCP Groups: a tool list that answers after its gateway was left never fills the editor of the picked gateway', async () => {
    let releaseFirstTools: (value: unknown) => void = () => {}
    const firstTools = new Promise((resolve) => {
      releaseFirstTools = resolve
    })
    const toolList = (mcp: string, toolId: string) => ({ mcps: [{ name: mcp, tools: [{ id: toolId, mcpName: mcp }] }] })
    answerTools = (gatewayId) => (gatewayId === 'gw-a' ? firstTools : toolList('other', 'other_search'))
    const { view, pick } = await mount(FILESYSTEM())
    await pick(OTHER())
    await waitFor(() => expect(view.container.textContent).toContain('other_search'))

    releaseFirstTools(toolList('filesystem', 'filesystem_read'))
    await settle(200)

    expect(view.container.textContent).toContain('other_search')
    expect(view.container.textContent).not.toContain('filesystem_read')
  })
})

describe('BL-1369: the queued save is the only one that may say saved, and a dropped draft sends nothing', () => {
  it('a landed save does not say saved while a newer edit waits', async () => {
    const first = held()
    answerPut = (request, index) => (index === 0 ? first.answer : saved(request))
    const { view, onGatewayUpdated } = await mount(FILESYSTEM())
    await edit(field(view.container, '#stdio-args-gw-a'), ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await edit(field(view.container, '#gateway-name-gw-a'), 'Files')

    first.release(saved(puts[0]))
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(1))
    const textAfterFirstLanding = view.container.textContent
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(2), { timeout: 2000 })

    expect(textAfterFirstLanding).toContain('Saving...')
    expect(textAfterFirstLanding).not.toContain('Settings Saved')
    expect(puts[1].body.name).toBe('Files')
    await waitFor(() => expect(view.container.textContent).toContain('Settings Saved'))
  })

  it('a draft taken back to its baseline, or made invalid, inside the debounce sends nothing', async () => {
    const { view } = await mount(FILESYSTEM())
    await edit(field(view.container, '#stdio-args-gw-a'), ARGS_B)
    await edit(field(view.container, '#stdio-args-gw-a'), ARGS_A)
    await settle()
    expect(puts).toEqual([])
    expect(view.container.textContent).not.toContain('Saving...')

    await edit(field(view.container, '#stdio-args-gw-a'), ARGS_B)
    // STDIO needs a command: the queued save is dropped.
    await edit(field(view.container, '#stdio-command-gw-a'), '')
    await settle()
    expect(puts).toEqual([])
    expect(view.container.textContent).not.toContain('Saving...')
  })
})
