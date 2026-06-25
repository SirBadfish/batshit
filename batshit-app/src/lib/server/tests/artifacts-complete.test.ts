import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '../redis'

vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

const aiMocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  generateSpeech: vi.fn(),
  streamText: vi.fn(),
  streamNativeMode: vi.fn(),
  outputObject: vi.fn((options: Record<string, any>) => options),
  jsonSchema: vi.fn((schema: Record<string, any>) => schema)
}))

const sdkMocks = vi.hoisted(() => ({
  createOpenAI: vi.fn(),
  openaiImage: vi.fn(),
  openaiSpeech: vi.fn(),
  createFal: vi.fn(),
  falImage: vi.fn(),
  falSpeech: vi.fn(),
  createLuma: vi.fn(),
  lumaImage: vi.fn(),
  createReplicate: vi.fn(),
  replicateImage: vi.fn()
}))

const providerMocks = vi.hoisted(() => ({
  createForUser: vi.fn(),
  getModel: vi.fn()
}))

const catalogMocks = vi.hoisted(() => ({
  fetchVercelModelCatalog: vi.fn()
}))

const routeMocks = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  retrieveApiKey: vi.fn()
}))

const directOpenAIFetchMock = vi.hoisted(() => vi.fn())

vi.mock('ai', () => {
  return {
    generateImage: aiMocks.generateImage,
    experimental_generateSpeech: aiMocks.generateSpeech,
    streamText: aiMocks.streamText,
    Output: {
      object: aiMocks.outputObject
    },
    jsonSchema: aiMocks.jsonSchema
  }
})

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: sdkMocks.createOpenAI
}))

vi.mock('@ai-sdk/fal', () => ({
  createFal: sdkMocks.createFal
}))

vi.mock('@ai-sdk/luma', () => ({
  createLuma: sdkMocks.createLuma
}))

vi.mock('@ai-sdk/replicate', () => ({
  createReplicate: sdkMocks.createReplicate
}))

vi.mock('$lib/server/services/vercelBrain', () => {
  return {
    VercelAIBrain: vi.fn(function MockVercelAIBrain(this: Record<string, unknown>) {
      Object.assign(this, {
        streamNativeMode: aiMocks.streamNativeMode
      })
    })
  }
})

vi.mock('$lib/server/services/providers', () => {
  return {
    ProviderManager: {
      createForUser: providerMocks.createForUser
    }
  }
})

vi.mock('$env/dynamic/private', () => ({
  env: routeMocks.env
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: routeMocks.retrieveApiKey
  }
}))

vi.mock('$lib/server/services/vercelModelCatalog', () => ({
  fetchVercelModelCatalog: catalogMocks.fetchVercelModelCatalog
}))

useRedisTestServer()

async function seedArtifactRecord(overrides: Record<string, any> = {}) {
  await redis.json.set('artifact:art_1', '$', {
    id: 'art_1',
    user_id: 'user_1',
    name: 'Test Artifact',
    content: '<html></html>',
    model: 'test-model',
    mode: 'edit',
    ...overrides
  } as any)
}

function buildEvent(body: Record<string, any>, userId = 'user_1') {
  return {
    request: new Request('http://localhost/api/artifacts/complete', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
    locals: { user: { id: userId } },
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: 'webhook response', usage: { totalTokens: 3 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
  } as any
}

async function readResponseBody(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value)
  }

  return buffer
}

async function waitForArtifactRun(
  artifactId: string,
  runId: string,
  predicate: (record: any) => boolean,
  timeoutMs = 2000
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const record = await redis.json.get(`artifact_run:user_1:${artifactId}:${runId}`)
    if (record && predicate(record)) return record as any
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for artifact run ${runId}`)
}

// Real-Redis suite (G-0228): this file intentionally restores the REAL $lib/server/redis
// module via vi.importActual, so it runs only under `npm run test:redis`
// (VITEST_USE_REAL_REDIS=true) and reports as skipped in the default mocked lane.
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe.runIf(REAL_REDIS_LANE)('POST /api/artifacts/complete', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', directOpenAIFetchMock)
    for (const key of Object.keys(routeMocks.env)) {
      delete routeMocks.env[key]
    }
    routeMocks.retrieveApiKey.mockResolvedValue(null)
    catalogMocks.fetchVercelModelCatalog.mockResolvedValue({
      fetchedAt: '2026-06-06T00:00:00.000Z',
      models: []
    })
    sdkMocks.createOpenAI.mockReturnValue({
      image: sdkMocks.openaiImage,
      speech: sdkMocks.openaiSpeech
    })
    sdkMocks.openaiImage.mockImplementation((modelId: string) => ({ provider: 'openai', modelId }))
    sdkMocks.openaiSpeech.mockImplementation((modelId: string) => ({ provider: 'openai', modelId }))
    sdkMocks.createFal.mockReturnValue({
      image: sdkMocks.falImage,
      speech: sdkMocks.falSpeech
    })
    sdkMocks.falImage.mockImplementation((modelId: string) => ({ provider: 'fal', modelId }))
    sdkMocks.falSpeech.mockImplementation((modelId: string) => ({ provider: 'fal', modelId }))
    sdkMocks.createLuma.mockReturnValue({
      image: sdkMocks.lumaImage
    })
    sdkMocks.lumaImage.mockImplementation((modelId: string) => ({ provider: 'luma', modelId }))
    sdkMocks.createReplicate.mockReturnValue({
      image: sdkMocks.replicateImage
    })
    sdkMocks.replicateImage.mockImplementation((modelId: string) => ({ provider: 'replicate', modelId }))
    aiMocks.generateImage.mockResolvedValue({
      images: [{ base64: 'ZmFrZS1pbWFnZQ==' }],
      usage: { totalTokens: 12 }
    })
    directOpenAIFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: 'ZmFrZS1vcGVuYWktaW1hZ2U=' }],
          output_format: 'png',
          usage: { total_tokens: 12 }
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    )
    aiMocks.generateSpeech.mockResolvedValue({
      audio: new Uint8Array([1, 2, 3])
    })
    aiMocks.streamNativeMode.mockResolvedValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'Hello ' }
        yield { type: 'text-delta', text: 'world' }
        yield { type: 'finish', usage: { totalTokens: 5 } }
      })()
    })
    providerMocks.getModel.mockReturnValue({ id: 'mock-language-model' })
    providerMocks.createForUser.mockResolvedValue({
      getModel: providerMocks.getModel
    })
    await seedArtifactRecord()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requires authentication', async () => {
    const event = buildEvent({ artifactId: 'art_1', prompt: 'hello' })
    event.locals = {}

    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    const response = await POST(event)
    expect(response.status).toBe(401)
  })

  it('enforces rate limits per user+artifact', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    await seedArtifactRecord()

    // 10 allowed, 11th should fail
    for (let i = 0; i < 10; i++) {
      await seedArtifactRecord({ webhook_url: 'http://example.com' })
      const res = await POST(
        buildEvent({ artifactId: 'art_1', prompt: `hello ${i}`, webhookUrl: 'http://example.com' })
      )
      expect(res.status).toBe(200)
    }

    await seedArtifactRecord({ webhook_url: 'http://example.com' })
    await expect(
      POST(buildEvent({ artifactId: 'art_1', prompt: 'limit hit', webhookUrl: 'http://example.com' }))
    ).rejects.toHaveProperty('status', 429)
  })

  it('rejects request-supplied webhook URLs that are not saved on the artifact', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    await seedArtifactRecord({ webhook_url: 'http://trusted.example.com' })

    await expect(
      POST(buildEvent({ artifactId: 'art_1', prompt: 'hello', webhookUrl: 'http://evil.example.com' }))
    ).rejects.toHaveProperty('status', 403)
  })

  it('rewrites custom artifact webhook loopback URLs to the Docker host gateway', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    await redis.del('ratelimit:artifact:user_1:art_1')
    routeMocks.env.BATSHIT_CONTAINERIZED = '1'
    await seedArtifactRecord({
      brain_type: 'custom_webhook',
      webhook_url: 'http://localhost:8000/run'
    })

    const event = buildEvent({
      artifactId: 'art_1',
      prompt: 'hello',
      webhookUrl: 'http://localhost:8000/run'
    })
    const response = await POST(event)

    expect(response.status).toBe(200)
    await readResponseBody(response)
    expect(event.fetch).toHaveBeenCalledWith(
      'http://host.docker.internal:8000/run',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('rewrites n8n artifact webhook loopback URLs to bundled Docker n8n', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')
    await redis.del('ratelimit:artifact:user_1:art_1')
    routeMocks.env.BATSHIT_CONTAINERIZED = '1'
    routeMocks.env.N8N_API_URL = 'http://n8n:5678'
    routeMocks.retrieveApiKey.mockImplementation(async (service: string) =>
      service === 'n8n_api_url' ? 'http://localhost:5678' : null
    )
    await seedArtifactRecord({
      brain_type: 'n8n_workflow',
      webhook_url: 'http://localhost:5678/webhook/artifact'
    })

    const event = buildEvent({
      artifactId: 'art_1',
      prompt: 'hello',
      webhookUrl: 'http://localhost:5678/webhook/artifact'
    })
    const response = await POST(event)

    expect(response.status).toBe(200)
    await readResponseBody(response)
    expect(event.fetch).toHaveBeenCalledWith(
      'http://n8n:5678/webhook/artifact',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('streams Mode 3 completions with NDJSON envelope', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    // Ensure rate limit bucket is clear for this scenario
    await redis.del('ratelimit:artifact:user_1:art_1')

    const event = buildEvent({ artifactId: 'art_1', prompt: 'stream please', sessionId: 'sess_mode3' })
    const response = await POST(event)

    expect(response.status).toBe(200)
    const buffer = await readResponseBody(response)

    expect(buffer).toContain('"type":"start"')
    expect(buffer).toContain('"type":"end"')
    expect(buffer).toContain('"type":"complete"')
    expect(buffer).toContain('"zipReferences":[]')
    expect(buffer).not.toContain('batshit-zip:')
    expect(aiMocks.streamNativeMode).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 8192,
        temperature: undefined,
        toolsEnabled: false
      })
    )
  })

  it('streams Mode 3 completions using saved generation settings instead of hardcoded caps', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await redis.del('ratelimit:artifact:user_1:art_1')
    await redis.json.set('model:preset_artifact_text', '$', {
      id: 'preset_artifact_text',
      modelId: 'gpt-4.1-mini',
      modelName: 'GPT 4.1 Mini',
      provider: 'openai',
      purpose: 'chat',
      connection: {
        type: 'direct',
        service: 'openai'
      },
      settings: {
        maxTokens: 64000,
        temperature: 0.72,
        topP: 0.91,
        topK: 40,
        presencePenalty: 0.2,
        frequencyPenalty: 0.3,
        seed: 1234,
        stopSequences: ['END'],
        openai: {
          reasoningEffort: 'low'
        }
      }
    })
    await seedArtifactRecord({
      model_config: {
        mode: 'basic',
        primary: {
          source: 'preset',
          presetId: 'preset_artifact_text',
          modelId: null
        }
      }
    })

    const response = await POST(
      buildEvent({ artifactId: 'art_1', prompt: 'use saved settings', sessionId: 'sess_mode3_settings' })
    )

    expect(response.status).toBe(200)
    const buffer = await readResponseBody(response)
    expect(buffer).toContain('"type":"complete"')
    expect(aiMocks.streamNativeMode).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4.1-mini',
        maxTokens: 64000,
        temperature: 0.72,
        topP: 0.91,
        topK: 40,
        presencePenalty: 0.2,
        frequencyPenalty: 0.3,
        seed: 1234,
        stopSequences: ['END'],
        providerOptions: {
          openai: {
            reasoningEffort: 'low'
          }
        },
        toolsEnabled: false
      })
    )
  })

  it('rejects object mode requests without a schema', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await expect(async () => {
      await POST(buildEvent({ artifactId: 'art_1', prompt: 'need schema', mode: 'object' }))
    }).rejects.toHaveProperty('status', 400)
  })

  it('rejects object mode requests with a null schema', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await expect(async () => {
      await POST(buildEvent({ artifactId: 'art_1', prompt: 'need object schema', mode: 'object', schema: null }))
    }).rejects.toHaveProperty('status', 400)
  })

  it('streams object mode using provider-routed model resolution', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await redis.del('ratelimit:artifact:user_1:art_1')
    await seedArtifactRecord()

    aiMocks.streamText.mockReturnValue({
      partialOutputStream: (async function* () {
        yield { calls: [] }
      })(),
      output: Promise.resolve({ calls: [] }),
      usage: Promise.resolve({ totalTokens: 12 })
    })

    const response = await POST(
      buildEvent({
        artifactId: 'art_1',
        prompt: 'Build a plan',
        mode: 'object',
        context: { topic: 'search' },
        schema: {
          type: 'object',
          properties: {
            calls: { type: 'array' }
          },
          required: ['calls']
        },
        schemaName: 'PlanSchema'
      })
    )

    expect(response.status).toBe(200)
    const buffer = await readResponseBody(response)

    expect(buffer).toContain('"type":"object_partial"')
    expect(buffer).toContain('"type":"object_final"')
    expect(buffer).toContain('"type":"complete"')
    expect(providerMocks.createForUser).toHaveBeenCalledWith('user_1')
    expect(providerMocks.getModel).toHaveBeenCalledWith(
      'test-model',
      expect.objectContaining({ transport: undefined, service: undefined })
    )
    expect(aiMocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({ role: 'user', content: expect.stringContaining('Context:') })
        ])
      })
    )
  })

  it('hydrates manual visual models from the catalog and uses the saved OpenAI key for GPT Image 2', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await redis.del('ratelimit:artifact:user_1:art_1')
    catalogMocks.fetchVercelModelCatalog.mockResolvedValue({
      fetchedAt: '2026-06-06T00:00:00.000Z',
      models: [
        {
          id: 'openai/gpt-image-2',
          canonicalId: 'openai/gpt-image-2',
          provider: 'openai',
          upstreamProvider: 'openai',
          name: 'gpt-image-2',
          displayName: 'GPT Image 2',
          tags: ['image', 'openai'],
          features: { imageGeneration: true },
          purpose: 'visual',
          idVariants: {
            'vercel-gateway': {
              developerId: 'openai',
              modelId: 'gpt-image-2',
              effectiveId: 'openai/gpt-image-2',
              source: 'vercel'
            },
            'direct:openai': {
              developerId: 'openai',
              modelId: 'gpt-image-2',
              effectiveId: 'gpt-image-2',
              source: 'direct'
            }
          },
          source: 'vercel',
          transport: 'vercel-gateway',
          connectionId: 'vercel-gateway',
          availableConnections: ['vercel-gateway', 'direct:openai']
        }
      ]
    })
    routeMocks.retrieveApiKey.mockImplementation(async (service: string) =>
      service === 'openai' ? 'sk-user-openai' : null
    )
    await seedArtifactRecord({
      model_config: {
        mode: 'basic',
        primary: {
          source: 'manual',
          modelId: 'gpt-image-2'
        }
      }
    })

    const response = await POST(
      buildEvent({
        artifactId: 'art_1',
        prompt: 'a neon artifact preview',
        mode: 'generate'
      })
    )

    expect(response.status).toBe(200)
    const buffer = await readResponseBody(response)

    expect(buffer).toContain('"type":"file"')
    expect(buffer).toContain('"type":"complete"')
    expect(sdkMocks.createOpenAI).not.toHaveBeenCalled()
    expect(sdkMocks.openaiImage).not.toHaveBeenCalled()
    expect(aiMocks.generateImage).not.toHaveBeenCalled()
    expect(directOpenAIFetchMock).toHaveBeenCalledTimes(1)
    const [openAIUrl, openAIRequest] = directOpenAIFetchMock.mock.calls[0]
    expect(openAIUrl).toBe('https://api.openai.com/v1/images/generations')
    expect(openAIRequest).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-user-openai',
        'Content-Type': 'application/json'
      }
    })
    const openAIRequestBody = JSON.parse(openAIRequest.body)
    expect(openAIRequestBody).toEqual({
      model: 'gpt-image-2',
      prompt: 'a neon artifact preview',
      n: 1,
      size: '1024x1024'
    })
    expect(openAIRequestBody).not.toHaveProperty('response_format')

    const runIds = await redis.execute(async (client) =>
      client.lRange('artifact_runs:user_1:art_1', 0, -1)
    )
    const runLog = await redis.json.get(`artifact_run:user_1:art_1:${runIds[0]}`)
    expect((runLog as any)?.status).toBe('success')
    expect((runLog as any)?.model).toMatchObject({
      configuredSource: 'manual',
      resolvedModel: 'gpt-image-2',
      connectionType: 'direct',
      connectionService: 'openai',
      purpose: 'visual',
      chosenTransport: 'image'
    })
    expect((runLog as any)?.result?.fileCount).toBe(1)
  })

  it('uses the saved xAI key for Grok Imagine image edits with source images', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await redis.del('ratelimit:artifact:user_1:art_1')
    catalogMocks.fetchVercelModelCatalog.mockResolvedValue({
      fetchedAt: '2026-06-06T00:00:00.000Z',
      models: [
        {
          id: 'xai/grok-imagine-image-quality',
          canonicalId: 'xai/grok-imagine-image-quality',
          provider: 'xai',
          upstreamProvider: 'replicate',
          name: 'grok-imagine-image-quality',
          displayName: 'Grok Imagine Image Quality',
          tags: ['image', 'xai', 'grok'],
          features: { imageGeneration: true },
          purpose: 'visual',
          idVariants: {
            'direct:replicate': {
              developerId: 'xai',
              modelId: 'grok-imagine-image-quality',
              effectiveId: 'xai/grok-imagine-image-quality',
              source: 'direct'
            }
          },
          source: 'direct',
          transport: 'direct',
          connectionId: 'direct:replicate',
          availableConnections: ['direct:replicate']
        }
      ]
    })
    let generatedIndex = 0
    directOpenAIFetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith('https://imgen.x.ai/')) {
        return new Response('fake-xai-image-bytes', {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' }
        })
      }

      generatedIndex += 1
      return new Response(
        JSON.stringify({
          data: [
            {
              url: `https://imgen.x.ai/generated-${generatedIndex}.jpeg`,
              mime_type: 'image/jpeg'
            }
          ],
          usage: { cost_in_usd_ticks: 500000000 }
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    })
    routeMocks.retrieveApiKey.mockImplementation(async (service: string) =>
      service === 'xai' ? 'xai-user-key' : null
    )
    await seedArtifactRecord({
      model_config: {
        mode: 'basic',
        primary: {
          source: 'manual',
          modelId: 'grok-imagine-image-quality'
        }
      }
    })

    const response = await POST(
      buildEvent({
        artifactId: 'art_1',
        prompt: 'turn this into a cinematic pencil sketch',
        mode: 'edit',
        n: 2,
        aspectRatio: '3:2',
        providerOptions: { xai: { resolution: '2k' } },
        images: [
          {
            data: 'data:image/png;base64,ZmFrZS1zb3VyY2U=',
            mediaType: 'image/png'
          }
        ]
      })
    )

    expect(response.status).toBe(200)
    const buffer = await readResponseBody(response)

    expect(buffer).toContain('"type":"file"')
    expect(buffer).toContain('"type":"complete"')
    expect(directOpenAIFetchMock).toHaveBeenCalledTimes(4)
    const [xaiUrl, xaiRequest] = directOpenAIFetchMock.mock.calls[0]
    expect(xaiUrl).toBe('https://api.x.ai/v1/images/edits')
    expect(xaiRequest).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer xai-user-key',
        'Content-Type': 'application/json'
      }
    })
    const xaiRequestBody = JSON.parse(xaiRequest.body)
    expect(xaiRequestBody).toEqual({
      model: 'grok-imagine-image-quality',
      prompt: 'turn this into a cinematic pencil sketch',
      resolution: '2k',
      image: {
        type: 'image_url',
        url: 'data:image/png;base64,ZmFrZS1zb3VyY2U='
      }
    })
    expect(xaiRequestBody).not.toHaveProperty('response_format')
    expect(xaiRequestBody).not.toHaveProperty('aspect_ratio')
    expect(aiMocks.generateImage).not.toHaveBeenCalled()

    const runIds = await redis.execute(async (client) =>
      client.lRange('artifact_runs:user_1:art_1', 0, -1)
    )
    const runLog = await redis.json.get(`artifact_run:user_1:art_1:${runIds[0]}`)
    expect((runLog as any)?.status).toBe('success')
    expect((runLog as any)?.model).toMatchObject({
      configuredSource: 'manual',
      resolvedModel: 'grok-imagine-image-quality',
      connectionType: 'direct',
      connectionService: 'xai',
      purpose: 'visual',
      chosenTransport: 'image'
    })
    expect((runLog as any)?.request?.options?.imageCount).toBe(1)
    expect((runLog as any)?.result?.fileCount).toBe(2)
  })

  it('streams an error event for OpenAI image safety rejections instead of crashing', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await redis.del('ratelimit:artifact:user_1:art_1')
    directOpenAIFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message:
              'Your request was rejected by the safety system. Include request ID req_test_safety.'
          }
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    )
    routeMocks.retrieveApiKey.mockImplementation(async (service: string) =>
      service === 'openai' ? 'sk-user-openai' : null
    )
    await seedArtifactRecord({
      model_config: {
        mode: 'basic',
        primary: {
          source: 'manual',
          modelId: 'gpt-image-2'
        }
      }
    })

    const response = await POST(
      buildEvent({
        artifactId: 'art_1',
        prompt: 'image prompt rejected by provider safety',
        mode: 'generate'
      })
    )

    expect(response.status).toBe(200)
    const buffer = await readResponseBody(response)

    expect(buffer).toContain('"type":"error"')
    expect(buffer).toContain('rejected by the safety system')
    expect(buffer).not.toContain('"type":"complete"')

    const runIds = await redis.execute(async (client) =>
      client.lRange('artifact_runs:user_1:art_1', 0, -1)
    )
    const runLog = await redis.json.get(`artifact_run:user_1:art_1:${runIds[0]}`)
    expect((runLog as any)?.status).toBe('error')
    expect((runLog as any)?.errors?.[0]?.message).toContain('rejected by the safety system')
  })

  it('streams a stable error event when an image provider rejects with undefined', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await redis.del('ratelimit:artifact:user_1:art_1')
    aiMocks.generateImage.mockRejectedValueOnce(undefined)
    routeMocks.retrieveApiKey.mockImplementation(async (service: string) =>
      service === 'fal' ? 'fal-user-key' : null
    )
    await seedArtifactRecord({
      model_config: {
        mode: 'basic',
        primary: {
          source: 'manual',
          modelId: 'fal-ai/flux/dev'
        }
      }
    })

    const response = await POST(
      buildEvent({
        artifactId: 'art_1',
        prompt: 'provider rejects without an Error object',
        mode: 'generate'
      })
    )

    expect(response.status).toBe(200)
    const buffer = await readResponseBody(response)

    expect(buffer).toContain('"type":"error"')
    expect(buffer).toContain('Image generation failed')
    expect(buffer).not.toContain('undefined')

    const runIds = await redis.execute(async (client) =>
      client.lRange('artifact_runs:user_1:art_1', 0, -1)
    )
    const runLog = await redis.json.get(`artifact_run:user_1:art_1:${runIds[0]}`)
    expect((runLog as any)?.status).toBe('error')
    expect((runLog as any)?.errors?.[0]?.message).toContain('Image generation failed')
  })

  it('records closed artifact streams as delivery disconnects instead of image generation failures', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await redis.del('ratelimit:artifact:user_1:art_1')
    let resolveOpenAIImage: (response: Response) => void = () => {}
    directOpenAIFetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveOpenAIImage = resolve
      })
    )
    routeMocks.retrieveApiKey.mockImplementation(async (service: string) =>
      service === 'openai' ? 'sk-user-openai' : null
    )
    await seedArtifactRecord({
      model_config: {
        mode: 'basic',
        primary: {
          source: 'manual',
          modelId: 'gpt-image-2'
        }
      }
    })

    const response = await POST(
      buildEvent({
        artifactId: 'art_1',
        prompt: 'a long-running image request that the browser closes',
        mode: 'generate',
        model: 'gpt-image-2'
      })
    )

    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const first = await reader.read()
    const startEvent = JSON.parse(new TextDecoder().decode(first.value).trim())
    const runId = startEvent.metadata.runId
    expect(startEvent.type).toBe('start')
    await reader.cancel()

    resolveOpenAIImage(
      new Response(
        JSON.stringify({
          data: [{ b64_json: 'ZmFrZS1vcGVuYWktaW1hZ2U=' }],
          output_format: 'png',
          usage: { total_tokens: 12 }
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    )

    const runLog = await waitForArtifactRun('art_1', runId, (record) => record.status === 'error')
    expect(runLog.errors?.[0]?.source).toBe('client_disconnect')
    expect(runLog.errors?.[0]?.message).toContain('Artifact completion stream closed before the chunk event')
    expect(runLog.errors?.[0]?.message).not.toContain('Image generation failed')
  })

  it('fails visual generation runs clearly when the selected model returns zero files', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await redis.del('ratelimit:artifact:user_1:art_1')
    directOpenAIFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [],
          usage: { total_tokens: 4 }
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    )
    routeMocks.retrieveApiKey.mockImplementation(async (service: string) =>
      service === 'openai' ? 'sk-user-openai' : null
    )
    await seedArtifactRecord({
      model_config: {
        mode: 'basic',
        primary: {
          source: 'manual',
          modelId: 'gpt-image-2'
        }
      }
    })

    const response = await POST(
      buildEvent({
        artifactId: 'art_1',
        prompt: 'this should fail',
        mode: 'generate'
      })
    )

    expect(response.status).toBe(200)
    const buffer = await readResponseBody(response)

    expect(buffer).toContain('"type":"error"')
    expect(buffer).toContain('zero generated images')

    const runIds = await redis.execute(async (client) =>
      client.lRange('artifact_runs:user_1:art_1', 0, -1)
    )
    const runLog = await redis.json.get(`artifact_run:user_1:art_1:${runIds[0]}`)
    expect((runLog as any)?.status).toBe('error')
    expect((runLog as any)?.result?.fileCount).toBe(0)
    expect((runLog as any)?.errors?.[0]?.message).toContain('zero generated images')
  })

  it('does not use a user default model when artifact source is auto', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await redis.del('ratelimit:artifact:user_1:art_1')
    await redis.json.set('artifact:art_1', '$', {
      id: 'art_1',
      user_id: 'user_1',
      name: 'Test Artifact',
      content: '<html></html>',
      mode: 'edit'
    } as any)
    await redis.json.set('model:preset_default_artifact', '$', {
      id: 'preset_default_artifact',
      modelId: 'gpt-4.1-mini',
      modelName: 'GPT 4.1 Mini',
      provider: 'openai',
      purpose: 'chat',
      connection: {
        type: 'direct',
        service: 'openai'
      },
      settings: {
        temperature: 0.33,
        openai: {
          reasoningEffort: 'medium'
        }
      }
    })
    await redis.json.set('user:user_1:settings', '$', {
      id: 'settings_user_1',
      user_id: 'user_1',
      artifact_defaults: {
        model_config: {
          mode: 'basic',
          primary: {
            source: 'preset',
            presetId: 'preset_default_artifact',
            modelId: null
          }
        }
      }
    })
    const storedSettings = await redis.json.get('user:user_1:settings', '$')
    const normalizedSettings = Array.isArray(storedSettings) ? storedSettings[0] : storedSettings
    expect((normalizedSettings as any)?.artifact_defaults?.model_config?.primary?.source).toBe('preset')
    const storedPreset = await redis.get('model:preset_default_artifact')
    expect((storedPreset as any)?.modelId).toBe('gpt-4.1-mini')

    await expect(async () => {
      await POST(
        buildEvent({
          artifactId: 'art_1',
          prompt: 'Build fallback plan',
          mode: 'object',
          schema: {
            type: 'object',
            properties: {
              calls: { type: 'array' }
            },
            required: ['calls']
          },
          schemaName: 'FallbackSchema'
        })
      )
    }).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({
        message: expect.stringContaining('No model selected')
      })
    })

    expect(providerMocks.getModel).not.toHaveBeenCalledWith(
      'gpt-4.1-mini',
      expect.anything()
    )

    const runIds = await redis.execute(async (client) =>
      client.lRange('artifact_runs:user_1:art_1', 0, -1)
    )
    expect(runIds.length).toBeGreaterThan(0)
    const runLog = await redis.json.get(`artifact_run:user_1:art_1:${runIds[0]}`)
    expect((runLog as any)?.status).toBe('error')
    expect((runLog as any)?.errors?.[0]?.message).toContain('No model selected')
  })

  it('fails clearly when artifact has no selected model', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await redis.del('ratelimit:artifact:user_1:art_1')
    await redis.json.set('artifact:art_1', '$', {
      id: 'art_1',
      user_id: 'user_1',
      name: 'Test Artifact',
      content: '<html></html>',
      mode: 'edit'
    } as any)
    await redis.json.set('agent:cr_agent', '$', {
      primary_model_name: 'gpt-fallback-should-not-be-used'
    })
    await redis.json.set('user:user_1:settings', '$', {
      id: 'settings_user_1',
      user_id: 'user_1',
      artifact_defaults: {
        model_config: {
          mode: 'basic',
          primary: {
            source: 'none',
            presetId: null,
            modelId: null
          }
        }
      }
    })

    await expect(async () => {
      await POST(
        buildEvent({
          artifactId: 'art_1',
          prompt: 'Needs a configured model',
          mode: 'object',
          schema: {
            type: 'object',
            properties: {
              calls: { type: 'array' }
            },
            required: ['calls']
          },
          schemaName: 'MissingDefaultSchema'
        })
      )
    }).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({
        message: expect.stringContaining('No model selected')
      })
    })
  })

  it('fails when artifact preset is missing instead of silently falling back', async () => {
    const { POST } = await import('../../../routes/api/artifacts/complete/+server')

    await redis.del('ratelimit:artifact:user_1:art_1')
    await redis.json.set('artifact:art_1', '$', {
      id: 'art_1',
      user_id: 'user_1',
      name: 'Test Artifact',
      content: '<html></html>',
      mode: 'edit',
      model_config: {
        mode: 'basic',
        primary: {
          source: 'preset',
          presetId: 'missing_preset',
          modelId: null
        }
      }
    } as any)
    await redis.json.set('user:user_1:settings', '$', {
      id: 'settings_user_1',
      user_id: 'user_1',
      artifact_defaults: {
        model_config: {
          mode: 'basic',
          primary: {
            source: 'manual',
            modelId: 'gpt-4.1-mini'
          }
        }
      }
    })

    await expect(async () => {
      await POST(
        buildEvent({
          artifactId: 'art_1',
          prompt: 'Should fail on missing preset',
          mode: 'object',
          schema: {
            type: 'object',
            properties: {
              calls: { type: 'array' }
            },
            required: ['calls']
          }
        })
      )
    }).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({
        message: expect.stringContaining('model preset is missing or invalid')
      })
    })
  })
})
