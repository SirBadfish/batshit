import { beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '../redis'

/**
 * SA-072 P2: `/api/artifacts/complete` hands a `brain_type: "pinokio_app"` artifact to the Pinokio
 * app runner BEFORE any model resolution (it has no model), passes the panel's `context` and an
 * agent's `fields` as the values, and turns a runner failure into an `error` event whose
 * `metadata.code` the Builder Kit reads (`app_offline` → "Start with Pinokio").
 */

const runnerMocks = vi.hoisted(() => ({ run: vi.fn() }))

vi.mock('$lib/server/services/pinokioAppRunner', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/services/pinokioAppRunner')>(
    '$lib/server/services/pinokioAppRunner'
  )
  return { ...actual, runPinokioAppArtifact: (...args: any[]) => runnerMocks.run(...args) }
})

const METADATA = {
  source_type: 'comfyui',
  runtime_manager: 'pinokio',
  pinokio_app_id: 'comfy.git',
  fabric_fields: [{ fabricId: 'prompt', type: 'textarea', label: 'Prompt' }],
  pinokio_runtime: {
    workflow: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } },
    inputs: { prompt: { node: '6', input: 'text' } }
  }
}

async function seed(overrides: Record<string, unknown> = {}) {
  await redis.json.set('artifact:art_pk', '$', {
    id: 'art_pk',
    user_id: 'user_1',
    name: 'Flux via Pinokio',
    content: '<html></html>',
    mode: 'published',
    brain_type: 'pinokio_app',
    ai_enabled: true,
    metadata: METADATA,
    ...overrides
  } as any)
}

function event(body: Record<string, unknown>, signal?: AbortSignal, headers?: HeadersInit) {
  return {
    request: new Request('http://localhost/api/artifacts/complete', { method: 'POST', body: JSON.stringify(body), signal, headers }),
    locals: { user: { id: 'user_1' } },
    fetch: vi.fn()
  } as any
}

async function readEvents(response: Response): Promise<Array<Record<string, any>>> {
  const text = await response.text()
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

describe('POST /api/artifacts/complete for a Pinokio app artifact', () => {
  beforeEach(async () => {
    runnerMocks.run.mockReset()
    await redis.del('ratelimit:artifact:user_1:art_pk')
    await seed()
  })

  it('refuses an ordinary Fabric HTTP run if the saved Artifact switches to Pinokio before route admission', async () => {
    await seed({ brain_type: 'built_in' })
    const selected = await redis.json.get('artifact:art_pk') as any
    expect(selected.brain_type).toBe('built_in')
    const request = event({ artifactId: 'art_pk', prompt: 'Run', brain_type: 'built_in' }, undefined,
      { 'x-batshit-artifact-http-only': '1' })
    await seed() // The route must judge the freshly loaded saved transport, not the caller's claim.
    runnerMocks.run.mockResolvedValue({ text: 'unexpected computation', fileCount: 0, metadata: { transport: 'pinokio-app' } })
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    // Consume an unexpected success too, so the original-code discriminator settles its owner.
    const result = await Promise.resolve(POST(request)).then(async response => { await response.text(); return { status: response.status } }).catch(cause => cause)
    expect(result).toMatchObject({ status: 409 })
    expect(runnerMocks.run).not.toHaveBeenCalled()
    expect(await redis.get('ratelimit:artifact:user_1:art_pk')).toBeNull()
  })

  it('does not let the narrowing HTTP marker bypass Artifact access', async () => {
    await seed({ user_id: 'other', mode: 'edit' })
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    await expect(POST(event({ artifactId: 'art_pk', prompt: 'Run' }, undefined,
      { 'x-batshit-artifact-http-only': '1' }))).rejects.toMatchObject({ status: 403 })
    expect(runnerMocks.run).not.toHaveBeenCalled()
  })

  it('does not authenticate a request merely because it carries the narrowing HTTP marker', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    const request = event({ artifactId: 'art_pk', prompt: 'Run', userId: 'user_1' }, undefined,
      { 'x-batshit-artifact-http-only': '1' })
    request.locals = {}
    const response = await POST(request)
    expect(response.status).toBe(401)
    expect(runnerMocks.run).not.toHaveBeenCalled()
  })

  it('runs the app through the runner, with no model, and streams its text and files', async () => {
    runnerMocks.run.mockImplementation(async (_input: any, emit: any) => {
      await emit.file({ base64: 'data:image/png;base64,AAAA', mediaType: 'image/png', metadata: { appId: 'comfy.git' } }, 0)
      await emit.chunk('Generated 1 image with Comfyui (ComfyUI via Pinokio).')
      return { text: 'Generated 1 image with Comfyui (ComfyUI via Pinokio).', fileCount: 1, metadata: { transport: 'pinokio-app' } }
    })
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    const response = await POST(event({ artifactId: 'art_pk', prompt: 'Run', context: { prompt: 'from panel', steps: 4 }, fields: { prompt: 'from agent' } }))
    expect(response.status).toBe(200)
    const events = await readEvents(response)

    expect(runnerMocks.run).toHaveBeenCalledTimes(1)
    const input = runnerMocks.run.mock.calls[0][0]
    expect(input.binding).toMatchObject({ appId: 'comfy.git', kind: 'comfyui' })
    expect(input.values).toEqual({ prompt: 'from agent', steps: 4 })
    // A file field's Clip id is read from this user's Clips.
    expect(input.userId).toBe('user_1')
    expect(Number(await redis.get('ratelimit:artifact:user_1:art_pk'))).toBe(1)
    expect(events.map((entry) => entry.type)).toEqual(['start', 'file', 'chunk', 'finish', 'end', 'complete'])
    expect(events[0].metadata).toMatchObject({ transport: 'pinokio-app', appId: 'comfy.git' })
    expect(events[1]).toMatchObject({ base64: 'data:image/png;base64,AAAA', mediaType: 'image/png' })
  })

  it('retains the completion rate limit before any app computation', async () => {
    await redis.set('ratelimit:artifact:user_1:art_pk', 10)
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    await expect(POST(event({ artifactId: 'art_pk', prompt: 'Run' }))).rejects.toMatchObject({ status: 429 })
    expect(runnerMocks.run).not.toHaveBeenCalled()
  })

  it('uses the in-process caller admission and never creates an HTTP body grant', async () => {
    const { completePinokioAppArtifact } = await import('$lib/server/artifacts/pinokioAppCompletion')
    const admit = vi.fn(async () => { throw new Error('Originating tool scope was removed') })
    await expect(completePinokioAppArtifact({ artifact: await redis.json.get('artifact:art_pk'), userId: 'user_1', prompt: 'Run', admit })).rejects.toThrow('tool scope was removed')
    expect(admit).toHaveBeenCalledTimes(1)
    expect(runnerMocks.run).not.toHaveBeenCalled()
  })

  it('turns app_offline into an error event carrying its code', async () => {
    const { PinokioAppRunError } = await import('$lib/server/services/pinokioAppRunner')
    runnerMocks.run.mockRejectedValue(
      new PinokioAppRunError('app_offline', 'Comfyui is not running in Pinokio. Start it with fabric:sys.pinokio.run.', {
        appId: 'comfy.git',
        title: 'Comfyui',
        state: 'offline'
      })
    )
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    const events = await readEvents(await POST(event({ artifactId: 'art_pk', prompt: 'Run' })))
    const error = events.find((entry) => entry.type === 'error')
    expect(error?.error).toContain('Comfyui is not running in Pinokio.')
    expect(error?.metadata).toMatchObject({ code: 'app_offline', appId: 'comfy.git', title: 'Comfyui', state: 'offline' })
  })

  it('refuses a pinokio_app artifact with no Pinokio binding before streaming', async () => {
    await seed({ metadata: { source_type: 'comfyui' } })
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    await expect(POST(event({ artifactId: 'art_pk', prompt: 'Run' }))).rejects.toMatchObject({ status: 400 })
    expect(runnerMocks.run).not.toHaveBeenCalled()
  })


  it('refuses a published Pinokio artifact owned by another user', async () => {
    await seed({ user_id: 'other', mode: 'published' })
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    await expect(POST(event({ artifactId: 'art_pk', prompt: 'Run' }))).rejects.toMatchObject({ status: 403 })
    expect(runnerMocks.run).not.toHaveBeenCalled()
  })

  it('passes original Stop directly into the running computation and closes its finite owner', async () => {
    const stopped = new AbortController()
    let observed: AbortSignal | undefined
    runnerMocks.run.mockImplementation(async (input: any) => {
      observed = input.signal
      await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('original Stop')), { once: true }))
    })
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    const response = await POST(event({ artifactId: 'art_pk', prompt: 'Run' }, stopped.signal))
    const consumption = response.text().catch(() => '')
    await vi.waitFor(() => expect(observed).toBeDefined())
    stopped.abort()
    expect(observed!.aborted, 'original Stop reaches runner synchronously').toBe(true)
    let consumed = false
    void consumption.then(() => { consumed = true })
    await vi.waitFor(() => expect(consumed, 'aborted response consumption settles').toBe(true))
    await consumption
    const { fencePinokioOperations } = await import('$lib/server/services/pinokioAdmission')
    const fence = fencePinokioOperations()
    try { await expect(fence.settle(1000)).resolves.toBeUndefined() } finally { fence.release() }
  })

  it('settles original Stop while a response writer is blocked by a reader that stopped pulling', async () => {
    const stopped = new AbortController()
    let writing = false
    runnerMocks.run.mockImplementation(async (_input: any, emit: any) => {
      writing = true
      await emit.chunk('blocked output')
      throw new Error('a stopped writer must not resume this run')
    })
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    const response = await POST(event({ artifactId: 'art_pk', prompt: 'Run' }, stopped.signal))
    const reader = response.body!.getReader()
    await reader.read() // start; deliberately do not pull the following chunk
    await vi.waitFor(() => expect(writing).toBe(true))
    stopped.abort()
    await expect(reader.read()).rejects.toBeDefined()
    const { fencePinokioOperations } = await import('$lib/server/services/pinokioAdmission')
    const fence = fencePinokioOperations()
    try { await fence.settle(1000) } finally { fence.release() }
  })

  it('cancels computation when its response reader is cancelled', async () => {
    let observed: AbortSignal | undefined
    runnerMocks.run.mockImplementation(async (input: any) => {
      observed = input.signal
      await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('reader cancelled')), { once: true }))
    })
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    const response = await POST(event({ artifactId: 'art_pk', prompt: 'Run' }))
    const reader = response.body!.getReader()
    await reader.read()
    await vi.waitFor(() => expect(observed).toBeDefined())
    await reader.cancel()
    await vi.waitFor(() => expect(observed!.aborted).toBe(true))
    const { fencePinokioOperations } = await import('$lib/server/services/pinokioAdmission')
    const fence = fencePinokioOperations()
    try { await fence.settle(1000) } finally { fence.release() }
  })

  it('holds restore admission until a cancelled runner has completely settled', async () => {
    let finish!: () => void
    let observed: AbortSignal | undefined
    runnerMocks.run.mockImplementation(async (input: any) => {
      observed = input.signal
      await new Promise<void>(resolve => { finish = resolve })
      return { text: 'late result', fileCount: 0, metadata: {} }
    })
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    const response = await POST(event({ artifactId: 'art_pk', prompt: 'Run' }))
    const consumption = response.text().catch(() => '')
    await vi.waitFor(() => expect(observed).toBeDefined())
    const { fencePinokioOperations } = await import('$lib/server/services/pinokioAdmission')
    const fence = fencePinokioOperations()
    try {
      expect(observed!.aborted).toBe(true)
      await expect(fence.settle(5)).rejects.toMatchObject({ code: 'pinokio_operation_unsettled' })
      finish()
      await consumption
      await fence.settle(1000)
    } finally { finish(); fence.release() }
  })

  it('freshly refuses deleted/rebound saved artifacts before the next app request', async () => {
    runnerMocks.run.mockImplementation(async (input: any) => {
      await input.admitFetch()
      await seed({ metadata: { ...METADATA, pinokio_app_id: 'other.git' } })
      await input.admitFetch()
      throw new Error('unreachable')
    })
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    const events = await readEvents(await POST(event({ artifactId: 'art_pk', prompt: 'Run' })))
    expect(events.find(entry => entry.type === 'error')?.error).toContain('rebound')
    expect(events.some(entry => entry.type === 'complete')).toBe(false)
  })
  it('lets a Pinokio app take a dropped picture, and keeps the text limit for every other artifact', async () => {
    runnerMocks.run.mockResolvedValue({ text: 'ok', fileCount: 0, metadata: {} })
    const picture = `data:image/png;base64,${'A'.repeat(40_000)}`
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    const ok = await POST(event({ artifactId: 'art_pk', prompt: 'Run', context: { image: picture } }))
    expect(ok.status).toBe(200)
    await ok.text()
    expect(runnerMocks.run.mock.calls[0][0].values.image).toBe(picture)

    await seed({ brain_type: 'built_in', metadata: { source_type: 'built_in' } })
    await expect(POST(event({ artifactId: 'art_pk', prompt: 'Run', context: { image: picture } }))).rejects.toMatchObject({
      status: 413
    })
  })
})
