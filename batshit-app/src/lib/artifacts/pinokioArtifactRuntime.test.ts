import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateArtifactApiScript } from './generateArtifactApi'

/**
 * SA-072 P2 (DL-10): inside the artifact, an offline Pinokio app becomes "Start with Pinokio":
 * the note asks Batshit's page to start the app (the iframe cannot), then repeats the run.
 * jsdom has no parent frame, so `window.parent` is the window itself and the test plays the page.
 */

const ARTIFACT_ID = 'artifact_pinokio_test'

function installArtifactApi() {
  const wrapper = document.createElement('div')
  wrapper.innerHTML = generateArtifactApiScript({
    artifactId: ARTIFACT_ID,
    artifactName: 'Pinokio Test',
    runtimeToken: `art_rt_${'a'.repeat(64)}`
  })
  const script = wrapper.querySelector('script')
  if (!script?.textContent) throw new Error('Artifact API script was not generated')
  new Function(script.textContent)()
  return (window as unknown as { batshit: any }).batshit
}

function ndjson(events: Array<Record<string, unknown>>) {
  return new Response(events.map((event) => JSON.stringify(event)).join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' }
  })
}

const OFFLINE = [
  { type: 'start', metadata: { transport: 'pinokio-app' } },
  {
    type: 'error',
    error: 'Comfyui is not running in Pinokio. Start it with fabric:sys.pinokio.run …',
    metadata: { code: 'app_offline', appId: 'comfy.git', title: 'Comfyui', state: 'offline' }
  }
]
const DONE = [
  { type: 'start', metadata: { transport: 'pinokio-app' } },
  { type: 'chunk', content: 'Generated 1 image' },
  { type: 'file', base64: 'data:image/png;base64,AAAA', mediaType: 'image/png', index: 0 },
  { type: 'end', content: 'Generated 1 image', metadata: { transport: 'pinokio-app' } }
]

const pageListeners: Array<(event: MessageEvent) => void> = []
function addPageListener(listener: (event: MessageEvent) => void) {
  pageListeners.push(listener)
  window.addEventListener('message', listener)
}

/** Plays Batshit's page: answers each start request the artifact posts. */
function answerStartRequests(answer: Record<string, unknown>) {
  const requests: any[] = []
  addPageListener((event) => {
    if (event.data?.type !== 'batshit:pinokio:start-request') return
    requests.push(event.data)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { type: 'batshit:pinokio:start-result', artifactId: ARTIFACT_ID, requestId: event.data.requestId, ...answer }
      })
    )
  })
  return requests
}

async function waitFor(check: () => unknown) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition never met')
}

describe('Start with Pinokio inside the artifact', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = '<main id="app"></main>'
    delete (window as unknown as { batshit?: unknown }).batshit
  })

  afterEach(() => {
    for (const listener of pageListeners.splice(0)) window.removeEventListener('message', listener)
    vi.unstubAllGlobals()
  })

  it('offers the start instead of an error, and repeats the run once the app answers', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ndjson(OFFLINE)).mockResolvedValueOnce(ndjson(DONE))
    vi.stubGlobal('fetch', fetchMock)
    const batshit = installArtifactApi()
    const requests = answerStartRequests({ ok: true, ready: true })
    const onError = vi.fn()

    const run = batshit.complete('Run', { context: { prompt: 'a bat' }, onError })
    await waitFor(() => document.querySelector('[data-batshit-pinokio="start"]'))
    expect(document.querySelector('.batshit-pinokio-offline')?.textContent).toContain('Comfyui is not running in Pinokio.')
    ;(document.querySelector('[data-batshit-pinokio="start"]') as HTMLButtonElement).click()

    const result = await run
    expect(requests).toEqual([expect.objectContaining({ artifactId: ARTIFACT_ID })])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ context: { prompt: 'a bat' } })
    expect(result.text).toBe('Generated 1 image')
    expect(result.files).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
    expect(document.querySelector('.batshit-pinokio-offline')).toBeNull()
  })

  it('hands the original error to the artifact when the user says Not now', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ndjson(OFFLINE))
    vi.stubGlobal('fetch', fetchMock)
    const batshit = installArtifactApi()
    const onError = vi.fn()
    const run = batshit.complete('Run', { onError })
    await waitFor(() => document.querySelector('[data-batshit-pinokio="dismiss"]'))
    ;(document.querySelector('[data-batshit-pinokio="dismiss"]') as HTMLButtonElement).click()
    await run
    expect(onError).toHaveBeenCalledWith(OFFLINE[1].error, expect.objectContaining({ type: 'error' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shows the page\'s answer when the start fails, and leaves the run waiting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ndjson(OFFLINE)))
    const batshit = installArtifactApi()
    answerStartRequests({ ok: false, message: 'Comfyui was not started.' })
    void batshit.complete('Run', {})
    await waitFor(() => document.querySelector('[data-batshit-pinokio="start"]'))
    ;(document.querySelector('[data-batshit-pinokio="start"]') as HTMLButtonElement).click()
    await waitFor(() => document.querySelector('.batshit-pinokio-offline')?.textContent?.includes('was not started'))
    expect((document.querySelector('[data-batshit-pinokio="start"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('leaves every other error to the artifact', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(ndjson([{ type: 'start' }, { type: 'error', error: 'model missing', metadata: {} }]))
    )
    const batshit = installArtifactApi()
    const onError = vi.fn()
    await batshit.complete('Run', { onError })
    expect(onError).toHaveBeenCalledWith('model missing', expect.anything())
    expect(document.querySelector('.batshit-pinokio-offline')).toBeNull()
  })

  it('ignores a start answer that did not come from the page', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ndjson(OFFLINE))
    vi.stubGlobal('fetch', fetchMock)
    const batshit = installArtifactApi()
    addPageListener((event) => {
      if (event.data?.type !== 'batshit:pinokio:start-request') return
      // A message from anything but the parent page must not resolve the start.
      window.dispatchEvent(
        new MessageEvent('message', {
          source: null,
          data: { type: 'batshit:pinokio:start-result', artifactId: ARTIFACT_ID, requestId: event.data.requestId, ok: true }
        })
      )
    })
    const run = batshit.complete('Run', {})
    await waitFor(() => document.querySelector('[data-batshit-pinokio="start"]'))
    ;(document.querySelector('[data-batshit-pinokio="start"]') as HTMLButtonElement).click()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(document.querySelector('.batshit-pinokio-offline')?.textContent).toContain('Confirm the start in Batshit')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    void run
  })

  it('offers the start for proxy calls too', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: 'app_offline', app: { id: 'comfy.git', title: 'Comfyui', state: 'offline' } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ system: {} }))
    vi.stubGlobal('fetch', fetchMock)
    const batshit = installArtifactApi()
    answerStartRequests({ ok: true })
    const pending = batshit.pinokio.fetch('system_stats')
    await waitFor(() => document.querySelector('[data-batshit-pinokio="start"]'))
    ;(document.querySelector('[data-batshit-pinokio="start"]') as HTMLButtonElement).click()
    const response = await pending
    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/artifacts/pinokio/system_stats', '/api/artifacts/pinokio/system_stats'])
  })
})
