import { describe, expect, it } from 'vitest'
import { buildVercelLlmCapture } from '../executionViewerLlmCapture'
import { summarizeContextUsage } from '$lib/utils/tokenPanel'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'

describe('executionViewerLlmCapture redaction', () => {
  it('redacts data image URLs in Vercel capture payloads', () => {
    const rawBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
    const steps = [
      {
        request: {
          body: {
            messages: [
              {
                role: 'user',
                content: `Look: data:image/png;base64,${rawBase64}`,
              },
            ],
          },
        },
        response: {
          id: 'resp-1',
          modelId: 'test-model',
          timestamp: new Date().toISOString(),
          headers: {},
          messages: [
            {
              role: 'assistant',
              content: `Echo data:image/png;base64,${rawBase64}`,
            },
          ],
          body: {
            image: {
              base64: rawBase64,
            },
          },
        },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      },
    ]

    const capture = buildVercelLlmCapture({
      steps,
      totalUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      finalText: 'done',
    })

    const serialized = JSON.stringify(capture)
    expect(serialized).toContain('redacted image/png data URL')
    expect(serialized).not.toContain(rawBase64)
  })

  // SA-105 P1 (DL-105-12). In-turn images ride AI SDK 7 `file` parts, whose
  // base64 has no `data:image/` prefix and sits under a plain `data` key — so
  // neither the data-URL regex nor the base64 key heuristic above catches it.
  // Without a structural rule every recall or screenshot turn would write
  // megabytes of base64 into the execution log and the forensics records.
  it('redacts tool-result image file parts in Vercel capture payloads', () => {
    const rawBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
    const capture = buildVercelLlmCapture({
      steps: [
        {
          request: {
            body: {
              messages: [
                {
                  role: 'tool',
                  content: [
                    {
                      type: 'tool-result',
                      toolName: 'batshit_tool_use',
                      output: {
                        type: 'content',
                        value: [
                          { type: 'text', text: 'Recalled photo.' },
                          {
                            type: 'file',
                            mediaType: 'image/png',
                            data: { type: 'data', data: rawBase64 },
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
          response: { id: 'r', modelId: 'm', timestamp: new Date().toISOString(), headers: {} },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finalText: 'done',
    })

    const serialized = JSON.stringify(capture)
    expect(serialized).not.toContain(rawBase64)
    expect(serialized).toContain('redacted image/png bytes')
    // The surrounding structure must survive so the record stays readable.
    expect(serialized).toContain('Recalled photo.')
    expect(serialized).toContain('batshit_tool_use')
  })

  it('redacts marked synthetic user image parts in Vercel capture payloads', () => {
    const rawBase64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5'
    const capture = buildVercelLlmCapture({
      steps: [
        {
          request: {
            body: {
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: '[batshit:ephemeral-images] Images returned by sys.memory.recall:' },
                    { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: rawBase64 } },
                  ],
                },
              ],
            },
          },
          response: { id: 'r', modelId: 'm', timestamp: new Date().toISOString(), headers: {} },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finalText: 'done',
    })

    const serialized = JSON.stringify(capture)
    expect(serialized).not.toContain(rawBase64)
    expect(serialized).toContain('redacted image/jpeg bytes')
  })

  it('redacts provider thought signatures from captured Vercel payloads', () => {
    const thoughtSignature = 'opaque-google-signature'.repeat(200)
    const capture = buildVercelLlmCapture({
      steps: [
        {
          request: {
            body: {
              messages: [
                {
                  role: 'assistant',
                  content: [
                    {
                      type: 'text',
                      providerOptions: {
                        google: {
                          thoughtSignature,
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
          response: {
            id: 'resp-1',
            modelId: 'gemini-test',
            timestamp: new Date().toISOString(),
            headers: {},
            messages: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'text',
                    providerOptions: {
                      google: {
                        thoughtSignature,
                      },
                    },
                  },
                ],
              },
            ],
          },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
        },
      ],
      totalUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      finalText: 'done',
    })

    const serialized = JSON.stringify(capture)
    expect(serialized).toContain('redacted provider thought signature')
    expect(serialized).not.toContain(thoughtSignature)
  })

  it('normalizes AI SDK v6 cache counters in Vercel capture usage', () => {
    const capture = buildVercelLlmCapture({
      steps: [
        {
          usage: {
            inputTokens: {
              total: 100,
              noCache: 60,
              cacheRead: 40,
              cacheWrite: 10,
            },
            outputTokens: {
              total: 12,
              text: 9,
              reasoning: 3,
            },
          },
        },
      ],
      totalUsage: {
        inputTokens: {
          total: 100,
          noCache: 60,
          cacheRead: 40,
          cacheWrite: 10,
        },
        outputTokens: {
          total: 12,
          text: 9,
          reasoning: 3,
        },
      } as any,
      finalText: 'done',
    })

    expect(capture.llmSummary.totalUsage.inputTokens.value).toBe(100)
    expect(capture.llmSummary.totalUsage.outputTokens.value).toBe(12)
    expect(capture.llmSummary.totalUsage.cachedInputTokens?.value).toBe(40)
    expect(capture.llmSummary.totalUsage.cacheCreationInputTokens?.value).toBe(
      10,
    )
    expect(capture.llmSummary.totalUsage.reasoningTokens?.value).toBe(3)
    expect(capture.llmCalls[0]?.usage.cachedInputTokens?.value).toBe(40)
  })

  it('normalizes OpenRouter providerMetadata cache usage in Vercel capture steps', () => {
    const capture = buildVercelLlmCapture({
      steps: [
        {
          providerMetadata: {
            openrouter: {
              usage: {
                promptTokens: 200,
                promptTokensDetails: {
                  cachedTokens: 120,
                  cacheWriteTokens: 30,
                },
                completionTokens: 20,
                completionTokensDetails: {
                  reasoningTokens: 5,
                },
                totalTokens: 220,
              },
            },
          },
        },
      ],
      totalUsage: null,
      finalText: 'done',
    })

    expect(capture.llmCalls[0]?.usage.inputTokens.value).toBe(200)
    expect(capture.llmCalls[0]?.usage.outputTokens.value).toBe(20)
    expect(capture.llmCalls[0]?.usage.cachedInputTokens?.value).toBe(120)
    expect(capture.llmCalls[0]?.usage.cacheCreationInputTokens?.value).toBe(30)
    expect(capture.llmCalls[0]?.usage.reasoningTokens?.value).toBe(5)
  })
})

describe('Vercel capture local cache provenance', () => {
  it.each(['sglang', 'vllm', 'lmstudio'])('uses raw per-call counts for %s', (providerId) => {
    const rawUsages = [
      undefined,
      { prompt_tokens_details: null },
      { prompt_tokens_details: { cached_tokens: 0 } },
      { prompt_tokens_details: { cached_tokens: 64 } },
    ]
    const capture = buildVercelLlmCapture({
      providerId,
      steps: rawUsages.map((raw) => ({
        usage: {
          inputTokens: 100, outputTokens: 5,
          inputTokenDetails: { cacheReadTokens: 0 }, raw,
        },
      })),
      totalUsage: { inputTokens: 400, outputTokens: 20, cachedInputTokens: 64 },
    })

    expect(capture.llmCalls.map((call) => call.usage.cachedInputTokens?.value))
      .toEqual([undefined, undefined, 0, 64])
    expect(capture.llmCalls.map((call) => call.usage.inputTokens.value))
      .toEqual([100, 100, 100, 100])
    expect(capture.llmSummary.totalUsage.inputTokens.value).toBe(400)
    expect(capture.llmSummary.totalUsage.cachedInputTokens).toBeUndefined()
  })

  it('totals cache counts only when every local call reports them', () => {
    const capture = buildVercelLlmCapture({
      providerId: 'vllm',
      steps: [0, 64].map((cached) => ({
        usage: {
          inputTokens: 100, outputTokens: 5, cachedInputTokens: 0,
          raw: { prompt_tokens_details: { cached_tokens: cached } },
        },
      })),
      totalUsage: { inputTokens: 200, outputTokens: 10, cachedInputTokens: 0 },
    })
    expect(capture.llmSummary.totalUsage.cachedInputTokens?.value).toBe(64)
    expect(capture.llmSummary.totalUsage.inputTokens.value).toBe(200)
  })

  it('does not manufacture a local cache count from a single-call total fallback', () => {
    const capture = buildVercelLlmCapture({
      providerId: 'sglang',
      steps: [{}],
      totalUsage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 0 },
    })
    expect(capture.llmCalls[0].usage.inputTokens.value).toBe(100)
    expect(capture.llmCalls[0].usage.cachedInputTokens).toBeUndefined()
    expect(capture.llmSummary.totalUsage.cachedInputTokens).toBeUndefined()
  })

  it('preserves cloud capture behavior when a provider identity is supplied', () => {
    const params = {
      steps: [{ usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 0 } }],
      totalUsage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 0 },
    }
    expect(buildVercelLlmCapture({ ...params, providerId: 'openai' }))
      .toEqual(buildVercelLlmCapture(params))
  })
})

/**
 * BL-77: once the tool loop is cached, most of each Anthropic call is READ from or WRITTEN to
 * the cache. Anthropic's raw per-call usage (`providerMetadata.anthropic.usage`) counts only
 * the fresh remainder in `input_tokens`, and that raw number used to override the SDK's
 * whole-prompt count on every call row. The Token Panel meter reads the largest call's input
 * as the context size, so it would have shown a few hundred tokens for a 30,000-token prompt.
 * Shapes below are the real ones from the 2026-09-22 baseline run.
 */
describe('BL-77 per-call input counts the whole prompt on Anthropic accounting', () => {
  const anthropicStep = (fresh: number, read: number, written: number, output: number) => ({
    usage: {
      inputTokens: fresh + read + written,
      inputTokenDetails: { noCacheTokens: fresh, cacheReadTokens: read, cacheWriteTokens: written },
      outputTokens: output,
      outputTokenDetails: { textTokens: output, reasoningTokens: 0 },
      totalTokens: fresh + read + written + output,
    },
    providerMetadata: {
      anthropic: {
        usage: {
          input_tokens: fresh,
          cache_creation_input_tokens: written,
          cache_read_input_tokens: read,
          output_tokens: output,
        },
      },
    },
  })

  it('reports fresh + cache read + cache write as the call input, with the cache split beside it', () => {
    const capture = buildVercelLlmCapture({
      steps: [anthropicStep(12551, 9852, 0, 248)],
      totalUsage: null,
      finalText: 'done',
    })

    const usage = capture.llmCalls[0]!.usage
    expect(usage.inputTokens.value).toBe(22403)
    expect(usage.cachedInputTokens?.value).toBe(9852)
    expect(usage.cacheCreationInputTokens?.value).toBe(0)
    expect(usage.outputTokens.value).toBe(248)
    expect(usage.totalTokens.value).toBe(22651)
  })

  it('does the same when only the raw provider metadata reports usage', () => {
    const step = anthropicStep(2, 22403, 9439, 1543)
    const capture = buildVercelLlmCapture({
      steps: [{ providerMetadata: step.providerMetadata }],
      totalUsage: null,
      finalText: 'done',
    })

    const usage = capture.llmCalls[0]!.usage
    expect(usage.inputTokens.value).toBe(31844)
    expect(usage.cachedInputTokens?.value).toBe(22403)
    expect(usage.cacheCreationInputTokens?.value).toBe(9439)
    expect(usage.totalTokens.value).toBe(31844 + 1543)
  })

  it('does the same for a Vercel AI Gateway Claude call, whose own step usage is exclusive too', () => {
    // SA-107's live gateway shape: the SDK usage keeps the fresh remainder as its input and
    // reports the cache beside it, and the raw Anthropic usage rides providerMetadata.
    const capture = buildVercelLlmCapture({
      steps: [
        {
          usage: {
            inputTokens: 3,
            inputTokenDetails: { cacheReadTokens: 5117, cacheWriteTokens: 13996 },
            outputTokens: 553,
          },
          providerMetadata: {
            gateway: { routing: { finalProvider: 'anthropic' } },
            anthropic: {
              usage: {
                input_tokens: 3,
                output_tokens: 553,
                cache_read_input_tokens: 5117,
                cache_creation_input_tokens: 13996,
              },
            },
          },
        },
      ],
      totalUsage: null,
      finalText: 'done',
    })

    const usage = capture.llmCalls[0]!.usage
    expect(usage.inputTokens.value).toBe(3 + 5117 + 13996)
    expect(usage.cachedInputTokens?.value).toBe(5117)
    expect(usage.cacheCreationInputTokens?.value).toBe(13996)
  })

  it('keeps the Token Panel meter on the largest whole prompt once the tool loop is cached', () => {
    // A cached three-step loop: step one reads the system prompt, steps two and three read the
    // previous step and write only what it added, so their fresh remainder is tiny.
    const capture = buildVercelLlmCapture({
      steps: [
        anthropicStep(1390, 9852, 0, 102),
        anthropicStep(2, 9852, 12549, 248),
        anthropicStep(2, 22403, 9439, 1543),
      ],
      totalUsage: {
        inputTokens: 11242 + 22403 + 31844,
        inputTokenDetails: { noCacheTokens: 1394, cacheReadTokens: 42107, cacheWriteTokens: 21988 },
        outputTokens: 1893,
        totalTokens: 11242 + 22403 + 31844 + 1893,
      } as any,
      finalText: 'done',
    })
    const snapshot = {
      id: 'snap-bl77',
      sessionId: 'sess-bl77',
      userId: 'user-1',
      agentId: 'agent-1',
      agentName: 'Probe',
      createdAt: '2026-09-22T12:00:00.000Z',
      structuredInput: {},
      runtime: {
        runtimeId: 'vercel',
        providerId: 'anthropic',
        connectionId: 'direct:anthropic',
        modelName: 'claude-sonnet-5',
        transport: 'vercel-sdk',
        status: 'succeeded',
      },
      llmSummary: capture.llmSummary,
      llmCalls: capture.llmCalls,
    } as unknown as ExecutionSnapshot

    const summary = summarizeContextUsage({
      messages: [],
      snapshots: [snapshot],
      activeModel: null,
      agent: null,
    })

    expect(summary.displayTokens).toBe(31844)
    expect(summary.label).toBe('32K peak call')
  })
})
