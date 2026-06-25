import { describe, expect, it } from 'vitest'
import {
  buildClaudeLlmCapture,
  buildCodexLlmCapture,
  buildVercelLlmCapture,
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
