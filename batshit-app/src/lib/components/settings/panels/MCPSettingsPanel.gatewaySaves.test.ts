import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MCPGateway } from '$lib/types/database'

import { resetGatewaySaveStateForTest } from '$lib/components/mcps/gatewaySaveState'
import MCPSettingsPanel from './MCPSettingsPanel.svelte'

// BL-1393 / BL-1394: the MCP Sources panel with the real Gateway Settings card. Only the routes
// are fakes: the list read, the gateway PUT and GET, Refresh, tools, API keys and the CLI Tools
// list (the Tools tab the card leaves when it is mounted again). The PUT and GET fakes keep the
// stored gateways, so a save can be stored and still answer 500, as the route does when a CLI
// profile sync fails after the write.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('svelte-sonner', () => ({ toast }))
vi.mock('$lib/components/ui/sonner/settings-toast', () => ({ toast }))
vi.mock('$app/navigation', () => ({ goto: vi.fn() }))

const USER = 'bl1394_user'
// One object, as the Settings sheet passes it.
const PANEL_DATA = { user: { id: USER } }
const ARGS_A = '-y\n@modelcontextprotocol/server-filesystem\n/tmp'
const ARGS_B = '-y\n@modelcontextprotocol/server-filesystem\n/Users/example/b'
const ARGS_C = '-y\n@modelcontextprotocol/server-filesystem\n/Users/example/c'
const T0 = '2026-10-11T15:00:00.000Z'
const STORED_THEN_FAILED = 'Failed to update gateway'
const NOTHING_SAVED = 'The MCP gateways kept changing while this was being saved, so nothing was saved. Try again.'

function stdio(id: string, name: string, args: string, updatedAt: string): MCPGateway {
  return {
    id,
    name,
    type: 'stdio',
    enabled: true,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: updatedAt,
    stdioConfig: { command: 'npx', args: args.split('\n'), cwdPolicy: 'none', startupTimeoutMs: 10000, toolCallTimeoutMs: 60000, lastTestStatus: 'never' }
  }
}

type Held<T> = { answer: Promise<T>; release: (value: T) => void }
function held<T>(): Held<T> {
  let release: (value: T) => void = () => {}
  const answer = new Promise<T>((resolve) => (release = resolve))
  return { answer, release }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type PutRequest = { id: string; body: any }

let stored: Map<string, MCPGateway>
let stamp: number
let listAnswers: Array<() => unknown | Promise<unknown>>
let putAnswer: (request: PutRequest, index: number) => Response | Promise<Response>
let getAnswer: (id: string) => Response | Promise<Response>
let puts: PutRequest[]
let gets: string[]
let listReads: number

/** The route's write: the gateway as stored, with a new stamp (or the one given). */
function store(request: PutRequest, updatedAt?: string): MCPGateway {
  const current = stored.get(request.id)
  if (!current) throw new Error(`no stored gateway ${request.id}`)
  stamp += 1
  const next: MCPGateway = {
    ...current,
    ...(request.body.name !== undefined ? { name: request.body.name } : {}),
    ...(request.body.toolGroupings !== undefined ? { toolGroupings: request.body.toolGroupings } : {}),
    ...(request.body.stdioConfig !== undefined ? { stdioConfig: { ...current.stdioConfig!, ...request.body.stdioConfig } } : {}),
    updated_at: updatedAt ?? new Date(Date.parse(T0) + stamp * 1000).toISOString()
  }
  stored.set(request.id, next)
  return next
}

const savedAnswer = (request: PutRequest) => json(200, { gateway: store(request) })

beforeEach(() => {
  resetGatewaySaveStateForTest()
  toast.error.mockClear()
  stored = new Map(
    [stdio('gw-a', 'Filesystem', ARGS_A, T0), stdio('gw-x', 'Other', '-y\nother', '2026-10-11T14:00:00.000Z')].map(
      (gateway) => [gateway.id, gateway]
    )
  )
  stamp = 0
  puts = []
  gets = []
  listReads = 0
  listAnswers = []
  putAnswer = savedAnswer
  getAnswer = (id) => json(200, { gateway: stored.get(id) })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/settings/api-keys')) return json(200, { success: true, keys: {} })
      if (url.startsWith('/api/cli-tools')) return json(200, { tools: [] })
      if (url.includes('/tools')) return json(200, { mcps: [] })
      if (url.includes('/refresh')) return json(200, { success: true, tools: [] })
      if (url.startsWith('/api/mcp/gateways?')) {
        listReads += 1
        const next = listAnswers.shift()
        return json(200, next ? await next() : { gateways: [...stored.values()] })
      }
      if (url.startsWith('/api/mcp/gateways/')) {
        const id = decodeURIComponent(url.split('/api/mcp/gateways/')[1].split('?')[0])
        if (init?.method === 'PUT') {
          const request = { id, body: JSON.parse(String(init.body)) }
          puts.push(request)
          return putAnswer(request, puts.length - 1)
        }
        if (!init?.method || init.method === 'GET') {
          gets.push(id)
          return getAnswer(id)
        }
      }
      throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`)
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms))

function sourceButton(container: HTMLElement, name: string) {
  const button = Array.from(container.querySelectorAll('button.settings-sidebar-item')).find((entry) =>
    entry.textContent?.includes(name)
  )
  if (!button) throw new Error(`no source button ${name}`)
  return button as HTMLButtonElement
}

function argsField(container: HTMLElement, id: string) {
  return container.querySelector(`#stdio-args-${id}`) as HTMLTextAreaElement | null
}

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

function buttonWithText(container: HTMLElement, text: string) {
  return (Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === text) ??
    null) as HTMLButtonElement | null
}

async function addGroupIfAllowed(container: HTMLElement, groupName: string) {
  const button = buttonWithText(container, 'Add MCP Group')
  if (!button || !editable(button)) return false
  await fireEvent.click(button)
  const input = await waitFor(() => {
    const element = container.querySelector('input[placeholder="New MCP group name"]')
    if (!element) throw new Error('no group input yet')
    return element as HTMLInputElement
  })
  await fireEvent.input(input, { target: { value: groupName } })
  await fireEvent.keyDown(input, { key: 'Enter' })
  return true
}

function argsOf(request: PutRequest) {
  return request.body.stdioConfig?.args?.join('\n')
}

function groupsOf(request: PutRequest) {
  return (request.body.toolGroupings ?? []).map((group: { mcpName: string }) => group.mcpName)
}

function toastText() {
  return toast.error.mock.calls.map((call) => String(call[0]))
}

async function mountPanel() {
  const view = render(MCPSettingsPanel, { props: { data: PANEL_DATA } })
  await waitFor(() => sourceButton(view.container, 'Filesystem'))
  await fireEvent.click(sourceButton(view.container, 'Filesystem'))
  await waitFor(() => expect(argsField(view.container, 'gw-a')?.value).toBe(ARGS_A))
  return view
}

async function pickAwayAndBack(view: Awaited<ReturnType<typeof mountPanel>>) {
  await fireEvent.click(sourceButton(view.container, 'Other'))
  await fireEvent.click(sourceButton(view.container, 'Filesystem'))
  await waitFor(() => expect(argsField(view.container, 'gw-a')).toBeTruthy())
}

function toolsTab(container: HTMLElement, label: string) {
  const trigger = Array.from(container.querySelectorAll('[role="tab"]')).find((entry) => entry.textContent?.includes(label))
  if (!trigger) throw new Error(`no Tools tab ${label}`)
  return trigger as HTMLElement
}

/**
 * The Tools tab changes and comes back: the panel stays (with the copies it holds; no list read),
 * the card is mounted again. A rerender here would hand the panel every prop again and make it
 * read the list, which the Settings sheet does not do.
 */
async function mountCardAgain(view: Awaited<ReturnType<typeof mountPanel>>) {
  const listReadsBefore = listReads
  await fireEvent.click(toolsTab(view.container, 'CLI Tools'))
  await waitFor(() => expect(argsField(view.container, 'gw-a')).toBeNull())
  await fireEvent.click(toolsTab(view.container, 'MCP Sources'))
  await waitFor(() => expect(argsField(view.container, 'gw-a')).toBeTruthy())
  expect(listReads).toBe(listReadsBefore)
}

describe('BL-1394: the panel never installs an older gateway copy over a newer one', () => {
  it('a list read that started before a save landed does not take the save back, so picking away and back shows the saved launch', async () => {
    const A0 = stdio('gw-a', 'Filesystem', ARGS_A, '2026-10-11T15:00:00.000Z')
    const X = stdio('gw-x', 'Other', '-y\nother', '2026-10-11T14:00:00.000Z')
    listAnswers.push(() => ({ gateways: [A0, X] }))
    const view = render(MCPSettingsPanel, { props: { data: PANEL_DATA } })
    await waitFor(() => sourceButton(view.container, 'Filesystem'))
    await fireEvent.click(sourceButton(view.container, 'Filesystem'))
    await waitFor(() => expect(argsField(view.container, 'gw-a')?.value).toBe(ARGS_A))

    // The save is on its way; a list read starts (as a Refresh's reload would) and answers late.
    const save = held<Response>()
    putAnswer = () => save.answer
    const staleList = held<unknown>()
    listAnswers.push(() => staleList.answer)
    await fireEvent.input(argsField(view.container, 'gw-a')!, { target: { value: ARGS_B } })
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    const refresh = Array.from(view.container.querySelectorAll('button')).find((button) =>
      /refresh/i.test(button.getAttribute('aria-label') ?? button.textContent ?? '')
    )
    expect(refresh).toBeTruthy()
    await fireEvent.click(refresh!)
    save.release(json(200, { gateway: stdio('gw-a', 'Filesystem', ARGS_B, '2026-10-11T15:00:05.000Z') }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    staleList.release({ gateways: [A0, X] })
    await new Promise((resolve) => setTimeout(resolve, 50))

    await fireEvent.click(sourceButton(view.container, 'Other'))
    await fireEvent.click(sourceButton(view.container, 'Filesystem'))
    await waitFor(() => expect(argsField(view.container, 'gw-a')).toBeTruthy())
    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_B)
  })

  it('an older save answering after a newer one is dropped: picking away and back, and mounting the card again, show the newer launch, and nothing is sent again', async () => {
    const view = await mountPanel()
    const first = held<Response>()
    const second = held<Response>()
    putAnswer = (request, index) => (index === 0 ? first.answer : index === 1 ? second.answer : savedAnswer(request))
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await edit(argsField(view.container, 'gw-a')!, ARGS_C)
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })

    // The server stored B, then C; the answers come back C first, then B.
    const storedB = store(puts[0])
    const storedC = store(puts[1])
    second.release(json(200, { gateway: storedC }))
    await settle(50)
    first.release(json(200, { gateway: storedB }))
    await settle()
    const putsAfterLandings = puts.length

    await pickAwayAndBack(view)
    const afterPick = argsField(view.container, 'gw-a')!.value
    await mountCardAgain(view)
    const afterRemount = argsField(view.container, 'gw-a')!.value
    expect(await editIfAllowed(field(view.container, '#gateway-name-gw-a'), 'Files')).toBe(true)
    await waitFor(() => expect(puts.length).toBeGreaterThan(putsAfterLandings), { timeout: 2000 })
    await settle()

    expect(afterPick).toBe(ARGS_C)
    expect(afterRemount).toBe(ARGS_C)
    expect(argsOf(puts.at(-1)!)).toBe(ARGS_C)
    expect(putsAfterLandings).toBe(2)
  })

  it('a landed copy whose stamp equals the held one proves no order: the panel reads the saved gateway and shows that', async () => {
    const view = await mountPanel()
    const first = held<Response>()
    const second = held<Response>()
    putAnswer = (request, index) => (index === 0 ? first.answer : index === 1 ? second.answer : savedAnswer(request))
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await edit(argsField(view.container, 'gw-a')!, ARGS_C)
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })

    // Both writes stored within the same millisecond: equal stamps. C is stored last.
    const SAME = '2026-10-11T15:00:09.000Z'
    const storedB = store(puts[0], SAME)
    const storedC = store(puts[1], SAME)
    second.release(json(200, { gateway: storedC }))
    await settle(50)
    first.release(json(200, { gateway: storedB }))
    await settle(200)

    await pickAwayAndBack(view)
    await settle(200)
    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_C)
    expect(gets).toEqual(['gw-a'])
    expect(puts).toHaveLength(2)
  })

  it('equal stamps where the server stored the other save last: the read, not the order of the answers, decides what is shown', async () => {
    const view = await mountPanel()
    const first = held<Response>()
    const second = held<Response>()
    putAnswer = (request, index) => (index === 0 ? first.answer : index === 1 ? second.answer : savedAnswer(request))
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await edit(argsField(view.container, 'gw-a')!, ARGS_C)
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })

    // The same millisecond, and the server stored C first, then B: it holds B.
    const SAME = '2026-10-11T15:00:09.000Z'
    const storedC = store(puts[1], SAME)
    const storedB = store(puts[0], SAME)
    second.release(json(200, { gateway: storedC }))
    await settle(50)
    first.release(json(200, { gateway: storedB }))
    await settle(200)

    await pickAwayAndBack(view)
    await settle(200)
    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_B)
    expect(gets).toEqual(['gw-a'])
  })

  it('a card mounted again while its save is out: the landed copy reaches the panel twice and the panel does not read again', async () => {
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await mountCardAgain(view)

    // The old card's own answer installs it; the new, read-only card passes the same copy on.
    save.release(savedAnswer(puts[0]))
    await settle()

    expect(gets).toEqual([])
    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_B)
    expect(editable(field(view.container, '#stdio-args-gw-a'))).toBe(true)
  })

  it('a save that lands on a record with no stamp proves no order: a picked-back form stays read-only until the panel has read the saved gateway', async () => {
    const legacy = stored.get('gw-a')!
    delete legacy.updated_at
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    const read = held<Response>()
    getAnswer = () => read.answer
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await pickAwayAndBack(view)

    save.release(savedAnswer(puts[0]))
    await settle(200)
    const readOnlyWhileReading = !editable(field(view.container, '#gateway-name-gw-a'))
    read.release(json(200, { gateway: stored.get('gw-a') }))
    await settle(200)
    expect(await editIfAllowed(field(view.container, '#gateway-name-gw-a'), 'Files')).toBe(true)
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })
    await settle()

    expect(readOnlyWhileReading).toBe(true)
    expect(argsOf(puts[1])).toBe(ARGS_B)
    expect(gets).toEqual(['gw-a'])
  })

  it('Settings reopened while a save is out on a record with no stamp: the new read-only form waits for the new panel to read the saved gateway', async () => {
    delete stored.get('gw-a')!.updated_at
    const first = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    await edit(argsField(first.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    first.unmount()

    const view = await mountPanel()
    const gate = held<void>()
    getAnswer = async (id) => {
      await gate.answer
      return json(200, { gateway: stored.get(id) })
    }
    // The landing reaches the closed panel through its own card; the new card passes it on.
    save.release(savedAnswer(puts[0]))
    await settle(200)
    const readOnlyWhileReading = !editable(field(view.container, '#gateway-name-gw-a'))
    gate.release()
    await settle(200)
    expect(await editIfAllowed(field(view.container, '#gateway-name-gw-a'), 'Files')).toBe(true)
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })
    await settle()

    expect(readOnlyWhileReading).toBe(true)
    expect(argsOf(puts[1])).toBe(ARGS_B)
    expect(gets).toEqual(['gw-a'])
  })

  it('Settings reopened while a save is out, another source shown when it lands: the new panel still takes the landed copy, so a later pick shows it', async () => {
    const first = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    await edit(argsField(first.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    first.unmount()

    // The new panel's list is served before the save is stored, and another source is shown.
    const view = render(MCPSettingsPanel, { props: { data: PANEL_DATA } })
    await waitFor(() => sourceButton(view.container, 'Other'))
    await fireEvent.click(sourceButton(view.container, 'Other'))
    await waitFor(() => expect(view.container.querySelector('#gateway-name-gw-x')).toBeTruthy())
    save.release(savedAnswer(puts[0]))
    await settle(200)
    await fireEvent.click(sourceButton(view.container, 'Filesystem'))
    await waitFor(() => expect(argsField(view.container, 'gw-a')).toBeTruthy())

    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_B)
    expect(gets).toEqual([])
    expect(puts).toHaveLength(1)
  })

  it('Settings reopened while a save is out, no card yet when it lands: the landed copy waits for the list and is kept over its older copy', async () => {
    const first = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    await edit(argsField(first.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    first.unmount()

    // The new panel's list is served before the save is stored and answers after it lands.
    const list = held<unknown>()
    const listedBeforeTheSave = [...stored.values()]
    listAnswers.push(() => list.answer)
    const view = render(MCPSettingsPanel, { props: { data: PANEL_DATA } })
    await waitFor(() => expect(listReads).toBe(2), { timeout: 2000 })
    save.release(savedAnswer(puts[0]))
    await settle(200)
    list.release({ gateways: listedBeforeTheSave })
    await waitFor(() => sourceButton(view.container, 'Filesystem'))
    await fireEvent.click(sourceButton(view.container, 'Filesystem'))
    await waitFor(() => expect(argsField(view.container, 'gw-a')).toBeTruthy())

    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_B)
    expect(gets).toEqual([])
    expect(puts).toHaveLength(1)
  })

  it('Settings reopened while a save is out: a read that answers before the new panel lists the gateway is kept over the older listed copy', async () => {
    const first = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    await edit(argsField(first.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    first.unmount()

    // The new panel's list read reaches the server before the save is stored, and answers last.
    const list = held<unknown>()
    const listedBeforeTheSave = [...stored.values()]
    listAnswers.push(() => list.answer)
    const view = render(MCPSettingsPanel, { props: { data: PANEL_DATA } })
    await waitFor(() => expect(listReads).toBe(2), { timeout: 2000 })
    store(puts[0])
    save.release(json(500, { error: STORED_THEN_FAILED }))
    await waitFor(() => expect(gets).toEqual(['gw-a']), { timeout: 2000 })
    await settle(100)
    list.release({ gateways: listedBeforeTheSave })
    await waitFor(() => sourceButton(view.container, 'Filesystem'))
    await fireEvent.click(sourceButton(view.container, 'Filesystem'))
    await waitFor(() => expect(argsField(view.container, 'gw-a')).toBeTruthy())

    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_B)
    expect(puts).toHaveLength(1)
  })

  it('a list read that started after a read of the saved gateway but answers with an older copy does not replace it; the panel reads again', async () => {
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    const reads: Array<Held<Response>> = []
    getAnswer = () => {
      const read = held<Response>()
      reads.push(read)
      return read.answer
    }
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    const storedB = store(puts[0])
    save.release(json(500, { error: STORED_THEN_FAILED }))
    await waitFor(() => expect(gets).toEqual(['gw-a']), { timeout: 2000 })

    // A Refresh starts a list read after that read. The server answers the list before another
    // window's write, and the read after it.
    const list = held<unknown>()
    listAnswers.push(() => list.answer)
    const refresh = Array.from(view.container.querySelectorAll('button')).find((button) =>
      /refresh/i.test(button.getAttribute('aria-label') ?? button.textContent ?? '')
    )
    await fireEvent.click(refresh!)
    await waitFor(() => expect(listReads).toBe(2), { timeout: 2000 })
    const storedC = store({ id: 'gw-a', body: { stdioConfig: { args: ARGS_C.split('\n') } } })
    reads[0].release(json(200, { gateway: storedC }))
    await settle(50)
    list.release({ gateways: [storedB, stored.get('gw-x')] })
    await settle(200)
    reads[1]?.release(json(200, { gateway: stored.get('gw-a') }))
    await settle(200)

    await pickAwayAndBack(view)
    await settle(200)
    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_C)
    expect(gets).toEqual(['gw-a', 'gw-a'])
    expect(puts).toHaveLength(1)
  })
})

describe('BL-1393: a failed save that may have been stored keeps a stale form from writing until the saved gateway is read', () => {
  it('Gateway Settings, stored then 500 on a picked-back form: read-only until a read of the saved gateway, which it then shows; the next edit keeps it', async () => {
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    const read = held<Response>()
    getAnswer = () => read.answer
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await pickAwayAndBack(view)

    // The server stores the save, then its CLI profile sync fails.
    store(puts[0])
    save.release(json(500, { error: STORED_THEN_FAILED }))
    await settle(200)
    const readOnlyWhileReading = !editable(field(view.container, '#gateway-name-gw-a'))
    const noteWhileReading = view.container.textContent?.includes('Checking the saved gateway')
    read.release(json(200, { gateway: stored.get('gw-a') }))
    await settle(200)
    expect(await editIfAllowed(field(view.container, '#gateway-name-gw-a'), 'Files')).toBe(true)
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })
    await settle()

    expect(argsOf(puts[1])).toBe(ARGS_B)
    expect(puts[1].body.name).toBe('Files')
    expect(readOnlyWhileReading).toBe(true)
    expect(noteWhileReading).toBe(true)
    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_B)
    expect(toastText()).toEqual([
      `Could not confirm the Gateway Settings save for "Filesystem": ${STORED_THEN_FAILED}. Batshit is reading the saved gateway.`
    ])
    expect(gets).toEqual(['gw-a'])
  })

  it('Gateway Settings, a 409 (nothing stored) on a picked-back form: it opens with the panel copy, the notice says it could not save, and nothing is read or sent again', async () => {
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await pickAwayAndBack(view)

    save.release(json(409, { error: NOTHING_SAVED }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled(), { timeout: 2000 })
    await settle()

    expect(toastText()).toEqual([`Could not save Gateway Settings for "Filesystem": ${NOTHING_SAVED}`])
    expect(editable(field(view.container, '#stdio-args-gw-a'))).toBe(true)
    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_A)
    expect(gets).toEqual([])
    expect(puts).toHaveLength(1)
  })

  it('a failed read of the saved gateway keeps the form read-only with Retry, never reads again by itself, survives the card being mounted again, and Retry opens it with the saved launch', async () => {
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    getAnswer = () => json(500, { error: 'Failed to get gateway' })
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await pickAwayAndBack(view)

    store(puts[0])
    save.release(json(500, { error: STORED_THEN_FAILED }))
    await settle()
    const readOnlyAfterFailedRead = !editable(field(view.container, '#stdio-args-gw-a'))
    const failureShown = view.container.textContent?.includes(
      'Batshit could not read the saved gateway: Failed to get gateway. This section stays read-only until it can.'
    )
    const readsBeforeRetry = gets.length

    await mountCardAgain(view)
    const readOnlyAfterRemount = !editable(field(view.container, '#stdio-args-gw-a'))
    const retry = buttonWithText(view.container, 'Retry')
    const retryUsable = retry ? editable(retry) : false
    getAnswer = (id) => json(200, { gateway: stored.get(id) })
    if (retry) await fireEvent.click(retry)
    await settle(200)

    expect(readOnlyAfterFailedRead).toBe(true)
    expect(failureShown).toBe(true)
    expect(readsBeforeRetry).toBe(1)
    expect(readOnlyAfterRemount).toBe(true)
    expect(retry).toBeTruthy()
    expect(retryUsable).toBe(true)
    expect(gets).toEqual(['gw-a', 'gw-a'])
    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_B)
    expect(editable(field(view.container, '#stdio-args-gw-a'))).toBe(true)
    expect(view.container.textContent).not.toContain('could not read the saved gateway')
    expect(puts).toHaveLength(1)
  })

  it('MCP Groups, stored then 500 on a picked-back form: read-only until the read, then the next change keeps the stored group', async () => {
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    const read = held<Response>()
    getAnswer = () => read.answer
    expect(await addGroupIfAllowed(view.container, 'github')).toBe(true)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await pickAwayAndBack(view)

    store(puts[0])
    save.release(json(500, { error: STORED_THEN_FAILED }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled(), { timeout: 2000 })
    await settle(200)
    const readOnlyWhileReading = !editable(buttonWithText(view.container, 'Add MCP Group')!)
    const noteWhileReading = view.container.textContent?.includes('Checking the saved gateway')
    read.release(json(200, { gateway: stored.get('gw-a') }))
    await settle(200)
    expect(await addGroupIfAllowed(view.container, 'slack')).toBe(true)
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })
    await settle()

    expect(groupsOf(puts[1])).toEqual(['github', 'slack'])
    expect(readOnlyWhileReading).toBe(true)
    expect(noteWhileReading).toBe(true)
    expect(toastText()).toEqual([
      `Could not confirm the MCP Groups save for "Filesystem": ${STORED_THEN_FAILED}. Batshit is reading the saved gateway.`
    ])
    expect(gets).toEqual(['gw-a'])
  })

  it('the form the user typed in: a save stored then 500 keeps the draft and says it may have been saved; the read never sends it again, and going back to the old launch is sent', async () => {
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })

    store(puts[0])
    save.release(json(500, { error: STORED_THEN_FAILED }))
    await settle()
    const draftAfterRead = argsField(view.container, 'gw-a')!.value
    const errorAfterRead = view.container.textContent?.includes(`${STORED_THEN_FAILED}. The change may have been saved.`)
    const putsAfterRead = puts.length

    // The server holds B now: going back to A is a change to send.
    await edit(argsField(view.container, 'gw-a')!, ARGS_A)
    await settle()

    expect(puts.map(argsOf)).toEqual([ARGS_B, ARGS_A])
    expect(putsAfterRead).toBe(1)
    expect(draftAfterRead).toBe(ARGS_B)
    expect(errorAfterRead).toBe(true)
    expect(gets).toEqual(['gw-a'])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('the form the user typed in: a newer draft typed while the read is on its way stays, and only it is sent', async () => {
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    const read = held<Response>()
    getAnswer = () => read.answer
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })

    store(puts[0])
    save.release(json(500, { error: STORED_THEN_FAILED }))
    await settle(200)
    await edit(argsField(view.container, 'gw-a')!, ARGS_C)
    read.release(json(200, { gateway: stored.get('gw-a') }))
    await settle(50)
    const draftAfterRead = argsField(view.container, 'gw-a')!.value
    await waitFor(() => expect(puts).toHaveLength(2), { timeout: 2000 })
    await settle()

    expect(draftAfterRead).toBe(ARGS_C)
    expect(puts.map(argsOf)).toEqual([ARGS_B, ARGS_C])
    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_C)
    expect(gets).toEqual(['gw-a'])
  })
})

describe('BL-1393: no save is sent by a fill, a landing or a settled failure', () => {
  it('a failed save is not sent again by a Refresh copy or a pick; a deliberate edit sends', async () => {
    const view = await mountPanel()
    putAnswer = (request, index) => (index === 0 ? json(409, { error: NOTHING_SAVED }) : savedAnswer(request))
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(view.container.textContent).toContain(NOTHING_SAVED), { timeout: 2000 })

    // A Refresh: its list read hands the card a new copy of the gateway.
    const refresh = Array.from(view.container.querySelectorAll('button')).find((button) =>
      /refresh/i.test(button.getAttribute('aria-label') ?? button.textContent ?? '')
    )
    await fireEvent.click(refresh!)
    await settle()
    const putsAfterRefresh = puts.length
    const draftAfterRefresh = argsField(view.container, 'gw-a')!.value
    await pickAwayAndBack(view)
    await settle()
    const putsAfterPicks = puts.length

    await edit(field(view.container, '#gateway-name-gw-a'), 'Files')
    await waitFor(() => expect(puts.length).toBeGreaterThan(putsAfterPicks), { timeout: 2000 })
    await settle()

    expect(putsAfterRefresh).toBe(1)
    expect(draftAfterRefresh).toBe(ARGS_B)
    expect(putsAfterPicks).toBe(1)
    expect(puts).toHaveLength(2)
    expect(puts[1].body.name).toBe('Files')
    expect(argsOf(puts[1])).toBe(ARGS_A)
    expect(gets).toEqual([])
  })
})

describe('BL-1410: a 500 that vouches the gateway record was saved', () => {
  // The route's text after a confirmed record write (it already ends with a period).
  const SAVED_BUT =
    'The gateway settings were saved, but Batshit could not finish updating the agent profiles or reading the gateway back.'
  const vouched = { error: SAVED_BUT, gatewaySaved: true, gatewayId: 'gw-a' }

  it('the form the user typed in: no "may have been saved" hedge and no doubled period; the read still runs and the draft stays', async () => {
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })

    store(puts[0])
    save.release(json(500, vouched))
    await settle()

    const text = view.container.textContent ?? ''
    expect(text).toContain(SAVED_BUT)
    expect(text).not.toContain(`${SAVED_BUT}.`)
    expect(text).not.toContain('may have been saved')
    expect(argsField(view.container, 'gw-a')!.value).toBe(ARGS_B)
    expect(gets).toEqual(['gw-a'])
    expect(puts).toHaveLength(1)
  })

  it.each([
    ['a string "true"', { error: SAVED_BUT, gatewaySaved: 'true', gatewayId: 'gw-a' }],
    ['another gateway id', { error: SAVED_BUT, gatewaySaved: true, gatewayId: 'gw-x' }],
    ['no id', { error: SAVED_BUT, gatewaySaved: true }],
    ['no flag', { error: SAVED_BUT }]
  ])('anything but strict proof (%s) keeps the hedge, with one period between', async (_label, body) => {
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })

    store(puts[0])
    save.release(json(500, body))
    await settle()

    expect(view.container.textContent).toContain(`${SAVED_BUT} The change may have been saved.`)
    expect(gets).toEqual(['gw-a'])
  })

  it('a picked-back form gets a notice that names the gateway, says nothing of "could not confirm", and has one period', async () => {
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await pickAwayAndBack(view)

    store(puts[0])
    save.release(json(500, vouched))
    await settle()

    expect(toastText()).toEqual([`Gateway Settings for "Filesystem": ${SAVED_BUT} Batshit is reading the saved gateway.`])
    expect(gets).toEqual(['gw-a'])
  })

  it('a picked-back form whose answer does not vouch keeps "could not confirm", with one period', async () => {
    const view = await mountPanel()
    const save = held<Response>()
    putAnswer = (request, index) => (index === 0 ? save.answer : savedAnswer(request))
    await edit(argsField(view.container, 'gw-a')!, ARGS_B)
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 2000 })
    await pickAwayAndBack(view)

    store(puts[0])
    save.release(json(500, { error: SAVED_BUT }))
    await settle()

    expect(toastText()).toEqual([
      `Could not confirm the Gateway Settings save for "Filesystem": ${SAVED_BUT} Batshit is reading the saved gateway.`
    ])
  })
})
