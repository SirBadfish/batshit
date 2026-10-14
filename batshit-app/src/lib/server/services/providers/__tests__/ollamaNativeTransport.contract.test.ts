/** Real installed AI SDK + Ollama provider; synthetic responses, no network/Redis/inference. */
import { describe, expect, it, vi } from 'vitest'
vi.unmock('ai')
vi.unmock('ollama-ai-provider-v2')
import { generateText, streamText } from 'ai'
import { createOllama } from 'ollama-ai-provider-v2'
import { withOllamaOptionsShim } from '../ollamaOptionsShim'
import { withOllamaImageTransportGuard } from '../ollamaImageTransportGuard'
import { ProviderManager } from '../index'
import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const final = {
  model: 'fixture', created_at: '2026-10-02T00:00:00Z',
  message: { role: 'assistant', content: 'Seen.' }, done: true, done_reason: 'stop',
  prompt_eval_count: 12, eval_count: 3
}

describe('Ollama native installed-SDK contract', () => {
  it('installs the guard on the actual direct:ollama provider registration', async () => {
    const fetch = vi.fn(async () => { throw new Error('Unexpected network request') })
    vi.stubGlobal('fetch', fetch)
    try {
      const definition = LOCAL_AI_SERVER_DEFINITIONS.find(entry => entry.id === 'ollama')!
      const manager = new ProviderManager({ apiKeys: {}, localProviders: [{ ...definition,
        enabled: true, baseUrl: 'http://fixture.invalid', openaiPath: '/api',
        imageTransport: 'auto', imageBaseUrl: 'http://fixture.invalid', source: 'default'
      }] })
      const model = manager.getModel('fixture', { transport: 'direct', service: 'ollama' })
      await expect(generateText({ model, maxRetries: 0, messages: [{ role: 'user', content: [
        { type: 'image', image: 'http://fixture.invalid/image.png' }
      ] }] })).rejects.toThrow('Select Automatic image transport')
      expect(fetch).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('sends structured image bytes and settings through the production shim', async () => {
    let sent: any
    const model = withOllamaImageTransportGuard(createOllama({ fetch: withOllamaOptionsShim(async (_url, init) => {
      sent = JSON.parse(init!.body as string)
      return new Response(JSON.stringify(final), { headers: { 'content-type': 'application/json' } })
    }) })('fixture'))
    const result = await generateText({ model, maxRetries: 0, temperature: 0, maxOutputTokens: 5,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe.' }, { type: 'file', data: `data:image/png;base64,${image}`, mediaType: 'image/png' }
      ] }], providerOptions: { ollama: { options: { num_ctx: 2048, top_k: 1 } } }
    })
    expect(sent.messages).toEqual([{ role: 'user', content: 'Describe.', images: [image] }])
    expect(sent.options).toMatchObject({ num_ctx: 2048, top_k: 1, temperature: 0, num_predict: 5 })
    expect(sent.temperature).toBeUndefined()
    expect(result.text).toBe('Seen.')
    expect(result.usage.inputTokens).toBe(12)
    expect(result.usage.outputTokens).toBe(3)
  })

  it.each(['image/png', undefined])('refuses HTTP images with MIME type %s before converter/fetch', async (mediaType) => {
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify(final), { headers: { 'content-type': 'application/json' } })
    })
    const download = vi.fn(async (requests: any[]) => requests.map(() => null))
    const model = withOllamaImageTransportGuard(createOllama({ fetch: withOllamaOptionsShim(fetch) })('fixture'))
    const input = mediaType
      ? { type: 'file' as const, data: new URL('http://fixture.invalid/image.png'), mediaType }
      : { type: 'image' as const, image: new URL('http://fixture.invalid/image.png') }
    await expect(generateText({ model, maxRetries: 0, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Describe.' }, input
    ] }], experimental_download: download })).rejects.toThrow('Select Automatic image transport')
    expect(fetch).not.toHaveBeenCalled()
    expect(download.mock.calls.flatMap(([requests]) => requests).every(entry => entry.isUrlSupportedByModel)).toBe(true)
  })

  it('relays abort after native NDJSON text without completing a successful reply', async () => {
    const stop = new AbortController()
    let wireSignal: AbortSignal | undefined
    let cancelled = false
    const encoder = new TextEncoder()
    const model = withOllamaImageTransportGuard(createOllama({ fetch: withOllamaOptionsShim(async (_url, init) => {
      wireSignal = init!.signal as AbortSignal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify({ ...final, done: false,
            message: { role: 'assistant', content: 'Partial' }
          }) + '\n'))
          wireSignal!.addEventListener('abort', () => {
            cancelled = true
            controller.error(new DOMException('Stopped', 'AbortError'))
          }, { once: true })
        }
      })
      return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
    }) })('fixture'))
    const result = streamText({ model, prompt: 'Continue.', maxRetries: 0, abortSignal: stop.signal })
    const parts: string[] = []
    for await (const part of result.fullStream) {
      parts.push(part.type)
      if (part.type === 'text-delta') stop.abort('user')
    }
    expect(wireSignal!.aborted).toBe(true)
    expect(cancelled).toBe(true)
    expect(parts).toContain('text-delta')
    expect(parts).toContain('abort')
    expect(parts).not.toContain('finish')
  })
})
