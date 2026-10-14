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

function event(body: Record<string, unknown>) {
  return {
    request: new Request('http://localhost/api/artifacts/complete', { method: 'POST', body: JSON.stringify(body) }),
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
    expect(events.map((entry) => entry.type)).toEqual(['start', 'file', 'chunk', 'finish', 'end', 'complete'])
    expect(events[0].metadata).toMatchObject({ transport: 'pinokio-app', appId: 'comfy.git' })
    expect(events[1]).toMatchObject({ base64: 'data:image/png;base64,AAAA', mediaType: 'image/png' })
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
