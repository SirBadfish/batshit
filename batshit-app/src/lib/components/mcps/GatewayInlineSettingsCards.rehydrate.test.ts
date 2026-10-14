import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MCPGateway } from '$lib/types/database'

import GatewayInlineSettingsCards from './GatewayInlineSettingsCards.svelte'

// BL-550: Settings > MCPs > Gateway Settings must not lose an argument the user typed when a new
// copy of the same gateway arrives (a Refresh reloads the list; a save answers). The card keeps
// its form while it differs from its baseline, while a save is queued or on its way, and against
// a copy older than the one it last took. The parent's part (passing the new copy down) is the
// `rerender` here; the routes are a small fake that records every PUT body.

const USER = 'bl550_user'
const ID = 'gw-bl550'
const ARGS_A = '-y\n@modelcontextprotocol/server-filesystem\n/tmp'
const ARGS_B = '-y\n@modelcontextprotocol/server-filesystem\n/Users/example/b'
const ARGS_C = '-y\n@modelcontextprotocol/server-filesystem\n/Users/example/c'

function copy(args: string, updatedAt: string, stdioExtra: Record<string, unknown> = {}): MCPGateway {
  return {
    id: ID,
    name: 'Filesystem',
    type: 'stdio',
    enabled: true,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: updatedAt,
    stdioConfig: {
      command: 'npx',
      args: args.split('\n'),
      cwdPolicy: 'none',
      startupTimeoutMs: 10000,
      toolCallTimeoutMs: 60000,
      lastTestStatus: 'never',
      ...stdioExtra
    }
  }
}

let putBodies: any[] = []
let answerPut: (body: any) => Promise<Response>

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  putBodies = []
  answerPut = async (body) => okJson({ gateway: { ...copy(body.stdioConfig.args.join('\n'), '2026-10-11T15:00:05.000Z') } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/settings/api-keys')) return okJson({ success: true, keys: {} })
      if (url.includes('/tools')) return okJson({ mcps: [] })
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        putBodies.push(body)
        return answerPut(body)
      }
      throw new Error(`unexpected fetch ${url}`)
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function argsField(container: HTMLElement) {
  return container.querySelector(`#stdio-args-${ID}`) as HTMLTextAreaElement
}

async function type(container: HTMLElement, value: string) {
  await fireEvent.input(argsField(container), { target: { value } })
}

describe('BL-550: a new copy of the gateway does not take back typed arguments', () => {
  it('a Refresh copy that lands while the edit waits in the debounce keeps the edit, and the save sends it', async () => {
    const view = render(GatewayInlineSettingsCards, {
      props: { gateway: copy(ARGS_A, '2026-10-11T15:00:00.000Z'), userId: USER }
    })
    await waitFor(() => expect(argsField(view.container).value).toBe(ARGS_A))

    await type(view.container, ARGS_B)
    // The Refresh answered: same launch as stored, with its result.
    await view.rerender({
      gateway: copy(ARGS_A, '2026-10-11T15:00:01.000Z', { lastTestStatus: 'passed', toolCount: 4 }),
      userId: USER
    })

    expect(argsField(view.container).value).toBe(ARGS_B)
    await waitFor(() => expect(putBodies).toHaveLength(1), { timeout: 2000 })
    expect(putBodies[0].stdioConfig.args).toEqual(ARGS_B.split('\n'))
  })

  it('a settings save sends no check result (it belongs to Refresh and Test)', async () => {
    const view = render(GatewayInlineSettingsCards, {
      props: {
        gateway: copy(ARGS_A, '2026-10-11T15:00:00.000Z', { lastTestStatus: 'failed', lastError: 'old', toolCount: 2 }),
        userId: USER
      }
    })
    await waitFor(() => expect(argsField(view.container).value).toBe(ARGS_A))

    await type(view.container, ARGS_B)

    await waitFor(() => expect(putBodies).toHaveLength(1), { timeout: 2000 })
    for (const field of ['lastTestStatus', 'lastTestAt', 'lastError', 'toolCount']) {
      expect(putBodies[0].stdioConfig).not.toHaveProperty(field)
    }
  })

  it('text typed while a save is on its way stays, and is sent next', async () => {
    let landFirstSave: () => void = () => {}
    answerPut = (body) =>
      putBodies.length === 1
        ? new Promise((resolve) => {
            landFirstSave = () => resolve(okJson({ gateway: copy(body.stdioConfig.args.join('\n'), '2026-10-11T15:00:05.000Z') }))
          })
        : Promise.resolve(okJson({ gateway: copy(body.stdioConfig.args.join('\n'), '2026-10-11T15:00:09.000Z') }))
    const onGatewayUpdated = vi.fn()
    const view = render(GatewayInlineSettingsCards, {
      props: { gateway: copy(ARGS_A, '2026-10-11T15:00:00.000Z'), userId: USER, onGatewayUpdated }
    })
    await waitFor(() => expect(argsField(view.container).value).toBe(ARGS_A))

    await type(view.container, ARGS_B)
    await waitFor(() => expect(putBodies).toHaveLength(1), { timeout: 2000 })
    await type(view.container, ARGS_C)
    // A Refresh copy lands while the first save is on its way.
    await view.rerender({
      gateway: copy(ARGS_A, '2026-10-11T15:00:01.000Z', { lastTestStatus: 'passed' }),
      userId: USER,
      onGatewayUpdated
    })
    expect(argsField(view.container).value).toBe(ARGS_C)

    landFirstSave()
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(1))
    // The parent passes the saved copy (B) down.
    await view.rerender({ gateway: onGatewayUpdated.mock.calls[0][0], userId: USER, onGatewayUpdated })

    expect(argsField(view.container).value).toBe(ARGS_C)
    await waitFor(() => expect(putBodies).toHaveLength(2), { timeout: 2000 })
    expect(putBodies[1].stdioConfig.args).toEqual(ARGS_C.split('\n'))
  })

  it('a copy older than the saved one does not replace the form; a newer one does', async () => {
    const onGatewayUpdated = vi.fn()
    const view = render(GatewayInlineSettingsCards, {
      props: { gateway: copy(ARGS_A, '2026-10-11T15:00:00.000Z'), userId: USER, onGatewayUpdated }
    })
    await waitFor(() => expect(argsField(view.container).value).toBe(ARGS_A))

    await type(view.container, ARGS_B)
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(1), { timeout: 2000 })
    await view.rerender({ gateway: onGatewayUpdated.mock.calls[0][0], userId: USER, onGatewayUpdated })
    expect(argsField(view.container).value).toBe(ARGS_B)

    // A list read that started before the save landed answers late with the old launch.
    await view.rerender({ gateway: copy(ARGS_A, '2026-10-11T15:00:02.000Z'), userId: USER, onGatewayUpdated })
    expect(argsField(view.container).value).toBe(ARGS_B)

    // Another window saved later: the form is at rest, so it shows that.
    await view.rerender({ gateway: copy(ARGS_C, '2026-10-11T15:00:30.000Z'), userId: USER, onGatewayUpdated })
    expect(argsField(view.container).value).toBe(ARGS_C)
    expect(putBodies).toHaveLength(1)
  })

  it('picking another gateway and back while a save is on its way never sends the old launch again', async () => {
    let landSave: () => void = () => {}
    answerPut = (body) =>
      new Promise((resolve) => {
        landSave = () => resolve(okJson({ gateway: copy(body.stdioConfig.args.join('\n'), '2026-10-11T15:00:05.000Z') }))
      })
    const onGatewayUpdated = vi.fn()
    const view = render(GatewayInlineSettingsCards, {
      props: { gateway: copy(ARGS_A, '2026-10-11T15:00:00.000Z'), userId: USER, onGatewayUpdated }
    })
    await waitFor(() => expect(argsField(view.container).value).toBe(ARGS_A))

    await type(view.container, ARGS_B)
    await waitFor(() => expect(putBodies).toHaveLength(1), { timeout: 2000 })
    // Another gateway, then this one again: the parent still holds the copy from before the save.
    const other = { ...copy(ARGS_C, '2026-10-11T14:00:00.000Z'), id: 'gw-other', name: 'Other' }
    await view.rerender({ gateway: other, userId: USER, onGatewayUpdated })
    await view.rerender({ gateway: copy(ARGS_A, '2026-10-11T15:00:00.000Z'), userId: USER, onGatewayUpdated })
    expect(argsField(view.container).value).toBe(ARGS_A)

    landSave()
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(1))
    // The parent passes the saved copy (B) down; the form is at rest, so it shows it.
    await view.rerender({ gateway: onGatewayUpdated.mock.calls[0][0], userId: USER, onGatewayUpdated })
    expect(argsField(view.container).value).toBe(ARGS_B)

    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(putBodies).toHaveLength(1)
  })

  it('a copy with no updated_at does not replace a form that took a stamped copy', async () => {
    const onGatewayUpdated = vi.fn()
    const unstamped = copy(ARGS_A, '2026-10-11T15:00:00.000Z')
    delete unstamped.updated_at
    const view = render(GatewayInlineSettingsCards, {
      props: { gateway: unstamped, userId: USER, onGatewayUpdated }
    })
    await waitFor(() => expect(argsField(view.container).value).toBe(ARGS_A))

    await type(view.container, ARGS_B)
    await waitFor(() => expect(onGatewayUpdated).toHaveBeenCalledTimes(1), { timeout: 2000 })
    await view.rerender({ gateway: onGatewayUpdated.mock.calls[0][0], userId: USER, onGatewayUpdated })
    expect(argsField(view.container).value).toBe(ARGS_B)

    // A list read from before the save (the record had never been stamped then) answers late.
    await view.rerender({ gateway: { ...unstamped }, userId: USER, onGatewayUpdated })
    expect(argsField(view.container).value).toBe(ARGS_B)
  })
})
