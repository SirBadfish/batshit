// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.unmock('ai'); vi.unmock('@ai-sdk/openai')
import { streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { guardResponsesTerminal } from '../responsesTerminalGuard'

describe('BL-1044 installed OpenAI Responses terminal evidence', () => {
  it.each([true, false])('requires an actual terminal event (completed=%s), preserving partial text', async completed => {
    const events = [
      { type: 'response.created', response: { id: 'resp_fixture', created_at: 1790000000, model: 'fixture' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_fixture' } },
      { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, delta: 'Partial fixture text.' },
      ...(completed ? [{ type: 'response.completed', response: { usage: { input_tokens: 4, output_tokens: 5 } } }] : []),
    ]
    const model = createOpenAI({ apiKey: 'synthetic', fetch: async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) }).responses('fixture')
    const result = streamText({ model: guardResponsesTerminal(model), messages: [{ role: 'user', content: 'Fixture' }], maxRetries: 0, onError: () => {} })
    const parts = []; let failure: unknown
    try { for await (const part of result.stream) parts.push(part) } catch (error) { failure = error }
    expect(parts.filter(part => part.type === 'text-delta').map(part => part.text).join('')).toBe('Partial fixture text.')
    if (completed) { expect(failure).toBeUndefined(); expect(parts.some(part => part.type === 'finish')).toBe(true) }
    else { expect(String(failure)).toContain('without a terminal'); expect(parts.some(part => part.type === 'finish')).toBe(false) }
  })
})
