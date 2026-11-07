import { fireEvent, render, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PinokioStartBridge from './PinokioStartBridge.svelte'

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('$lib/stores/confirmDialog', () => ({ confirmDialog: confirm }))
const ID = 'artifact_pinokio_bridge'
const MACHINE = '11111111-1111-4111-8111-111111111111'
const LAUNCH = 'a'.repeat(64)
const BINDING = 'b'.repeat(64)
const preview = {
  success: true, artifactName: 'Image', appId: 'comfy.git', title: 'ComfyUI', state: 'offline', ready: false,
  machineId: MACHINE, machineRevision: 3, machineLabel: 'Studio PC', alsoStarts: ['helper.git'],
  launchFingerprint: LAUNCH, bindingFingerprint: BINDING, dependencyRead: 'native'
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function setup() {
  const view = render(PinokioStartBridge)
  const frame = document.createElement('iframe')
  frame.src = `/artifact/${ID}?session=one`
  document.body.append(frame)
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  function request(data: Record<string, unknown> = {}, origin = 'null') {
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, origin,
      data: { type: 'batshit:pinokio:start-request', artifactId: ID, requestId: 'one', ...data }
    }))
  }
  return { ...view, frame, post, request }
}
function fetchAnswers(start: Record<string, unknown> = { success: true, ready: true, endpointReady: true }) {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(preview)).mockResolvedValueOnce(Response.json({ machineId: MACHINE, machineRevision: 3, ...start }))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
beforeEach(() => { confirm.mockReset(); confirm.mockResolvedValue(true) })
afterEach(() => { document.querySelectorAll('iframe').forEach((frame) => frame.remove()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('PinokioStartBridge saved-frame start authority', () => {
  it('names the saved machine and exact app set and echoes only the frozen remote preview', async () => {
    const fetcher = fetchAnswers()
    const { request, post } = setup()
    request({ machineId: 'body-cannot-retarget', appId: 'other.git', approved: true })
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Start ComfyUI on Studio PC with Pinokio?',
      description: expect.arrayContaining(['Starting it also starts helper.git.'])
    }))
    expect(fetcher.mock.calls[0][0]).toBe(`/api/pinokio/apps/start?artifactId=${ID}`)
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      artifactId: ID, alsoStarts: ['helper.git'], machineId: MACHINE, revision: 3,
      launchFingerprint: LAUNCH, bindingFingerprint: BINDING
    })
    expect(post.mock.calls[0][0]).toMatchObject({ ok: true, endpointReady: true, machineId: MACHINE })
  })
  it('does not post after the same iframe window navigates while confirmation is pending', async () => {
    const answer = deferred<boolean>()
    confirm.mockReturnValue(answer.promise)
    const fetcher = fetchAnswers()
    const { request, frame, post } = setup()
    request()
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    frame.setAttribute('src', `/artifact/${ID}?session=two`)
    answer.resolve(true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(post).not.toHaveBeenCalled()
  })
  it('aborts the owned preview when its rendered iframe is removed', async () => {
    const gate = deferred<Response>()
    const fetcher = vi.fn().mockReturnValue(gate.promise)
    vi.stubGlobal('fetch', fetcher)
    const { request, frame } = setup()
    request()
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal
    frame.remove()
    await waitFor(() => expect(signal.aborted).toBe(true))
    gate.resolve(Response.json(preview))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(confirm).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('aborts observation on bridge disposal after a start was issued', async () => {
    const gate = deferred<Response>()
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(preview)).mockReturnValueOnce(gate.promise)
    vi.stubGlobal('fetch', fetcher)
    const { request, unmount, post } = setup()
    request()
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    const signal = fetcher.mock.calls[1][1].signal as AbortSignal
    unmount()
    expect(signal.aborted).toBe(true)
    gate.resolve(Response.json({ success: true, endpointReady: true }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(post).not.toHaveBeenCalled()
  })
  it.each([
    { success: true, ready: true, alreadyRunning: true },
    { success: true, ready: true, endpointReady: true, nativeControlOutcome: 'blocked' },
    { success: true, endpointReady: true, nativeControlOutcome: 'cancelled' },
    { success: true, endpointReady: true, observationEnded: 'cancelled' },
    { success: true, endpointReady: true, observationEnded: 'timeout' },
    { success: true, endpointReady: true, launchState: 'pending' },
    { success: true, endpointReady: true, launchState: 'unknown' }
  ])('does not report remote replay readiness from %j', async (outcome) => {
    fetchAnswers(outcome)
    const { request, post } = setup()
    request()
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][0]).toMatchObject({ ok: false, machineId: MACHINE })
    expect(post.mock.calls[0][0].message).toBeTruthy()
    for (const key of ['nativeControlOutcome', 'observationEnded', 'launchState']) {
      if (key in outcome) expect(post.mock.calls[0][0][key]).toBe(outcome[key as keyof typeof outcome])
    }
  })
  it('reports an uncertain issued start without sending again', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(preview)).mockRejectedValueOnce(new Error('lost answer'))
    vi.stubGlobal('fetch', fetcher)
    const { request, post } = setup()
    request()
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][0]).toMatchObject({ ok: false, launchState: 'unknown' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('preserves only the server-proven no-send marker on a refused POST', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(preview)).mockResolvedValueOnce(Response.json({
      success: false, code: 'pinokio_preview_changed', error: 'The saved binding changed. Confirm its new preview.', startEffect: 'not_sent'
    }, { status: 409 }))
    vi.stubGlobal('fetch', fetcher)
    const { request, post } = setup()
    request()
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][0]).toMatchObject({ ok: false, machineId: MACHINE, startEffect: 'not_sent' })
    expect(post.mock.calls[0][0].launchState).not.toBe('unknown')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([400, 409])('does not infer no-send from HTTP %s without the exact server marker', async (status) => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(preview)).mockResolvedValueOnce(Response.json({
      success: false, code: 'pinokio_preview_changed', error: 'The request failed.'
    }, { status }))
    vi.stubGlobal('fetch', fetcher)
    const { request, post } = setup()
    request()
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][0]).toMatchObject({ ok: false, startEffect: 'unknown', launchState: 'unknown' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('does not accept endpoint readiness from a different successful response target', async () => {
    fetchAnswers({ success: true, endpointReady: true, machineRevision: 4 })
    const { request, post } = setup()
    request()
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][0]).toMatchObject({ ok: false, launchState: 'unknown', machineId: MACHINE })
  })
  it('refuses a stale local preview missing custody before confirmation or POST', async () => {
    const { launchFingerprint: _launch, bindingFingerprint: _binding, ...stalePreview } = preview
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ...stalePreview, machineId: 'local', machineRevision: 0 }))
    vi.stubGlobal('fetch', fetcher)
    const { request, post } = setup()
    request()
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(confirm).not.toHaveBeenCalled()
    expect(post.mock.calls[0][0]).toMatchObject({ ok: false, startEffect: 'not_sent' })
    expect(post.mock.calls[0][0].message).toContain('Refresh the artifact')
  })
  it('echoes a modern local preview binding so confirmation cannot start a rebound app', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ...preview, machineId: 'local', machineRevision: 0 }))
      .mockResolvedValueOnce(Response.json({ success: true, ready: true }))
    vi.stubGlobal('fetch', fetcher)
    const { request, post } = setup()
    request()
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ artifactId: ID, alsoStarts: ['helper.git'],
      machineId: 'local', revision: 0, launchFingerprint: LAUNCH, bindingFingerprint: BINDING })
    expect(post.mock.calls[0][0].ok).toBe(true)
  })
  it('refuses malformed dependency previews before confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...preview, alsoStarts: ['ok.git', 42] })))
    const { request, post } = setup()
    request()
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(confirm).not.toHaveBeenCalled()
    expect(post.mock.calls[0][0].ok).toBe(false)
  })
  it('ignores an unrendered artifact or a non-opaque sender', async () => {
    const fetcher = fetchAnswers()
    const { request } = setup()
    request({ artifactId: 'another' })
    request({}, window.location.origin)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
