import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PinokioConnectionsSettings from './PinokioConnectionsSettings.svelte'
import { LOCAL_PINOKIO_MACHINE, type PinokioRemoteMachine } from '$lib/pinokio/machines'
import { dispatchPinokioMachinesUpdated } from '$lib/utils/liveSettingsEvents'

const PC: PinokioRemoteMachine = {
  id: '532fd91b-cd78-40da-a12c-9dc32a4b9073', label: 'Gaming PC',
  controlHost: '192.168.1.20', controlPort: 42000, controlProtocol: 'http',
  version: 1, revision: 1, bindingState: 'confirmed'
}
function reply(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}
function install(initial: PinokioRemoteMachine[] = []) {
  const state = { machines: initial, readFailure: false, malformed: false }
  const writes: Array<{ url: string; method: string; body: Record<string, any> }> = []
  const onWrite = vi.fn(async (_method: string, _body: Record<string, any>) => reply({ machine: PC }))
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!init?.method || init.method === 'GET') {
      if (state.readFailure) return reply({ error: 'Saved connections are unavailable.' }, 500)
      return reply({ machines: state.malformed ? [] : [LOCAL_PINOKIO_MACHINE, ...state.machines] })
    }
    const body = JSON.parse(String(init.body))
    writes.push({ url, method: init.method, body })
    return onWrite(init.method, body)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { state, writes, onWrite, fetchMock }
}
async function ready() {
  render(PinokioConnectionsSettings)
  await waitFor(() => expect((screen.getByLabelText('Pinokio Address') as HTMLInputElement).disabled).toBe(false))
}
async function enter(address: string, label = '') {
  await fireEvent.input(screen.getByLabelText('Pinokio Address'), { target: { value: address } })
  if (label) await fireEvent.input(screen.getByLabelText('Label (Optional)'), { target: { value: label } })
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Pinokio saved connections', () => {
  it.each([
    ['192.168.1.20', 'http', 42000],
    ['192.168.1.20:43000', 'http', 43000],
    ['http://192.168.1.20', 'http', 80],
    ['https://192.168.1.20', 'https', 443],
    ['https://192.168.1.20:8443/', 'https', 8443]
  ])('saves %s explicitly without local detection or a transport downgrade', async (address, protocol, port) => {
    const { writes, onWrite, state, fetchMock } = install()
    onWrite.mockImplementation(async () => {
      const saved = { ...PC, controlProtocol: protocol as 'http' | 'https', controlPort: port as number }
      state.machines = [saved]
      return reply({ machine: saved })
    })
    await ready()
    expect(writes).toHaveLength(0)
    await enter(address as string)
    await fireEvent.click(screen.getByRole('button', { name: 'Save Connection' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ method: 'POST', url: '/api/pinokio/machines', body: {
      label: '192.168.1.20', controlHost: '192.168.1.20', controlProtocol: protocol, controlPort: port
    } })
    expect(await screen.findByText('Connection saved. Availability is checked when you use it.')).toBeTruthy()
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('/api/pinokio/machines'))).toBe(true)
  })

  it.each(['https://192.168.1.20/apps', 'http://user:pass@192.168.1.20', 'http://192.168.1.20?q=x', 'http://192.168.1.20#x', 'ftp://192.168.1.20', '8.8.8.8', '127.0.0.1', 'host.local:42000'])('refuses invalid address %s before a write', async (address) => {
    const { writes } = install()
    await ready(); await enter(address)
    await fireEvent.click(screen.getByRole('button', { name: 'Save Connection' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(writes).toHaveLength(0)
  })

  it.each([false, true])('disables writes after a failed or malformed load, with explicit Retry (%s)', async (malformed) => {
    const { state, writes } = install()
    state.readFailure = !malformed; state.malformed = malformed
    render(PinokioConnectionsSettings)
    expect(await screen.findByRole('button', { name: 'Retry Connections' })).toBeTruthy()
    expect((screen.getByLabelText('Pinokio Address') as HTMLInputElement).disabled).toBe(true)
    expect(writes).toHaveLength(0)
    state.readFailure = false; state.malformed = false
    await fireEvent.click(screen.getByRole('button', { name: 'Retry Connections' }))
    await waitFor(() => expect((screen.getByLabelText('Pinokio Address') as HTMLInputElement).disabled).toBe(false))
  })

  it('sends a label-only sparse update with the captured edit version', async () => {
    const { writes, state, onWrite } = install([PC])
    onWrite.mockImplementation(async () => {
      const saved = { ...PC, label: 'PC Upstairs', version: 2 }
      state.machines = [saved]; return reply({ machine: saved })
    })
    await ready()
    await fireEvent.click(screen.getByRole('button', { name: 'Edit Gaming PC' }))
    await fireEvent.input(screen.getByLabelText('Label (Optional)'), { target: { value: 'PC Upstairs' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ method: 'PUT', body: { expectedVersion: 1, label: 'PC Upstairs' } })
    expect(Object.keys(writes[0].body)).toEqual(['expectedVersion', 'label'])
  })

  it('keeps a stale draft and refreshes without automatically retrying its mutation', async () => {
    const { writes, state, onWrite } = install([PC])
    onWrite.mockImplementation(async () => {
      state.machines = [{ ...PC, label: 'Changed elsewhere', version: 2 }]
      return reply({ error: 'Connection changed.', code: 'conflict' }, 409)
    })
    await ready()
    await fireEvent.click(screen.getByRole('button', { name: 'Edit Gaming PC' }))
    await enter('192.168.1.99:42000')
    await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(await screen.findByText('Changed elsewhere')).toBeTruthy()
    expect((screen.getByLabelText('Pinokio Address') as HTMLInputElement).value).toBe('192.168.1.99:42000')
    expect((screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled).toBe(true)
    expect(writes).toHaveLength(1)
  })

  it('treats a lost save answer as unknown until explicit read and review, without retry', async () => {
    const { writes, onWrite } = install()
    onWrite.mockRejectedValue(new Error('Lost reply'))
    await ready(); await enter('192.168.1.20:42000')
    await fireEvent.click(screen.getByRole('button', { name: 'Save Connection' }))
    expect(await screen.findByText(/could not confirm whether the connection changed/)).toBeTruthy()
    expect((screen.getByLabelText('Pinokio Address') as HTMLInputElement).value).toBe('192.168.1.20:42000')
    expect((screen.getByRole('button', { name: 'Save Connection' }) as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh Connections' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Review Complete, Reset Form' }) as HTMLButtonElement).disabled).toBe(false))
    expect(writes).toHaveLength(1)
    expect((screen.getByRole('button', { name: 'Save Connection' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps restored records inactive until explicit reconnect, with their version', async () => {
    const { writes } = install([{ ...PC, bindingState: 'needs_confirmation' }])
    await ready()
    expect(await screen.findByText(/Reconnect needed/)).toBeTruthy()
    expect(writes).toHaveLength(0)
    await fireEvent.click(screen.getByRole('button', { name: 'Reconnect Gaming PC' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ method: 'PUT', body: { expectedVersion: 1, reconnect: true } })
  })

  it('deletes only the connection after an explicit inline confirmation', async () => {
    const { writes, state, onWrite } = install([PC])
    onWrite.mockImplementation(async () => { state.machines = []; return reply({ success: true }) })
    await ready()
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Gaming PC' }))
    expect(writes).toHaveLength(0)
    expect((screen.getByLabelText('Pinokio Address') as HTMLInputElement).disabled).toBe(true)
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Connection' }))
    expect(await screen.findByText('Connection removed. Apps and Artifacts were kept.')).toBeTruthy()
    expect(writes[0]).toMatchObject({ method: 'DELETE', url: `/api/pinokio/machines/${PC.id}`, body: { expectedVersion: 1 } })
  })

  it('refreshes a mounted list on another editor event while preserving a stale draft', async () => {
    const { writes, state } = install([PC])
    await ready()
    await fireEvent.click(screen.getByRole('button', { name: 'Edit Gaming PC' }))
    await enter('192.168.1.99:42000')
    state.machines = [{ ...PC, label: 'New saved label', version: 2 }]
    dispatchPinokioMachinesUpdated({ machineId: PC.id, revision: 1 })
    expect(await screen.findByText('New saved label')).toBeTruthy()
    expect((screen.getByLabelText('Pinokio Address') as HTMLInputElement).value).toBe('192.168.1.99:42000')
    expect((screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled).toBe(true)
    expect(writes).toHaveLength(0)
  })
})
