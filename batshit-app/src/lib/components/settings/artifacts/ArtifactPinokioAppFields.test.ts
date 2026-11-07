import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ArtifactPinokioAppFields from './ArtifactPinokioAppFields.svelte'
import { LOCAL_PINOKIO_MACHINE } from '$lib/pinokio/machines'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'

const ID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const remote = { id: ID, label: 'Studio PC', controlHost: '192.168.1.90', controlPort: 42000, controlProtocol: 'http', revision: 2, version: 2, bindingState: 'confirmed' }
const app = { appId: 'ocr.git', title: 'OCR', state: 'online' }
const metadata = { source_type: 'gradio', runtime_manager: 'pinokio', pinokio_app_id: 'ocr.git', pinokio_machine_id: ID, pinokio_runtime: { api_name: '/predict', inputs: [] } }
function installFetch(options: { machines?: unknown[]; list?: (url: string) => Promise<Response> } = {}) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/pinokio/machines') return Response.json({ machines: options.machines ?? [LOCAL_PINOKIO_MACHINE, remote] })
    if (options.list) return options.list(url)
    return Response.json({ available: true, apps: [app], message: null, machineId: ID, machineRevision: 2 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const picker = () => screen.getByRole('button', { name: 'Pinokio app' })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ArtifactPinokioAppFields saved target selection', () => {
  it('reads remote apps without local Pinokio or a hydration write', async () => {
    const fetcher = installFetch()
    const onChange = vi.fn()
    render(ArtifactPinokioAppFields, { props: { metadata, onChange } })
    await waitFor(() => expect(picker().textContent).toContain('OCR · Studio PC'))
    expect(fetcher.mock.calls.map((call) => String(call[0]))).toContain(`/api/pinokio/apps?machineId=${ID}&revision=2`)
    expect(fetcher.mock.calls.map((call) => String(call[0]))).not.toContain('/api/pinokio/apps')
    expect(onChange).not.toHaveBeenCalled()
  })
  it('preserves omitted local metadata and shows local unavailability', async () => {
    installFetch({ list: async () => Response.json({ available: false, apps: [], message: 'Pinokio is not running on this computer.' }) })
    const onChange = vi.fn()
    render(ArtifactPinokioAppFields, { props: { metadata: { source_type: 'gradio', runtime_manager: 'pinokio', pinokio_app_id: 'ocr.git' }, onChange } })
    expect(await screen.findByText('Pinokio is not running on this computer.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pinokio computer' }).textContent?.trim()).toBe('This computer')
    expect(picker().textContent?.trim()).toBe('ocr.git')
    expect(onChange).not.toHaveBeenCalled()
  })
  it.each([
    { machines: [LOCAL_PINOKIO_MACHINE], message: /saved computer is unavailable/i },
    { machines: [LOCAL_PINOKIO_MACHINE, { ...remote, bindingState: 'needs_confirmation' }], message: /Reconnect this computer/i }
  ])('keeps an unresolved remote selection without a local fallback: %j', async ({ machines, message }) => {
    const fetcher = installFetch({ machines })
    const onChange = vi.fn()
    render(ArtifactPinokioAppFields, { props: { metadata, onChange } })
    expect(await screen.findByText(message)).toBeTruthy()
    expect(picker().textContent?.trim()).toBe('ocr.git')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })
  it('refreshes labels and current revision on a machine event without editing the Artifact draft', async () => {
    let current = remote
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/pinokio/machines'
      ? Response.json({ machines: [LOCAL_PINOKIO_MACHINE, current] })
      : Response.json({ available: true, apps: [app], machineId: ID, machineRevision: current.revision }))
    vi.stubGlobal('fetch', fetcher)
    const onChange = vi.fn()
    render(ArtifactPinokioAppFields, { props: { metadata: { ...metadata, ownDraft: 'keep this' }, onChange } })
    await waitFor(() => expect(picker().textContent).toContain('Studio PC'))
    current = { ...remote, label: 'Office PC', version: 3 }
    window.dispatchEvent(new CustomEvent(LIVE_SETTINGS_EVENTS.pinokioMachinesUpdated))
    await waitFor(() => expect(picker().textContent).toContain('Office PC'))
    current = { ...current, revision: 4, version: 4 }
    window.dispatchEvent(new CustomEvent(LIVE_SETTINGS_EVENTS.pinokioMachinesUpdated))
    await waitFor(() => expect(fetcher.mock.calls.map((call) => String(call[0]))).toContain(`/api/pinokio/apps?machineId=${ID}&revision=4`))
    expect(onChange).not.toHaveBeenCalled()
  })
  it('drops an old-target response after a selected-machine change', async () => {
    const old = deferred<Response>()
    const second = { ...remote, id: OTHER, label: 'Other PC', revision: 1, version: 1 }
    const fetcher = installFetch({ machines: [LOCAL_PINOKIO_MACHINE, remote, second], list: async (url) => url.includes(ID)
      ? old.promise : Response.json({ available: true, apps: [{ ...app, title: 'Second App' }], machineId: OTHER, machineRevision: 1 }) })
    const view = render(ArtifactPinokioAppFields, { props: { metadata, onChange: vi.fn() } })
    await waitFor(() => expect(fetcher.mock.calls.map((call) => String(call[0]))).toContain(`/api/pinokio/apps?machineId=${ID}&revision=2`))
    await view.rerender({ metadata: { ...metadata, pinokio_machine_id: OTHER }, onChange: vi.fn() })
    await waitFor(() => expect(picker().textContent).toContain('Second App'))
    old.resolve(Response.json({ available: true, apps: [{ ...app, title: 'Stale App' }], machineId: ID, machineRevision: 2 }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(picker().textContent).toContain('Second App')
  })
  it('rejects a remote response for another revision', async () => {
    installFetch({ list: async () => Response.json({ available: true, apps: [app], machineId: ID, machineRevision: 99 }) })
    render(ArtifactPinokioAppFields, { props: { metadata, onChange: vi.fn() } })
    expect(await screen.findByText(/connection changed/i)).toBeTruthy()
    expect(picker().textContent?.trim()).toBe('ocr.git')
  })
  it('changes only stable machine identity after an intentional choice', async () => {
    installFetch()
    const onChange = vi.fn()
    render(ArtifactPinokioAppFields, { props: { metadata: { ...metadata, ownDraft: 'keep' }, onChange } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pinokio computer' }).textContent?.trim()).toBe('Studio PC'))
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Pinokio computer' }), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'This computer' }), { pointerType: 'mouse' })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ownDraft: 'keep', pinokio_app_id: 'ocr.git' }))
    expect(onChange.mock.calls[0][0]).toHaveProperty('pinokio_machine_id', 'local')
    expect(onChange.mock.calls[0][0]).not.toHaveProperty('pinokio_machine_revision')
  })
  it('keeps controls disabled before detail hydration', async () => {
    installFetch()
    const onChange = vi.fn()
    render(ArtifactPinokioAppFields, { props: { metadata, onChange, disabled: true } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pinokio computer' })).toBeDisabled())
    expect(picker()).toBeDisabled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stores the chosen remote UUID without endpoint, revision or fingerprint fields', async () => {
    installFetch()
    const onChange = vi.fn()
    const { pinokio_machine_id: _old, ...local } = metadata
    render(ArtifactPinokioAppFields, { props: { metadata: local, onChange } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pinokio computer' }).textContent).toContain('This computer'))
    await fireEvent.keyDown(screen.getByRole('button', { name: 'Pinokio computer' }), { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Studio PC' }), { pointerType: 'mouse' })
    expect(onChange).toHaveBeenCalledWith({ ...local, pinokio_machine_id: ID })
  })

  it('does not read apps for malformed saved binding metadata', async () => {
    const fetcher = installFetch()
    render(ArtifactPinokioAppFields, { props: { metadata: { ...metadata, pinokio_machine_revision: 2 }, onChange: vi.fn() } })
    expect(await screen.findByText(/saved computer is unavailable/i)).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Pinokio computer' }).textContent).toContain('Unresolved saved computer')
  })

  it('keeps a failed saved-list read separate from local detection or empty-app success', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'Could not read connections.' }, { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const onChange = vi.fn()
    render(ArtifactPinokioAppFields, { props: { metadata, onChange } })
    expect(await screen.findByText('Could not read connections.')).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(picker()).toBeDisabled()
    expect(onChange).not.toHaveBeenCalled()
  })
})
