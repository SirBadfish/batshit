import { describe, expect, it } from 'vitest'
import {
  buildClaudeLlmCapture,
  buildCodexLlmCapture,
  buildVercelLlmCapture,
  sanitizeRuntimeEventLogForCapture,
} from '../executionViewerLlmCapture'

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

  it('redacts data image URLs in Codex capture payloads', () => {
    const rawBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
    const capture = buildCodexLlmCapture({
      developerInstructions: 'Stable developer data:image/png;base64,notreallybase64',
      prompt: `Describe this: data:image/png;base64,${rawBase64}`,
      images: [{ url: `data:image/png;base64,${rawBase64}` }],
      tools: null,
      toolMetadata: null,
      totalUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    })

    const serialized = JSON.stringify(capture)
    expect(capture.llmCalls[0]?.requestConfidence).toBe('near')
    expect(capture.llmCalls[0]?.requestPayload).toMatchObject({
      developerInstructions: expect.stringContaining('Stable developer'),
      prompt: expect.stringContaining('Describe this:'),
    })
    expect(serialized).toContain('redacted image/png data URL')
    expect(serialized).not.toContain(rawBase64)
  })

  it('builds a Claude-specific Mode 4 capture instead of falling back to Vercel metadata', () => {
    const capture = buildClaudeLlmCapture({
      prompt: 'Summarize the repo state.',
      tools: null,
      toolMetadata: null,
      totalUsage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
    })

    expect(capture.llmCalls).toHaveLength(1)
    expect(capture.llmCalls[0]?.runtime).toBe('claude')
    expect(capture.llmSummary.totalUsage.totalTokens.value).toBe(13)
    expect(JSON.stringify(capture)).toContain(
      'Claude Code CLI does not expose a raw provider response object',
    )
  })

  it('preserves Claude cache-read and cache-creation breakdown while showing total processed input', () => {
    const capture = buildClaudeLlmCapture({
      prompt: 'Reply with the cached total.',
      tools: null,
      toolMetadata: null,
      totalUsage: {
        inputTokens: 18987,
        outputTokens: 15,
        totalTokens: 19002,
        cachedInputTokens: 6297,
        cacheCreationInputTokens: 12687,
      },
    })

    expect(capture.llmSummary.totalUsage.inputTokens.value).toBe(18987)
    expect(capture.llmSummary.totalUsage.outputTokens.value).toBe(15)
    expect(capture.llmSummary.totalUsage.totalTokens.value).toBe(19002)
    expect(capture.llmSummary.totalUsage.cachedInputTokens?.value).toBe(6297)
    expect(capture.llmSummary.totalUsage.cacheCreationInputTokens?.value).toBe(
      12687,
    )
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

describe('sanitizeRuntimeEventLogForCapture (SA-105 P3)', () => {
  const rawBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='

  it('redacts MCP image content blocks in the raw CLI transport trace', () => {
    // The exact shape the P3 live probe found sitting in a real execution log:
    // an untouched Codex `item.completed` carrying the delivered recall photo.
    const events = [
      {
        type: 'item.completed',
        item: {
          id: 'call_1',
          type: 'mcp_tool_call',
          tool: 'batshit_tool_use',
          result: {
            content: [
              { type: 'text', text: '{"result":{"recalled":[]}}' },
              { type: 'image', data: rawBase64, mimeType: 'image/png' },
            ],
          },
        },
      },
    ]

    const sanitized = sanitizeRuntimeEventLogForCapture(events)
    const serialized = JSON.stringify(sanitized)

    expect(serialized).not.toContain(rawBase64)
    expect(serialized).toContain('[redacted image/png bytes')
    // Everything else in the trace survives — this is a redaction, not a drop.
    expect(sanitized[0].item.result.content[0]).toEqual({
      type: 'text',
      text: '{"result":{"recalled":[]}}',
    })
    expect(sanitized[0].item.tool).toBe('batshit_tool_use')
  })

  it('does not mutate the live event array it was handed', () => {
    const events = [
      { item: { result: { content: [{ type: 'image', data: rawBase64, mimeType: 'image/png' }] } } },
    ]
    sanitizeRuntimeEventLogForCapture(events)
    expect(events[0].item.result.content[0].data).toBe(rawBase64)
  })

  it('still covers the older shapes any raw event could carry', () => {
    const sanitized = sanitizeRuntimeEventLogForCapture([
      { note: `inline data:image/png;base64,${rawBase64}` },
      { base64: rawBase64 },
    ])
    const serialized = JSON.stringify(sanitized)

    expect(serialized).not.toContain(rawBase64)
    expect(serialized).toContain('[redacted image/png data URL')
    expect(serialized).toContain('[redacted base64 payload')
  })
})
