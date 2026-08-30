/**
 * SA-098 AI SDK contract suite — REAL installed `ai` package, no global mock.
 *
 * Purpose (DL-098-04 / DL-098-15): pin the installed AI SDK 7 behaviors Batshit's
 * runtime depends on, so SDK drift is caught by `npm test` instead of surfacing as
 * silent runtime changes hidden behind the global vitest mock. This suite began as
 * the AI SDK 6 baseline (P1) and was migrated to the v7 contract in the same
 * commit as the dependency flip (P2); every semantic the migration changed
 * (usage aggregation, request-body defaults, system-in-messages rejection,
 * call-level toolApproval, the z.record fix, finish-reason execution hardening)
 * is pinned here in its v7 form.
 *
 * The suite needs no Redis and no network: model behavior uses the SDK's own
 * MockLanguageModelV4, and provider wire-shape pins use an injected fetch that
 * captures the outgoing request and then fails the call.
 */
import { describe, expect, it, vi } from 'vitest'

vi.unmock('ai')
vi.unmock('@ai-sdk/anthropic')
vi.unmock('@ai-sdk/openai')
vi.unmock('@ai-sdk/google')
vi.unmock('@ai-sdk/deepinfra')
vi.unmock('@openrouter/ai-sdk-provider')

import {
  Output,
  asSchema,
  generateSpeech,
  transcribe,
  extractReasoningMiddleware,
  generateText,
  jsonSchema,
  isStepCount,
  streamText,
  tool,
  wrapLanguageModel
} from 'ai'
import {
  MockLanguageModelV4,
  MockSpeechModelV4,
  MockTranscriptionModelV4,
  convertArrayToReadableStream
} from 'ai/test'
import { z } from 'zod'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createDeepInfra } from '@ai-sdk/deepinfra'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { applyApiPromptCachePolicy } from '$lib/server/services/apiPromptCachePolicy'
import { normalizeUsageLike } from '$lib/server/services/apiProviderUsage'

const STEP_ONE_USAGE = {
  inputTokens: { total: 100, noCache: 60, cacheRead: 30, cacheWrite: 10 },
  outputTokens: { total: 20, text: 15, reasoning: 5 }
}

const STEP_TWO_USAGE = {
  inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 }
}

function finishChunk(usage: typeof STEP_ONE_USAGE, finishReason: string = 'stop') {
  // Spec V4 finish reasons are `{ unified, raw }` objects (v3 used bare strings).
  return {
    type: 'finish' as const,
    finishReason: { unified: finishReason, raw: finishReason } as any,
    usage
  }
}

function textStreamChunks(text: string, usage = STEP_TWO_USAGE) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'response-metadata' as const, id: 'resp-text', modelId: 'mock-model' },
    { type: 'text-start' as const, id: 't1' },
    { type: 'text-delta' as const, id: 't1', delta: text },
    { type: 'text-end' as const, id: 't1' },
    finishChunk(usage)
  ]
}

function buildToolFlowModel() {
  let call = 0
  return new MockLanguageModelV4({
    doStream: async () => {
      call++
      if (call === 1) {
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start' as const, warnings: [] },
            { type: 'response-metadata' as const, id: 'resp-1', modelId: 'mock-model' },
            {
              type: 'tool-call' as const,
              toolCallId: 'call-1',
              toolName: 'echo',
              input: JSON.stringify({ value: 'hi' })
            },
            // v7 hardening (7.0.70): tools are only auto-executed when the step
            // finishes with a proper 'tool-calls' reason — see the dedicated pin.
            finishChunk(STEP_ONE_USAGE, 'tool-calls')
          ]),
          request: { body: { probe: 'request-body-step-1' } }
        }
      }
      return {
        stream: convertArrayToReadableStream(textStreamChunks('done')),
        request: { body: { probe: 'request-body-step-2' } }
      }
    }
  })
}

function runToolFlow(options: { includeRequestBody?: boolean } = {}) {
  return streamText({
    model: buildToolFlowModel(),
    // Batshit's compiled payload always leads with a server-compiled system-role
    // message; v7 rejects that by default, so the runtime (and this pin) relaxes
    // the guard deliberately (SA-098 D1 — see the rejection pin below).
    allowSystemInMessages: true,
    messages: [
      { role: 'system', content: 'You are a probe.' },
      { role: 'user', content: 'run the tool' }
    ],
    tools: {
      echo: tool({
        description: 'echo',
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }: { value: string }) => ({ echoed: value })
      })
    },
    stopWhen: isStepCount(3),
    ...(options.includeRequestBody ? { include: { requestBody: true } } : {})
  })
}

describe('AI SDK contract (real installed package)', () => {
  it('streams the part sequence and field names the send loop consumes (result.stream)', async () => {
    const result = runToolFlow()

    const parts: Array<{ type: string; part: any }> = []
    for await (const part of result.stream) {
      parts.push({ type: part.type, part })
    }

    expect(parts.map((entry) => entry.type)).toEqual([
      'start',
      'start-step',
      'tool-call',
      'tool-result',
      'finish-step',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish'
    ])

    const textDelta = parts.find((entry) => entry.type === 'text-delta')!.part
    expect(textDelta.text).toBe('done')
    expect(textDelta).not.toHaveProperty('textDelta')

    const toolCall = parts.find((entry) => entry.type === 'tool-call')!.part
    expect(toolCall.toolCallId).toBe('call-1')
    expect(toolCall.toolName).toBe('echo')
    expect(toolCall.input).toEqual({ value: 'hi' })
    expect(toolCall).not.toHaveProperty('args')

    const toolResult = parts.find((entry) => entry.type === 'tool-result')!.part
    expect(toolResult.input).toEqual({ value: 'hi' })
    expect(toolResult.output).toEqual({ echoed: 'hi' })
    expect(toolResult).not.toHaveProperty('result')

    // The v7 finish part still carries ONLY totalUsage (send-routed's
    // `finishChunk.totalUsage || finishChunk.usage` chain stays valid).
    const finish = parts.find((entry) => entry.type === 'finish')!.part
    expect(finish.totalUsage).toBeDefined()
    expect(finish).not.toHaveProperty('usage')
    expect(finish.totalUsage.inputTokens).toBe(140)

    // The deprecated fullStream alias still exists — Batshit reads `stream`, but
    // the alias keeps any missed reader loud in review rather than silent.
    expect((result as any).fullStream).toBeDefined()
  })

  it('pins v7 usage semantics: result.usage = AGGREGATE, finalStep.usage = last step, flat detail duplicates removed', async () => {
    const result = runToolFlow()
    for await (const part of result.stream) void part

    const usage = await result.usage
    const totalUsage = await (result as any).totalUsage
    const finalStep = await result.finalStep

    // v7 flip: `usage` now aggregates all steps (what v6 called totalUsage).
    expect(usage.inputTokens).toBe(140)
    expect(usage.outputTokens).toBe(28)
    expect(totalUsage.inputTokens).toBe(140)
    // Last-step numbers moved to finalStep.usage.
    expect(finalStep.usage.inputTokens).toBe(40)
    expect(finalStep.usage.outputTokens).toBe(8)

    // The legacy flat duplicates are REMOVED in v7 — only the detail objects remain.
    expect(usage).not.toHaveProperty('cachedInputTokens')
    expect(usage).not.toHaveProperty('reasoningTokens')
    expect(usage.inputTokenDetails).toEqual({
      noCacheTokens: 100,
      cacheReadTokens: 30,
      cacheWriteTokens: 10
    })
    expect(usage.outputTokenDetails).toEqual({ textTokens: 23, reasoningTokens: 5 })

    // Batshit's normalizer resolves cache/reasoning evidence from the v7 detail
    // objects (Execution Viewer + Token Panel depend on this).
    const normalized = normalizeUsageLike(usage)
    expect(normalized?.inputTokens).toBe(140)
    expect(normalized?.cachedInputTokens).toBe(30)
    expect(normalized?.reasoningTokens).toBe(5)
    expect(normalized?.cacheCreationInputTokens).toBe(10)
  })

  it('pins v7 result-shape defaults: request bodies EXCLUDED unless include.requestBody', async () => {
    const withoutInclude = runToolFlow()
    for await (const part of withoutInclude.stream) void part
    const bareSteps = await withoutInclude.steps
    // v7 drops request bodies by default — Execution Viewer evidence requires the
    // include flag Batshit now passes (SA-098 D3).
    expect(bareSteps[0]?.request?.body).toBeUndefined()

    const withInclude = runToolFlow({ includeRequestBody: true })
    for await (const part of withInclude.stream) void part
    const steps = await withInclude.steps
    expect(steps).toHaveLength(2)
    expect(steps[0]?.request?.body).toEqual({ probe: 'request-body-step-1' })

    // v7: `result.response` is a deprecated alias of finalStep.response and its
    // messages are FINAL STEP ONLY (v6 accumulated all steps here). The full
    // history moved to `result.responseMessages` — which is why Batshit's
    // providerMessages persistence reads responseMessages, never response.messages.
    const response = await withInclude.response
    expect((response?.messages ?? []).map((message: any) => message.role)).toEqual(['assistant'])
    const responseMessages = await (withInclude as any).responseMessages
    expect((responseMessages ?? []).map((message: any) => message.role)).toEqual([
      'assistant',
      'tool',
      'assistant'
    ])
    expect(await withInclude.text).toBe('done')
  })

  it('pins v7 system-in-messages rejection without allowSystemInMessages', async () => {
    await expect(
      generateText({
        model: new MockLanguageModelV4({
          doStream: async () => ({ stream: convertArrayToReadableStream(textStreamChunks('x')) })
        }),
        messages: [
          { role: 'system', content: 'S' },
          { role: 'user', content: 'u' }
        ]
      })
    ).rejects.toThrow(/System messages are not allowed/)
  })

  it('pins tool execution tolerance: a tool call on a "stop"-finished step still executes', async () => {
    // Matches v6 behavior (relevant for Local AI runtimes with sloppy finish
    // reasons). The 7.0.70 "unsafe finish reason" hardening targets reasons like
    // content-filter/error, not 'stop'.
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          {
            type: 'tool-call' as const,
            toolCallId: 'call-1',
            toolName: 'echo',
            input: JSON.stringify({ value: 'hi' })
          },
          finishChunk(STEP_ONE_USAGE, 'stop')
        ])
      })
    })

    const result = streamText({
      model,
      prompt: 'x',
      tools: {
        echo: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: async () => 'ok'
        })
      },
      stopWhen: isStepCount(3)
    })

    const types: string[] = []
    for await (const part of result.stream) types.push(part.type)
    expect(types).toContain('tool-call')
    expect(types).toContain('tool-result')
  })

  it('pins the v7 call-level toolApproval contract', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call++
        if (call === 1) {
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start' as const, warnings: [] },
              {
                type: 'tool-call' as const,
                toolCallId: 'call-9',
                toolName: 'guarded',
                input: JSON.stringify({ x: 1 })
              },
              finishChunk(STEP_ONE_USAGE, 'tool-calls')
            ])
          }
        }
        return { stream: convertArrayToReadableStream(textStreamChunks('after')) }
      }
    })

    const result = streamText({
      model,
      prompt: 'go',
      tools: {
        guarded: tool({
          description: 'guarded',
          inputSchema: z.object({ x: z.number() }),
          execute: async () => 'ran'
        })
      },
      // v7 replaces tool-level needsApproval with this call-level setting —
      // Batshit builds this map from its toolApprovalMode policies (SA-098 D4).
      toolApproval: { guarded: 'user-approval' },
      stopWhen: isStepCount(3)
    })

    const partTypes: string[] = []
    let approvalPart: any = null
    for await (const part of result.stream) {
      partTypes.push(part.type)
      if (part.type === 'tool-approval-request') approvalPart = part
    }

    expect(partTypes).toContain('tool-approval-request')
    // send-routed reads approvalId + the embedded toolCall object from this part
    // and persists both into metadata.toolApprovals.
    expect(typeof approvalPart.approvalId).toBe('string')
    expect(approvalPart.toolCall?.toolCallId).toBe('call-9')
    expect(approvalPart.toolCall?.toolName).toBe('guarded')

    const response = await result.response
    const assistantParts = (response?.messages ?? [])
      .filter((message: any) => message.role === 'assistant')
      .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
      .map((part: any) => part.type)
    expect(assistantParts).toContain('tool-approval-request')
  })

  it('pins the v7 z.record → JSON schema conversion (upstream #17871 FIXED in 7.0.77)', () => {
    const recordSchema = asSchema(z.record(z.string(), z.number())).jsonSchema as Record<
      string,
      any
    >
    // Fixed by @ai-sdk/provider-utils 5.0.29: the record VALUE schema survives.
    // (The v6 baseline pinned the broken `additionalProperties: false`.)
    expect(recordSchema.type).toBe('object')
    expect(recordSchema.additionalProperties).toEqual({ type: 'number' })
  })

  it('pins the Anthropic wire shape on v7: system[] + cache_control survive allowSystemInMessages (D1 proof)', async () => {
    const policy = applyApiPromptCachePolicy({
      modelId: 'claude-sonnet-4-5-latest',
      providerId: 'anthropic',
      connection: { type: 'direct', service: 'anthropic', id: 'direct:anthropic' } as any,
      sessionId: 'baseline-session',
      agentId: 'baseline-agent',
      userId: 'baseline-user',
      messages: [
        { role: 'system', content: 'Stable system prompt.' },
        { role: 'user', content: 'hello' }
      ],
      tools: undefined,
      providerOptions: undefined
    })
    expect(policy.metadata.applied).toContain('anthropic.cacheControl')

    let captured: { url: string; body: any } | null = null
    const anthropic = createAnthropic({
      apiKey: 'test-key',
      fetch: (async (url: any, init: any) => {
        captured = { url: String(url), body: JSON.parse(init.body) }
        return new Response(
          JSON.stringify({ error: { type: 'probe_stop', message: 'wire captured' } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      }) as any
    })

    await expect(
      generateText({
        model: anthropic('claude-sonnet-4-5-latest'),
        messages: policy.messages as any,
        allowSystemInMessages: true,
        providerOptions: policy.providerOptions as any
      })
    ).rejects.toThrow()

    // Byte-parity with the v6 baseline: the system-role message becomes the
    // top-level `system` array and Batshit's message-level cacheControl survives
    // to the wire as cache_control (DL-098-08 preserved).
    expect(captured!.body.system).toEqual([
      {
        type: 'text',
        text: 'Stable system prompt.',
        cache_control: { type: 'ephemeral' }
      }
    ])
    expect(captured!.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] }
    ])
  })

  it('pins the OpenAI (responses lane) and OpenRouter (chat lane) wire request shapes', async () => {
    const capturedUrls: string[] = []
    let openaiBody: any = null
    const openai = createOpenAI({
      apiKey: 'test-key',
      fetch: (async (url: any, init: any) => {
        capturedUrls.push(String(url))
        openaiBody = JSON.parse(init.body)
        return new Response(JSON.stringify({ error: { message: 'wire captured' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      }) as any
    })

    await expect(
      generateText({
        model: openai('gpt-test'),
        allowSystemInMessages: true,
        messages: [
          { role: 'system', content: 'Stable system prompt.' },
          { role: 'user', content: 'hello' }
        ]
      })
    ).rejects.toThrow()

    expect(capturedUrls[0]).toContain('/responses')
    expect(openaiBody.model).toBe('gpt-test')
    expect(JSON.stringify(openaiBody)).toContain('Stable system prompt.')

    let openrouterBody: any = null
    let openrouterUrl = ''
    const openrouter = createOpenRouter({
      apiKey: 'test-key',
      fetch: (async (url: any, init: any) => {
        openrouterUrl = String(url)
        openrouterBody = JSON.parse(init.body)
        return new Response(JSON.stringify({ error: { message: 'wire captured' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      }) as any
    })

    await expect(
      generateText({
        model: openrouter.chat('test/model'),
        allowSystemInMessages: true,
        messages: [
          { role: 'system', content: 'Stable system prompt.' },
          { role: 'user', content: 'hello' }
        ]
      })
    ).rejects.toThrow()

    expect(openrouterUrl).toContain('/chat/completions')
    expect(openrouterBody.model).toBe('test/model')
    expect(JSON.stringify(openrouterBody.messages[0])).toContain('Stable system prompt.')
    expect(openrouterBody.messages[0].role).toBe('system')
  })

  it('pins DeepInfra to its OpenAI-compatible chat-completions route', async () => {
    let capturedUrl = ''
    let capturedBody: any = null
    const deepInfra = createDeepInfra({
      apiKey: 'test-key',
      fetch: (async (url: any, init: any) => {
        capturedUrl = String(url)
        capturedBody = JSON.parse(init.body)
        return new Response(JSON.stringify({ error: { message: 'wire captured' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      }) as any
    })

    await expect(
      generateText({
        model: deepInfra('zai-org/GLM-5.3-Flash'),
        allowSystemInMessages: true,
        messages: [
          { role: 'system', content: 'Stable system prompt.' },
          { role: 'user', content: 'hello' }
        ]
      })
    ).rejects.toThrow()

    expect(capturedUrl).toBe('https://api.deepinfra.com/v1/openai/chat/completions')
    expect(capturedBody.model).toBe('zai-org/GLM-5.3-Flash')
    expect(capturedBody.messages[0]).toEqual({ role: 'system', content: 'Stable system prompt.' })
  })
})

describe('AI SDK contract — stream part families and feature surfaces', () => {
  it('pins reasoning parts (.text on deltas) and raw chunks under include.rawChunks', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'reasoning-start' as const, id: 'r1' },
          { type: 'reasoning-delta' as const, id: 'r1', delta: 'thinking...' },
          { type: 'reasoning-end' as const, id: 'r1' },
          { type: 'raw' as const, rawValue: { choices: [{ delta: { reasoning_content: 'zz' } }] } },
          { type: 'text-start' as const, id: 't1' },
          { type: 'text-delta' as const, id: 't1', delta: 'answer' },
          { type: 'text-end' as const, id: 't1' },
          finishChunk(STEP_TWO_USAGE)
        ])
      })
    })

    // v7 moves the raw-chunk switch under `include` (v6: top-level includeRawChunks).
    const result = streamText({ model, prompt: 'x', include: { rawChunks: true } })

    const reasoningDeltas: any[] = []
    const rawParts: any[] = []
    for await (const part of result.stream) {
      if (part.type === 'reasoning-delta') reasoningDeltas.push(part)
      if (part.type === 'raw') rawParts.push(part)
    }

    expect(reasoningDeltas).toHaveLength(1)
    expect(reasoningDeltas[0].text).toBe('thinking...')
    expect(rawParts).toHaveLength(1)
    expect(rawParts[0].rawValue).toEqual({ choices: [{ delta: { reasoning_content: 'zz' } }] })
    expect(await result.reasoningText).toBe('thinking...')
  })

  it('pins error-part behavior: stream yields {type:"error", error} without throwing', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 't1' },
          { type: 'text-delta' as const, id: 't1', delta: 'partial' },
          { type: 'error' as const, error: { message: 'provider blew up' } },
          finishChunk(STEP_TWO_USAGE)
        ])
      })
    })

    const result = streamText({ model, prompt: 'x' })
    const errorParts: any[] = []
    // send-routed relies on the loop COMPLETING (not throwing) so it can preserve
    // partial output and surface the error itself (failed-send persistence).
    for await (const part of result.stream) {
      if (part.type === 'error') errorParts.push(part)
    }
    expect(errorParts).toHaveLength(1)
    expect(errorParts[0].error).toEqual({ message: 'provider blew up' })
  })

  it('pins blank tool-call id tolerance (upstream #18440 class): executes without throwing', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'tool-call' as const, toolCallId: '', toolName: 'echo', input: '{"value":"hi"}' },
          finishChunk(STEP_ONE_USAGE, 'tool-calls')
        ])
      })
    })

    const result = streamText({
      model,
      prompt: 'x',
      tools: {
        echo: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: async () => 'ok'
        })
      },
      stopWhen: isStepCount(2)
    })

    const types: string[] = []
    for await (const part of result.stream) types.push(part.type)
    expect(types).toContain('tool-result')
    expect(types).toContain('finish')
  })

  it('pins structured output via streamText + Output.object (artifact object streams)', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 't1' },
          { type: 'text-delta' as const, id: 't1', delta: '{"name":"bat' },
          { type: 'text-delta' as const, id: 't1', delta: 'shit"}' },
          { type: 'text-end' as const, id: 't1' },
          finishChunk(STEP_TWO_USAGE)
        ])
      })
    })

    const result = streamText({
      model,
      prompt: 'x',
      output: Output.object({
        schema: jsonSchema({ type: 'object', properties: { name: { type: 'string' } } })
      })
    })

    const partials: any[] = []
    for await (const partial of result.partialOutputStream) partials.push(partial)
    expect(partials).toEqual([{ name: 'bat' }, { name: 'batshit' }])
    expect(await result.output).toEqual({ name: 'batshit' })
  })

  it('pins wrapLanguageModel + extractReasoningMiddleware on a v4 spec model', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 't1' },
          { type: 'text-delta' as const, id: 't1', delta: '<think>hidden</think>visible' },
          { type: 'text-end' as const, id: 't1' },
          finishChunk(STEP_TWO_USAGE)
        ])
      })
    })

    // vercelBrain's tagged-reasoning gate requires spec 'v4' on the v7 tree.
    expect(model.specificationVersion).toBe('v4')

    const wrapped = wrapLanguageModel({
      model,
      middleware: extractReasoningMiddleware({ tagName: 'think' })
    })
    const result = streamText({ model: wrapped, prompt: 'x' })
    const types: string[] = []
    for await (const part of result.stream) types.push(part.type)

    expect(types).toContain('reasoning-delta')
    expect(await result.text).toBe('visible')
    expect(await result.reasoningText).toBe('hidden')
  })

  it('pins the graduated speech/transcription APIs used by voiceService', async () => {
    const speech = await generateSpeech({
      model: new MockSpeechModelV4({
        doGenerate: async () => ({
          audio: { data: new Uint8Array([1, 2, 3]), format: 'mp3' },
          warnings: [],
          response: { timestamp: new Date(), modelId: 'mock', headers: {} }
        })
      }),
      text: 'hello'
    })
    expect(Object.keys(speech.audio)).toEqual(
      expect.arrayContaining(['base64Data', 'uint8ArrayData', 'mediaType', 'format'])
    )

    const transcript = await transcribe({
      model: new MockTranscriptionModelV4({
        doGenerate: async () => ({
          text: 'hi there',
          segments: [],
          language: 'en',
          durationInSeconds: 1,
          warnings: [],
          response: { timestamp: new Date(), modelId: 'mock', headers: {} }
        })
      }),
      audio: new Uint8Array([1, 2, 3])
    })
    expect(transcript.text).toBe('hi there')
    expect(transcript.durationInSeconds).toBe(1)
  })

  it('pins Gemini and custom-baseURL chat wire shapes (system placement)', async () => {
    let geminiUrl = ''
    let geminiBody: any = null
    const google = createGoogle({
      apiKey: 'test-key',
      fetch: (async (url: any, init: any) => {
        geminiUrl = String(url)
        geminiBody = JSON.parse(init.body)
        return new Response(JSON.stringify({ error: {} }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      }) as any
    })

    await expect(
      generateText({
        model: google('gemini-test'),
        allowSystemInMessages: true,
        messages: [
          { role: 'system', content: 'Stable system prompt.' },
          { role: 'user', content: 'hi' }
        ]
      })
    ).rejects.toThrow()

    expect(geminiUrl).toContain(':generateContent')
    expect(geminiBody.systemInstruction).toEqual({ parts: [{ text: 'Stable system prompt.' }] })

    let compatUrl = ''
    let compatBody: any = null
    const compat = createOpenAI({
      apiKey: 'test-key',
      baseURL: 'http://localhost:9999/v1',
      fetch: (async (url: any, init: any) => {
        compatUrl = String(url)
        compatBody = JSON.parse(init.body)
        return new Response(JSON.stringify({ error: {} }), {
          status: 400,
          headers: { 'content-type': 'application/json' }
        })
      }) as any
    })

    await expect(
      generateText({
        model: compat.chat('local-model'),
        allowSystemInMessages: true,
        messages: [
          { role: 'system', content: 'Stable system prompt.' },
          { role: 'user', content: 'hi' }
        ]
      })
    ).rejects.toThrow()

    expect(compatUrl).toBe('http://localhost:9999/v1/chat/completions')
    expect(compatBody.messages[0]).toEqual({ role: 'system', content: 'Stable system prompt.' })
  })
})
