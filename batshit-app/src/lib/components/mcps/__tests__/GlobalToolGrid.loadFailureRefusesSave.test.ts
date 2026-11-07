import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import GlobalToolGrid from '../GlobalToolGrid.svelte'

const channel = vi.hoisted(() => ({ listener: undefined as undefined | ((event: { type: string }) => void) }))
vi.mock('$lib/services/userChannel', () => ({ onUserChannelEvent(listener: typeof channel.listener) {
  channel.listener = listener
  return () => { if (channel.listener === listener) channel.listener = undefined }
} }))

/**
 * BL-487: when `GET /api/user/settings` fails, `loadZipSettings` (GlobalToolGrid.svelte)
 * showed an error but left the grid editable on EMPTY defaults. The next toggle wrote
 * `global_zip_settings` and `global_tool_grid_settings` whole (the route replaces each block,
 * it does not merge), silently erasing every saved per-tool zip override, Smart Zip, and CLI
 * discoverability setting. Fix: a `zipSettingsLoaded` flag. Until a load succeeds, every write
 * through `saveUserToolGridDefaults` refuses with a visible error, and a Retry control reloads.
 *
 * Renders the REAL grid; `fetch` answers the grid's loads and records every save attempt.
 */

// The new MCP parent uses the existing slide primitive; finish it in jsdom.
if (typeof Element.prototype.animate !== 'function') Object.defineProperty(Element.prototype, 'animate', {
  configurable: true,
  value: () => {
    let onfinish: (() => void) | null = null
    return { cancel() {}, finish() {}, play() {}, pause() {}, get onfinish() { return onfinish }, set onfinish(handler: (() => void) | null) { onfinish = handler; setTimeout(() => handler?.(), 0) } }
  }
})
async function openMcpParent() { await fireEvent.click(await screen.findByRole('button', { name: 'Toggle MCP Tools', exact: true })) }

type Saved = { url: string; body: any }

function stubFetch(opts: {
  settingsOk: boolean
  settings?: Record<string, unknown>
  gateways?: Array<Record<string, unknown>>
  gatewayList?: () => unknown | Promise<unknown>
  gatewayAnswer?: (id: string, body: Record<string, unknown>) => Response | Promise<Response>
}) {
  const saves: Saved[] = []
  const gatewayPuts: Array<{ id: string; body: any }> = []
  let settingsOk = opts.settingsOk
  const settings = opts.settings ?? {}
  const gateways = opts.gateways ?? []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === '/api/user/settings' && method === 'GET') {
        if (!settingsOk) {
          return new Response(JSON.stringify({ error: 'Redis unavailable' }), { status: 500 })
        }
        return new Response(JSON.stringify({ settings }), { status: 200 })
      }
      if (url === '/api/user/settings' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        saves.push({ url, body })
        return new Response(JSON.stringify({ settings: { ...settings, ...body } }), { status: 200 })
      }
      if (url === '/api/mcp/gateways') return Response.json(opts.gatewayList ? await opts.gatewayList() : { gateways })
      const gatewayPutMatch = url.match(/^\/api\/mcp\/gateways\/([^/]+)$/)
      if (gatewayPutMatch && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        gatewayPuts.push({ id: gatewayPutMatch[1], body })
        if (opts.gatewayAnswer) return opts.gatewayAnswer(gatewayPutMatch[1], body)
        return new Response(JSON.stringify({ gateway: { ...body } }), { status: 200 })
      }
      if (url.endsWith('/tools')) return Response.json({ mcps: [] })
      if (url === '/api/cli-tools') return new Response(JSON.stringify({ tools: [] }), { status: 200 })
      return new Response(JSON.stringify({ error: `unrouted ${method} ${url}` }), { status: 501 })
    })
  )
  return { saves, gatewayPuts, setSettingsOk: (value: boolean) => (settingsOk = value) }
}

// SA-129 DL-06 (BL-1484): the parked Zip Control Permissions select is gone; the AI Zip Layout
// select drives the strip's save instead.
function zipLayoutTrigger(): HTMLElement {
  const label = screen.getByText('AI Zip Layout', { selector: '.batshit-settings-form-label' }).closest('label')
  const trigger = label?.querySelector('.batshit-settings-select-compact')
  if (!trigger) throw new Error('AI Zip Layout select not found')
  return trigger as HTMLElement
}

afterEach(() => {
  cleanup()
  channel.listener = undefined
  vi.unstubAllGlobals()
})

describe('Global Tool Grid: a failed settings load refuses saves (BL-487)', () => {
  it('shows a load error and Retry, and never sends a save while unloaded', async () => {
    const { saves, setSettingsOk } = stubFetch({ settingsOk: false })
    render(GlobalToolGrid, { props: { userId: 'ldf_user' } })
    await openMcpParent()

    await waitFor(() =>
      expect(
        screen.getByText(/have not finished loading|Failed to load zip defaults/i)
      ).toBeTruthy()
    )
    const retryButton = screen.getByRole('button', { name: /Retry/ })
    expect(retryButton).toBeTruthy()

    // Change the AI Zip Layout while the load is still failed.
    await fireEvent.keyDown(zipLayoutTrigger(), { key: 'ArrowDown' })
    const inlineOption = await screen.findByRole('option', { name: 'Inline', exact: true })
    await fireEvent.pointerUp(inlineOption, { pointerType: 'mouse' })

    // Give the (now-refused) debounce/save path every chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(saves).toHaveLength(0)
    expect(
      screen.getByText(/have not finished loading/i)
    ).toBeTruthy()

    // Retry with a healthy load: the next toggle now saves for real.
    setSettingsOk(true)
    await fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(screen.queryByText(/have not finished loading/i)).toBeNull())

    await fireEvent.keyDown(zipLayoutTrigger(), { key: 'ArrowDown' })
    const inlineOptionAgain = await screen.findByRole('option', { name: 'Inline', exact: true })
    await fireEvent.pointerUp(inlineOptionAgain, { pointerType: 'mouse' })

    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings.zip_ai_view_mode).toBe('inline')
  })
})

describe('Global Tool Grid: Reset to defaults refuses while unloaded (BL-487 follow-up)', () => {
  it('disables Reset to defaults, and the function itself refuses before touching any gateway', async () => {
    const { saves, gatewayPuts } = stubFetch({
      settingsOk: false,
      gateways: [{ id: 'gw1', name: 'Test Gateway', enabled: false, type: 'other' }]
    })
    render(GlobalToolGrid, { props: { userId: 'ldf_user' } })
    await openMcpParent()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Reset to defaults/ })).toBeTruthy()
    )
    const resetButton = screen.getByRole('button', { name: /Reset to defaults/ })
    // The button matches its own existing disabled-until-ready convention (it already disables
    // on !userId / loading / globalResetBusy) rather than the toggles' attempt-then-refuse one.
    expect(resetButton).toBeDisabled()

    // A disabled button never fires its click handler for a real user — but reset ALSO writes
    // to the server directly (one PUT per gateway) before the guarded settings save at the end
    // ever runs, so the function itself must refuse too, not just the button's disabled state.
    // Bypass the attribute to exercise that inner guard directly.
    resetButton.removeAttribute('disabled')
    await fireEvent.click(resetButton)

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(gatewayPuts).toHaveLength(0)
    expect(saves).toHaveLength(0)
    expect(screen.getAllByText(/Reset cannot run yet/i).length).toBeGreaterThan(0)
  })
})


describe('Global Tool Grid source original-base and reset truth', () => {
  const token = (digit: string) => `source1:${digit.repeat(64)}`
  it('keeps a refused enabled draft and only uses a fresh presented source after explicit Refresh and a new choice', async () => {
    const gateways = [{ id: 'gw-human', name: 'Human Source', enabled: false, type: 'custom', sourceRevision: token('1') }]
    let attempts = 0
    const { gatewayPuts, saves } = stubFetch({ settingsOk: true, gateways, gatewayAnswer(id) {
      attempts++
      if (attempts === 1) return new Response(JSON.stringify({ code: 'gateway_source_changed', error: 'Saved gateway source changed. Your draft is kept.' }), { status: 409 })
      return Response.json({ gateway: { ...gateways[0], enabled: true, sourceRevision: token('3') }, sourceAcknowledgement: { id, sourceRevision: token('3') } })
    } })
    render(GlobalToolGrid, { props: { userId: 'ldf_user' } })
    await openMcpParent()
    const toggle = () => screen.getByText('Human Source', { exact: true }).closest('tr')!.querySelector('[role="switch"]') as HTMLElement
    await waitFor(() => expect(toggle()).toBeTruthy())
    await fireEvent.click(toggle())
    gateways[0].sourceRevision = token('2') // actual later server source, not this queued form's base
    await waitFor(() => expect(gatewayPuts).toHaveLength(1))
    expect(gatewayPuts[0].body.expectedGatewaySource).toBe(token('1'))
    await waitFor(() => expect(screen.getAllByText(/Saved gateway source changed/).length).toBeGreaterThan(0))
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(saves).toHaveLength(0)
    // A different enabled choice and whole-grid reset BEFORE recovery may not reissue
    // this refused source or touch global user Zip.
    await fireEvent.click(toggle())
    await fireEvent.click(screen.getByRole('button', { name: /Reset to defaults/ }))
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(gatewayPuts).toHaveLength(1)
    expect(saves).toHaveLength(0)
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }))
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'))
    expect(gatewayPuts).toHaveLength(1)
    await fireEvent.click(toggle())
    await waitFor(() => expect(gatewayPuts).toHaveLength(2))
    expect(gatewayPuts[1].body.expectedGatewaySource).toBe(token('2'))
  })

  it('reports actual partial gateway reset outcomes and leaves global user Zip untouched after one refusal', async () => {
    const gateways = [
      { id: 'gw-one', name: 'One', enabled: false, type: 'custom', sourceRevision: token('1') },
      { id: 'gw-two', name: 'Two', enabled: false, type: 'custom', sourceRevision: token('2') }
    ]
    const { gatewayPuts, saves } = stubFetch({ settingsOk: true, settings: { global_zip_settings: { buffer_size: 0, custom_tool_settings: [{ tool_name: 'unrelated', auto_zip: false }] } }, gateways,
      gatewayAnswer(id) { return id === 'gw-one' ? Response.json({ gateway: { ...gateways[0], enabled: true, sourceRevision: token('3') }, sourceAcknowledgement: { id, sourceRevision: token('3') } }) :
        new Response(JSON.stringify({ code: 'gateway_source_changed', error: 'Source changed' }), { status: 409 }) }
    })
    render(GlobalToolGrid, { props: { userId: 'ldf_user' } })
    await openMcpParent()
    const reset = await screen.findByRole('button', { name: /Reset to defaults/ })
    await waitFor(() => expect(reset).not.toBeDisabled())
    await fireEvent.click(reset)
    await waitFor(() => expect(gatewayPuts).toHaveLength(2))
    expect(gatewayPuts.map(request => [request.id, request.body.expectedGatewaySource])).toEqual([['gw-one', token('1')], ['gw-two', token('2')]])
    await waitFor(() => expect(screen.getAllByText(/1 gateway resets saved; 0 follow-ups failed; 1 refused or unconfirmed/).length).toBeGreaterThan(0))
    expect(saves).toHaveLength(0)
  })
})


describe('Global source read and outcome recovery cannot adopt a new write base implicitly', () => {
  const token = (digit: string) => `source1:${digit.repeat(64)}`
  const delay = () => new Promise(resolve => setTimeout(resolve, 650))
  const row = () => screen.getByText('Retained Source', { exact: true }).closest('tr')!
  const toggle = () => row().querySelector('[role="switch"]') as HTMLElement
  const refresh = () => fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }))
  const reset = () => fireEvent.click(screen.getByRole('button', { name: /Reset to defaults/ }))

  it.each(['missing-list', 'malformed-row', 'missing-token', 'invalid-token'] as const)('keeps a dirty refused row visible on %s explicit recovery, then accepts only a valid deliberate read', async (shape) => {
    const gateways = [{ id: 'gw-retained', name: 'Retained Source', type: 'custom', enabled: false, sourceRevision: token('1') }]
    let invalid = false
    const { gatewayPuts, saves } = stubFetch({ settingsOk: true, gateways,
      gatewayList: () => {
        if (!invalid) return { gateways }
        if (shape === 'missing-list') return {}
        if (shape === 'malformed-row') return { gateways: [{ ...gateways[0], enabled: 'wrong-shape' }] }
        const { sourceRevision: _savedBase, ...withoutBase } = gateways[0]
        return { gateways: [shape === 'missing-token' ? withoutBase : { ...withoutBase, sourceRevision: 'source1:invalid' }] }
      },
      gatewayAnswer: () => Response.json({ code: 'gateway_source_changed', error: 'Source changed' }, { status: 409 }) })
    render(GlobalToolGrid, { props: { userId: 'ldf_user' } })
    await openMcpParent()
    await waitFor(() => expect(toggle()).toBeTruthy())
    await fireEvent.click(toggle())
    await waitFor(() => expect(gatewayPuts).toHaveLength(1))
    await waitFor(() => expect(screen.getAllByText(/Source changed/).length).toBeGreaterThan(0))
    invalid = true
    await refresh()
    await screen.findByText(/Saved MCP sources could not be read/)
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    await fireEvent.click(toggle())
    await reset()
    await delay()
    expect(gatewayPuts).toHaveLength(1); expect(saves).toHaveLength(0)
    invalid = false
    gateways[0].sourceRevision = token('2')
    await refresh()
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'))
    expect(gatewayPuts).toHaveLength(1)
    await fireEvent.click(toggle())
    await waitFor(() => expect(gatewayPuts).toHaveLength(2))
    expect(gatewayPuts[1].body.expectedGatewaySource).toBe(token('2'))
  })

  it('retires an unissued timer but keeps its missing dirty row unavailable on a background list read', async () => {
    const gateways = [{ id: 'gw-retained', name: 'Retained Source', type: 'custom', enabled: false, sourceRevision: token('1') }]
    const { gatewayPuts, saves } = stubFetch({ settingsOk: true, gateways })
    render(GlobalToolGrid, { props: { userId: 'ldf_user' } })
    await openMcpParent()
    await waitFor(() => expect(toggle()).toBeTruthy())
    await fireEvent.click(toggle())
    gateways.splice(0)
    channel.listener?.({ type: 'mcp_gateway_source_changed' })
    await screen.findByText('Source unavailable · draft kept')
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(toggle()).toBeDisabled()
    await delay()
    await reset()
    expect(gatewayPuts).toHaveLength(0); expect(saves).toHaveLength(0)
    // A later background reappearance does not replace this dirty source/base.
    gateways.push({ id: 'gw-retained', name: 'Retained Source', type: 'custom', enabled: false, sourceRevision: token('2') })
    channel.listener?.({ type: 'reconnected' })
    await delay()
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(toggle()).toBeDisabled()
    await refresh()
    await waitFor(() => expect(toggle()).not.toBeDisabled())
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(gatewayPuts).toHaveLength(0)
  })

  it('keeps a missing in-flight row through its controlled ACK without implicitly recreating it', async () => {
    const gateways = [{ id: 'gw-retained', name: 'Retained Source', type: 'custom', enabled: false, sourceRevision: token('1') }]
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const { gatewayPuts, saves } = stubFetch({ settingsOk: true, gateways, gatewayAnswer: async id => {
      await pending
      return Response.json({ sourceAcknowledgement: { id, sourceRevision: token('2') } })
    } })
    render(GlobalToolGrid, { props: { userId: 'ldf_user' } })
    await openMcpParent()
    await waitFor(() => expect(toggle()).toBeTruthy())
    try {
      await fireEvent.click(toggle())
      await waitFor(() => expect(gatewayPuts).toHaveLength(1))
      gateways.splice(0)
      channel.listener?.({ type: 'mcp_gateway_source_changed' })
      await screen.findByText('Source unavailable · draft kept')
      expect(toggle().getAttribute('aria-checked')).toBe('true')
      expect(toggle()).toBeDisabled()
      release()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh', exact: true })).not.toBeDisabled())
      await fireEvent.click(toggle()); await reset(); await delay()
      expect(gatewayPuts).toHaveLength(1); expect(saves).toHaveLength(0)
      expect(screen.getByText('Source unavailable · draft kept')).toBeTruthy()
      await refresh()
      await waitFor(() => expect(screen.queryByText('Retained Source', { exact: true })).toBeNull())
      expect(gatewayPuts).toHaveLength(1)
    } finally { release() }
  })

  it.each(['lost-answer', 'missing-ack', 'unreadable-answer'] as const)('holds a source after %s and refuses edits/reset until Refresh plus a new choice', async (failure) => {
    const gateways = [{ id: 'gw-retained', name: 'Retained Source', type: 'custom', enabled: false, sourceRevision: token('1') }]
    let first = true
    const { gatewayPuts, saves } = stubFetch({ settingsOk: true, gateways, gatewayAnswer(id, body) {
      Object.assign(gateways[0], { enabled: body.enabled, sourceRevision: token('2') })
      if (first) {
        first = false
        if (failure === 'lost-answer') throw new TypeError('Synthetic saved response lost')
        if (failure === 'unreadable-answer') return new Response('{broken', { status: 200 })
        return Response.json({ gateway: gateways[0] })
      }
      return Response.json({ sourceAcknowledgement: { id, sourceRevision: token('3') } })
    } })
    render(GlobalToolGrid, { props: { userId: 'ldf_user' } })
    await openMcpParent()
    await waitFor(() => expect(toggle()).toBeTruthy())
    await fireEvent.click(toggle())
    await waitFor(() => expect(gatewayPuts).toHaveLength(1))
    await waitFor(() => expect(toggle()).toBeDisabled())
    await fireEvent.click(toggle()); await reset(); await delay()
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(gatewayPuts).toHaveLength(1); expect(saves).toHaveLength(0)
    channel.listener?.({ type: 'reconnected' })
    await delay()
    expect(toggle()).toBeDisabled()
    expect(gatewayPuts).toHaveLength(1)
    await refresh()
    await waitFor(() => expect(toggle()).not.toBeDisabled())
    expect(gatewayPuts).toHaveLength(1)
    await fireEvent.click(toggle())
    await waitFor(() => expect(gatewayPuts).toHaveLength(2))
    expect(gatewayPuts[1].body.expectedGatewaySource).toBe(token('2'))
  })

  it('keeps a same-request source ACK through a later follow-up failure and permits a new choice with that exact base', async () => {
    const gateways = [{ id: 'gw-retained', name: 'Retained Source', type: 'custom', enabled: false, sourceRevision: token('1') }]
    let first = true
    const { gatewayPuts } = stubFetch({ settingsOk: true, gateways, gatewayAnswer(id, body) {
      Object.assign(gateways[0], { enabled: body.enabled, sourceRevision: token('2') })
      if (first) { first = false; return Response.json({ error: 'Known save; later profile failed', sourceAcknowledgement: { id, sourceRevision: token('2') } }, { status: 500 }) }
      return Response.json({ sourceAcknowledgement: { id, sourceRevision: token('3') } })
    } })
    render(GlobalToolGrid, { props: { userId: 'ldf_user' } })
    await openMcpParent()
    await waitFor(() => expect(toggle()).toBeTruthy())
    await fireEvent.click(toggle())
    await waitFor(() => expect(gatewayPuts).toHaveLength(1))
    await screen.findByText(/Known save; later profile failed/)
    expect(toggle()).not.toBeDisabled()
    await fireEvent.click(toggle())
    await waitFor(() => expect(gatewayPuts).toHaveLength(2))
    expect(gatewayPuts[1].body.expectedGatewaySource).toBe(token('2'))
  })
})
