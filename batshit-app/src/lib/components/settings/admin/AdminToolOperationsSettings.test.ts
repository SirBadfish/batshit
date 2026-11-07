import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('$app/env', () => ({ browser: true }))
import AdminToolOperationsSettings from './AdminToolOperationsSettings.svelte'
import { refreshToolOperationsSource, resetToolOperationsSource } from '$lib/stores/toolOperationalSettings.svelte'
import { resolveToolOperationalSettings } from '$lib/utils/toolOperationalSettings'
const token = (v: string) => `sha256:${v.repeat(64)}`
const envelope = (v: string, timeoutMs = 17001, host = true) => ({ toolOperations: { revision: token(v), values: { ...resolveToolOperationalSettings(null), agentBrowser: { ...resolveToolOperationalSettings(null).agentBrowser, timeoutMs } }, ...(host ? { host: { containerized: false } } : {}) } })
const response = (v: string, timeoutMs = 17001) => Response.json(envelope(v, timeoutMs))
const props = { userId: 'owner', providerAvailability: { exa: false, perplexity: false }, loadingProviders: false, providerError: null }
let posts: any[], read: () => Response | Promise<Response>, save: (body: any) => Response | Promise<Response>
function stubs() {
  if (!Element.prototype.animate) Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: () => ({ cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null }) })
  if (!globalThis.ResizeObserver) vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
}
beforeEach(() => {
  stubs(); resetToolOperationsSource(); posts = []; read = () => response('a'); save = () => response('b', 18001)
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); posts.push(body); return save(body) }
    return read()
  }))
})
afterEach(() => { cleanup(); resetToolOperationsSource(); vi.unstubAllGlobals() })
async function open() { render(AdminToolOperationsSettings, props); return await screen.findByLabelText('Agent Browser Timeout (ms)') }
describe('Admin global tool original-base editing', () => {
  it('loads saved facts without hydration saves, then saves one finite choice with its original base', async () => {
    const field = await open()
    expect(field).toHaveValue(17001); expect(posts).toEqual([])
    await fireEvent.input(field, { target: { value: '18001' } })
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ expectedToolOperations: token('a'), tool_operations_patch: { agentBrowser: { timeoutMs: 18001 } } })
    await waitFor(() => expect(screen.queryByText('Saving global tool options...')).toBeNull())
    expect(field).not.toBeDisabled(); expect(field).toHaveValue(18001)
  })
  it('keeps sequential typing editable and coalesces complete fields under the same original base', async () => {
    const timeout = await open(), session = screen.getByLabelText('Default Session Name (Optional)')
    for (const value of ['s', 'sa', 'saved session']) {
      await fireEvent.input(session, { target: { value } })
      expect(session).not.toBeDisabled()
    }
    await fireEvent.input(timeout, { target: { value: '18001' } })
    save = () => Response.json({ toolOperations: { ...envelope('b', 18001).toolOperations, values: { ...envelope('b', 18001).toolOperations.values, agentBrowser: { ...envelope('b', 18001).toolOperations.values.agentBrowser, session: 'saved session' } } } })
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ expectedToolOperations: token('a'), tool_operations_patch: { agentBrowser: { session: 'saved session', timeoutMs: 18001 } } })
    await waitFor(() => expect(session).not.toBeDisabled())
    expect(session).toHaveValue('saved session')
  })
  it('adopts a clean external saved update without writing', async () => {
    const field = await open(); read = () => response('c', 22001)
    await refreshToolOperationsSource(); await waitFor(() => expect(field).toHaveValue(22001))
    expect(posts).toEqual([])
  })
  it('keeps a queued dirty choice and cancels it when another window changes the base', async () => {
    const field = await open(); await fireEvent.input(field, { target: { value: '18001' } })
    read = () => response('c', 22001); await refreshToolOperationsSource()
    await screen.findByText(/Your choices were kept/)
    expect(field).toHaveValue(18001); expect(field).toBeDisabled()
    await new Promise(done => setTimeout(done, 600)); expect(posts).toEqual([])
    await fireEvent.click(screen.getByRole('button', { name: 'Read saved global tool options' }))
    await waitFor(() => expect(field).toHaveValue(22001)); expect(field).not.toBeDisabled()
  })
  it('holds a lost save outcome without automatic retry, then explicitly reads actual saved values', async () => {
    const field = await open(); save = () => Response.json({ error: 'lost' }, { status: 503 })
    await fireEvent.input(field, { target: { value: '18001' } })
    await screen.findByText(/save outcome is unconfirmed/)
    expect(posts).toHaveLength(1); expect(field).toHaveValue(18001); expect(field).toBeDisabled()
    read = () => response('b', 18001)
    await fireEvent.click(screen.getByRole('button', { name: 'Read saved global tool options' }))
    await waitFor(() => expect(field).not.toBeDisabled()); expect(posts).toHaveLength(1)
  })
  it('does not expose editable defaults on read failure or missing runtime fact', async () => {
    read = () => new Response('', { status: 503 }); render(AdminToolOperationsSettings, props)
    await screen.findByRole('button', { name: 'Read saved global tool options' })
    expect(screen.queryByLabelText('Agent Browser Timeout (ms)')).toBeNull(); expect(posts).toEqual([])
    read = () => Response.json(envelope('a', 17001, false))
    await fireEvent.click(screen.getByRole('button', { name: 'Read saved global tool options' }))
    expect(await screen.findByLabelText('Agent Browser Timeout (ms)')).toBeDisabled(); expect(posts).toEqual([])
  })
})
