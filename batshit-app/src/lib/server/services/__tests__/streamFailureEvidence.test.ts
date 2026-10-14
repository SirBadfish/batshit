import { describe, expect, it } from 'vitest'
import { createAlibaba } from '@ai-sdk/alibaba'

import {
  createStreamStepRecorder,
  isContextExhaustedStreamFailure,
  providerStreamErrorFrom,
  ProviderStreamError
} from '../streamFailureEvidence'
import { buildVercelLlmCapture } from '../executionViewerLlmCapture'

/**
 * BL-245 — a reply that fails mid-stream keeps its model calls in the Execution Viewer, and the
 * chat shows the provider's own words for an error it sent as a stream chunk.
 *
 * The stream parts below are the AI SDK 7 shapes send-routed's loop reads (`start-step` carries
 * the request body because the API lane asks for it; `finish-step` carries the call's usage). The
 * error chunk is DashScope's, exactly as SA-126 B0 recorded it, parsed by the REAL
 * `@ai-sdk/alibaba` provider (the default lane does not mock it).
 */

const DASHSCOPE_ERROR_CHUNK = {
  error: {
    message:
      '<50004> InternalError.Algo.InternalPostprocessError: Internal Error during model post-process.',
    type: 'internal_server_error',
    param: null,
    code: 'internal_server_error'
  },
  id: 'chatcmpl-b933704f-4f9a-93c9-bb8e-be1f73dbc15b',
  request_id: 'b933704f-4f9a-93c9-bb8e-be1f73dbc15b'
}

function sseBody(chunks: unknown[]) {
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** What the real DashScope provider hands the SDK for an error chunk. */
async function dashscopeErrorPart(errorChunk: unknown = DASHSCOPE_ERROR_CHUNK) {
  const provider = createAlibaba({
    apiKey: 'test-key',
    baseURL: 'http://dashscope.test/compatible-mode/v1',
    fetch: async () =>
      sseBody([
        {
          id: 'chatcmpl-1',
          created: 1,
          model: 'glm-5.3',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Here is the start, ' }, finish_reason: null }]
        },
        errorChunk
      ])
  })
  const model = provider('glm-5.3') as any
  const { stream } = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  const parts: any[] = []
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts.find((part) => part.type === 'error')
}

describe('the provider’s own words for an error sent as a stream chunk (BL-245)', () => {
  it('reads DashScope’s message out of the chunk the provider could not parse', async () => {
    const errorPart = await dashscopeErrorPart()
    expect(errorPart).toBeDefined()
    // What the chat used to say: the parse failure around the provider's sentence.
    expect(String(errorPart.error?.message)).toContain('Type validation failed')

    const providerError = providerStreamErrorFrom(errorPart.error)
    expect(providerError).toBeInstanceOf(ProviderStreamError)
    expect(providerError?.message).toBe(
      '<50004> InternalError.Algo.InternalPostprocessError: Internal Error during model post-process.'
    )
    expect(providerError?.providerCode).toBe('internal_server_error')
    expect(providerError?.cause).toBe(errorPart.error)
    expect(isContextExhaustedStreamFailure(providerError)).toBe(false)
  })

  it('has nothing to say about an ordinary error', () => {
    expect(providerStreamErrorFrom(new Error('socket hang up'))).toBeNull()
    expect(providerStreamErrorFrom('boom')).toBeNull()
    expect(providerStreamErrorFrom(null)).toBeNull()
    expect(providerStreamErrorFrom({ value: { error: { message: '   ' } } })).toBeNull()
    expect(providerStreamErrorFrom({ value: { choices: [] } })).toBeNull()
  })

  it('keeps the provider’s code for the context check: a full context in the code alone still continues (review finding 3)', async () => {
    // The whole chunk used to reach the classifier inside the parse error, code included; the
    // provider's sentence alone says nothing it knows.
    const errorPart = await dashscopeErrorPart({
      error: { message: 'Request rejected.', type: 'invalid_request_error', param: null, code: 'context_length_exceeded' },
      id: 'chatcmpl-2'
    })
    const providerError = providerStreamErrorFrom(errorPart.error)
    expect(providerError?.message).toBe('Request rejected.')
    expect(providerError?.providerCode).toBe('context_length_exceeded')
    expect(isContextExhaustedStreamFailure(providerError)).toBe(true)
  })

  it('still reads a full context from the sentence, and never from an ordinary error’s code', () => {
    expect(isContextExhaustedStreamFailure(new Error("This model's maximum context length is 131072 tokens."))).toBe(true)
    expect(isContextExhaustedStreamFailure(new ProviderStreamError('Busy, try again.', 'server_busy', null))).toBe(false)
    const coded = Object.assign(new Error('Busy, try again.'), { code: 'context_length_exceeded' })
    expect(isContextExhaustedStreamFailure(coded)).toBe(false)
  })
})

describe('the model calls of a reply that failed mid-stream (BL-245)', () => {
  const firstCallUsage = {
    inputTokens: 1201,
    outputTokens: 21,
    totalTokens: 1222,
    inputTokenDetails: { noCacheTokens: 1201, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 21, reasoningTokens: 0 }
  }
  const failedRun = [
    { type: 'start-step', request: { body: { model: 'glm-5.3', messages: [{ role: 'user', content: 'Read the logs.' }] } }, warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', text: 'Reading the logs. ' },
    { type: 'tool-call', toolCallId: 'call_1', toolName: 'native_bash_execute', input: { command: 'cat app.log' } },
    { type: 'tool-result', toolCallId: 'call_1', toolName: 'native_bash_execute', output: { stdout: '…' } },
    {
      type: 'finish-step',
      finishReason: 'tool-calls',
      usage: firstCallUsage,
      response: { id: 'chatcmpl-1', modelId: 'glm-5.3', timestamp: new Date('2026-09-24T10:00:00Z') },
      providerMetadata: undefined
    },
    { type: 'start-step', request: { body: { model: 'glm-5.3', messages: ['…', 'the tool result'] } }, warnings: [] },
    { type: 'text-delta', id: 't2', text: 'The logs show ' },
    { type: 'error', error: new Error('provider error') }
  ]

  it('keeps every call the stream began: the finished one exact, the failed one with its usage unknown', () => {
    const recorder = createStreamStepRecorder()
    for (const part of failedRun) recorder.observe(part)
    const steps = recorder.steps('error')

    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ finished: true, finishReason: 'tool-calls', usage: firstCallUsage })
    expect(steps[0].toolCalls).toEqual([{ toolCallId: 'call_1', toolName: 'native_bash_execute', input: { command: 'cat app.log' } }])
    expect(steps[1]).toMatchObject({ finished: false, finishReason: 'error', text: 'The logs show ' })
    expect(steps[1].usage).toBeUndefined()

    // Written the way the finish path writes a finished run, with no run total.
    const capture = buildVercelLlmCapture({ steps, totalUsage: null, finalText: 'The logs show ' })
    expect(capture.llmCalls).toHaveLength(2)
    expect(capture.llmCalls[0].usage.inputTokens.value).toBe(1201)
    expect(capture.llmCalls[0].requestPayload).toMatchObject({ model: 'glm-5.3' })
    expect(capture.llmCalls[0].responsePayload).toMatchObject({ toolCalls: [{ name: 'native_bash_execute' }] })
    // Missing usage reads unknown, never zero.
    expect(capture.llmCalls[1].usage.inputTokens.value).toBeNull()
    expect(capture.llmCalls[1].usage.outputTokens.value).toBeNull()
    expect(capture.llmCalls[1].finishReason).toBe('error')
    expect(capture.llmCalls[1].requestPayload).toMatchObject({ model: 'glm-5.3' })
    expect(capture.llmSummary.callsCount.value).toBe(2)
    expect(capture.llmSummary.totalUsage.inputTokens.value).toBeNull()
  })

  it('marks a call a Stop cut the same way, and records nothing for a stream that began no call', () => {
    const stopped = createStreamStepRecorder()
    stopped.observe({ type: 'start-step', request: { body: { model: 'm' } } })
    stopped.observe({ type: 'text-delta', text: 'Half' })
    expect(stopped.steps('interrupted')).toMatchObject([{ finished: false, finishReason: 'interrupted', text: 'Half' }])

    expect(createStreamStepRecorder().steps('error')).toEqual([])
  })

  it('is not changed by what it hands out', () => {
    const recorder = createStreamStepRecorder()
    for (const part of failedRun) recorder.observe(part)
    recorder.steps('error')[0].toolCalls.push({ toolName: 'x' })
    expect(recorder.steps('error')[0].toolCalls).toHaveLength(1)
  })
})
