import { describe, expect, it, vi } from 'vitest'
import {
  moveOllamaTopLevelSettingsIntoOptions,
  withOllamaOptionsShim
} from '../ollamaOptionsShim'

/**
 * SA-125 DL-125-06. `ollama-ai-provider-v2` 4.0.1 writes the AI SDK's standard
 * settings at the top level of the `/api/chat` body, where Ollama does not read
 * them. Measured live 2026-09-20: without this shim, temperature 0 and
 * temperature 2 produced byte-identical output; with it they diverge.
 *
 * Every assertion here is that measurement, frozen.
 */
describe('SA-125 Ollama options shim', () => {
  it('moves temperature and the output cap where Ollama reads them', () => {
    const body = moveOllamaTopLevelSettingsIntoOptions({
      model: 'llama3.2:latest',
      temperature: 0.42,
      top_p: 0.77,
      max_output_tokens: 30,
      think: false,
      stream: false
    })

    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.max_output_tokens).toBeUndefined()
    // Ollama's output cap has its own name.
    expect(body.options).toEqual({ temperature: 0.42, top_p: 0.77, num_predict: 30 })
    // Everything the provider owns is left alone.
    expect(body.model).toBe('llama3.2:latest')
    expect(body.think).toBe(false)
    expect(body.stream).toBe(false)
  })

  it('lets an explicit options value win over the SDK serialisation', () => {
    // `options.temperature` came from a Model Preset parameter routed through
    // providerOptions; the top-level copy is only how the SDK spelled it.
    const body = moveOllamaTopLevelSettingsIntoOptions({
      temperature: 2,
      options: { temperature: 0.1, seed: 5 }
    })
    expect(body.options).toEqual({ temperature: 0.1, seed: 5 })
    expect(body.temperature).toBeUndefined()
  })

  it('does not let two output-cap spellings fight', () => {
    const body = moveOllamaTopLevelSettingsIntoOptions({
      max_output_tokens: 30,
      max_tokens: 999
    })
    expect(body.options).toEqual({ num_predict: 30 })
  })

  it('keeps an existing options object and merges into it', () => {
    const body = moveOllamaTopLevelSettingsIntoOptions({
      temperature: 0.5,
      options: { top_k: 20, min_p: 0.05 }
    })
    expect(body.options).toEqual({ top_k: 20, min_p: 0.05, temperature: 0.5 })
  })

  it('drops a null or undefined setting instead of sending it', () => {
    const body = moveOllamaTopLevelSettingsIntoOptions({
      temperature: null,
      top_p: undefined,
      seed: 7
    })
    expect(body.options).toEqual({ seed: 7 })
    expect('temperature' in body).toBe(false)
  })

  it('becomes a no-op once upstream stops sending top-level settings', () => {
    // The shim must be safe to leave in place after a provider fix.
    const original = { model: 'llama3.2:latest', options: { temperature: 1 }, stream: true }
    expect(moveOllamaTopLevelSettingsIntoOptions({ ...original })).toEqual(original)
  })

  it('rewrites the body through fetch', async () => {
    const base = vi.fn(async () => new Response('{}'))
    const shimmed = withOllamaOptionsShim(base as unknown as typeof fetch)
    await shimmed('http://x/api/chat' as any, {
      method: 'POST',
      body: JSON.stringify({ temperature: 0.3, max_output_tokens: 12 })
    } as any)

    const sent = JSON.parse((base.mock.calls[0] as any)[1].body)
    expect(sent.options).toEqual({ temperature: 0.3, num_predict: 12 })
  })

  it('never fails a send because a body was not JSON it understands', async () => {
    const base = vi.fn(async () => new Response('{}'))
    const shimmed = withOllamaOptionsShim(base as unknown as typeof fetch)
    await shimmed('http://x/api/chat' as any, { method: 'POST', body: 'not json' } as any)
    expect((base.mock.calls[0] as any)[1].body).toBe('not json')

    await shimmed('http://x/api/tags' as any, { method: 'GET' } as any)
    expect(base).toHaveBeenCalledTimes(2)
  })
})
