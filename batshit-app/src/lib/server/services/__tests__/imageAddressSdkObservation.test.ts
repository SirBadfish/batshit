import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ApiImageInputCollector } from '../imageAddressApiInput'
import { decideReplyImageOrigins } from '../imageAddressTurnRecord'

const EXPECTED_AI_SDK_VERSION = '7.0.119'
const installedAiPackage = JSON.parse(
  readFileSync(
    join(process.cwd(), 'node_modules/ai/package.json'),
    'utf8'
  )
) as { version: string }

type ActualAi = typeof import('ai')
type ActualAiTest = typeof import('ai/test')
type ActualProviderUtils = typeof import('@ai-sdk/provider-utils')
type ActualProvider = typeof import('@ai-sdk/provider')

let ai: ActualAi
let aiTest: ActualAiTest
let providerUtils: ActualProviderUtils
let provider: ActualProvider

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 }
}

function finish(finishReason: 'stop' | 'tool-calls' = 'stop') {
  return {
    type: 'finish' as const,
    finishReason: { unified: finishReason, raw: finishReason },
    usage
  }
}

function textChunks(text: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'response-metadata' as const, id: 'response', modelId: 'contract-model' },
    { type: 'text-start' as const, id: 'text-1' },
    { type: 'text-delta' as const, id: 'text-1', delta: text },
    { type: 'text-end' as const, id: 'text-1' },
    finish()
  ]
}

function toolCallChunks(toolCallId: string, value: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'response-metadata' as const, id: `response-${toolCallId}`, modelId: 'contract-model' },
    {
      type: 'tool-call' as const,
      toolCallId,
      toolName: 'echo',
      input: JSON.stringify({ value })
    },
    finish('tool-calls')
  ]
}

function providerRequestProjection(call: any) {
  return JSON.stringify({
    prompt: call.prompt,
    tools: call.tools,
    toolChoice: call.toolChoice,
    providerOptions: call.providerOptions,
    headers: call.headers,
    callSettings: {
      maxOutputTokens: call.maxOutputTokens,
      temperature: call.temperature,
      topP: call.topP,
      topK: call.topK,
      stopSequences: call.stopSequences,
      seed: call.seed
    }
  })
}

async function consumeText(result: any) {
  await result.text
}

beforeAll(async () => {
  // The global Vitest setup intentionally mocks `ai`; importActual pins this file to the
  // installed production SDK implementation without changing that setup for other suites.
  ai = await vi.importActual<ActualAi>('ai')
  aiTest = await vi.importActual<ActualAiTest>('ai/test')
  providerUtils = await vi.importActual<ActualProviderUtils>('@ai-sdk/provider-utils')
  provider = await vi.importActual<ActualProvider>('@ai-sdk/provider')
})

describe('AI SDK 7.0.119 provider-request observation contract', () => {
  it('converts an approved resume into the exact tool result at doStream and the real collector reads it (BL-1024)', async () => {
    expect(installedAiPackage.version).toBe(EXPECTED_AI_SDK_VERSION)
    const read = 'https://approval-result.example/picture.png'
    const argument = 'https://approval-argument.example/not-read.png'
    const resultText = `Fetched ${read}`
    const messages: any[] = [
      { role: 'system', content: 'Server prompt.' },
      { role: 'user', content: 'Find a picture.' },
      {
        role: 'assistant', content: [
          { type: 'tool-call', toolCallId: 'approved-call', toolName: 'lookup', input: { url: argument } },
          { type: 'tool-approval-request', approvalId: 'approved-id', toolCallId: 'approved-call' }
        ]
      },
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'approved-id', approved: true, reason: 'User approved', providerExecuted: false }] }
    ]
    const run = async (observe: boolean) => {
      const collector = new ApiImageInputCollector()
      const providerCalls: any[] = []
      const observed: any[] = []
      const execute = vi.fn(async (_input: any) => resultText)
      const baseModel = new aiTest.MockLanguageModelV4({
        provider: 'contract-test', modelId: 'approved-resume',
        doStream: async (call: any) => {
          providerCalls.push(call)
          return { stream: aiTest.convertArrayToReadableStream(textChunks('done')) }
        }
      })
      const model = ai.wrapLanguageModel({
        model: baseModel,
        middleware: {
          specificationVersion: 'v4',
          wrapStream: async ({ params, doStream }: any) => {
            if (observe) {
              observed.push(params)
              collector.observe({
                compiledMessages: messages, compiledPrefixCount: 2, initialSystem: [messages[0]],
                promptMessages: params.prompt, toolDefinitions: params.tools, userSources: []
              })
            }
            return doStream()
          }
        }
      })
      await consumeText(ai.streamText({
        model, allowSystemInMessages: true, messages,
        tools: {
          lookup: ai.tool({
            description: 'Look up a picture.',
            inputSchema: providerUtils.jsonSchema({ type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false }),
            execute
          })
        }
      }))
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute.mock.calls[0][0]).toEqual({ url: argument })
      expect(providerCalls).toHaveLength(1)
      return { collector, providerCalls, observed }
    }
    const baseline = await run(false)
    const observed = await run(true)
    expect(providerRequestProjection(observed.providerCalls[0])).toBe(providerRequestProjection(baseline.providerCalls[0]))
    expect(observed.observed[0].prompt).toEqual(observed.providerCalls[0].prompt)
    const toolResults = observed.providerCalls[0].prompt
      .filter((message: any) => message.role === 'tool')
      .flatMap((message: any) => message.content)
    expect(toolResults).toEqual([{
      type: 'tool-result', toolCallId: 'approved-call', toolName: 'lookup', output: { type: 'text', value: resultText }
    }])
    expect(observed.collector.compiledObserved).toBe(true)
    expect(observed.collector.run).toMatchObject({ observed: true, unaccountedInputs: 0, nonTextInputs: 0, providerExecutedTools: 0 })
    expect(observed.collector.run.pieces).toContainEqual({ source: 'tool_result', text: resultText })
    const record = decideReplyImageOrigins({
      messageId: 'approved-reply', version: 1, lane: 'api',
      replyTexts: [`<img src="${read}"><img src="${argument}">`],
      compiled: { pieces: [{ source: 'user', text: 'Find a picture.' }], nonTextInputs: 0, unaccountedInputs: 0 },
      run: observed.collector.run, addenda: [], steers: [], storedRecords: {}
    })
    expect(record.complete).toBe(true)
    expect(record.addresses[read]).toMatchObject({ state: 'as_read', rule: 1 })
    expect(record.addresses[argument]).toMatchObject({ state: 'blocked', rule: 4 })
  })

  it('pins SDK version 7.0.119 and shows outer onStepStart follows prepareStep and toolCaller additions', async () => {
    expect(installedAiPackage.version).toBe(EXPECTED_AI_SDK_VERSION)

    const providerCalls: any[] = []
    const observed: any[] = []
    const order: string[] = []
    const localTool = ai.tool({
      description: 'A tool accessible only through the local caller.',
      inputSchema: providerUtils.jsonSchema({ type: 'object', properties: {} })
    })
    const caller = providerUtils.experimental_toolCaller(localTool, {
      type: 'local',
      bind: () => ({ ...localTool, execute: async () => 'unused local caller result' }) as any,
      prepareModelMessage: () => 'SDK local tool caller contribution.'
    })
    const echo = ai.tool({
      description: 'Echo test input.',
      inputSchema: providerUtils.jsonSchema({
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false
      }),
      execute: async () => 'unused echo result'
    })
    const model = new aiTest.MockLanguageModelV4({
      provider: 'contract-test',
      modelId: 'observation-contract',
      doStream: async (call: any) => {
        order.push('doStream')
        providerCalls.push(call)
        return {
          stream: aiTest.convertArrayToReadableStream(textChunks('done')),
          request: { body: { probe: 'read-only-contract' } }
        }
      }
    })

    const result = ai.streamText({
      model,
      allowSystemInMessages: true,
      messages: [
        { role: 'system', content: 'Server compiled system.' },
        { role: 'user', content: 'Original request.' }
      ],
      tools: { caller, echo },
      experimental_toolCallers: { echo: ['caller'] },
      prepareStep: ({ messages }: any) => {
        order.push('prepareStep')
        return {
          messages: [...messages, { role: 'user', content: 'prepareStep injection.' }]
        }
      },
      onStepStart: async (event: any) => {
        order.push('onStepStart')
        observed.push(event.promptMessages)
      }
    })

    await consumeText(result)

    expect(order).toEqual(['prepareStep', 'onStepStart', 'doStream'])
    expect(providerCalls).toHaveLength(1)
    expect(observed).toHaveLength(1)
    expect(Array.isArray(observed[0])).toBe(true)
    expect(observed[0]).toEqual(providerCalls[0].prompt)
    const providerText = JSON.stringify(providerCalls[0].prompt)
    expect(providerText).toContain('prepareStep injection.')
    expect(providerText).toContain('SDK local tool caller contribution.')
  })

  it('pins the installed SDK no-tools shape: stepTools exists as undefined and the provider tools are undefined', async () => {
    const stepEvents: any[] = []
    const dispatchInputs: any[] = []
    const providerCalls: any[] = []
    const baseModel = new aiTest.MockLanguageModelV4({
      provider: 'contract-test',
      modelId: 'no-tools-step',
      doStream: async (call: any) => {
        providerCalls.push(call)
        return {
          stream: aiTest.convertArrayToReadableStream(textChunks('done')),
          request: { body: { noTools: true } }
        }
      }
    })
    const model = ai.wrapLanguageModel({
      model: baseModel,
      middleware: {
        specificationVersion: 'v4',
        wrapStream: async ({ params, doStream }: any) => {
          dispatchInputs.push(params)
          return doStream()
        }
      }
    })
    const result = ai.streamText({
      model,
      allowSystemInMessages: true,
      messages: [{ role: 'system', content: 'System.' }, { role: 'user', content: 'No tools.' }],
      onStepStart: (event: any) => stepEvents.push(event)
    })

    await consumeText(result)

    expect(stepEvents).toHaveLength(1)
    expect(Object.hasOwn(stepEvents[0], 'stepTools')).toBe(true)
    expect(stepEvents[0].stepTools).toBeUndefined()
    expect(dispatchInputs).toHaveLength(1)
    expect(Object.hasOwn(dispatchInputs[0], 'tools')).toBe(true)
    expect(dispatchInputs[0].tools).toBeUndefined()
    expect(providerCalls[0].tools).toBeUndefined()
  })

  it('shows that dynamic tool descriptions differ between outer stepTools and actual dispatch tools', async () => {
    const stepEvents: any[] = []
    const languageCallEvents: any[] = []
    const dispatchInputs: any[] = []
    const providerCalls: any[] = []
    let descriptionEvaluation = 0
    const dynamic = ai.tool({
      description: () => {
        descriptionEvaluation++
        return `Read https://tool-description-${descriptionEvaluation}.example/schema.png`
      },
      inputSchema: providerUtils.jsonSchema({ type: 'object', properties: {} })
    })
    const baseModel = new aiTest.MockLanguageModelV4({
      provider: 'contract-test',
      modelId: 'dynamic-tools-exact-dispatch',
      doStream: async (call: any) => {
        providerCalls.push(call)
        return {
          stream: aiTest.convertArrayToReadableStream(textChunks('done')),
          request: { body: { dynamicDescription: true } }
        }
      }
    })
    const model = ai.wrapLanguageModel({
      model: baseModel,
      middleware: {
        specificationVersion: 'v4',
        wrapStream: async ({ params, doStream }: any) => {
          dispatchInputs.push(params)
          return doStream()
        }
      }
    })
    const result = ai.streamText({
      model,
      allowSystemInMessages: true,
      messages: [{ role: 'system', content: 'System.' }, { role: 'user', content: 'Call the dynamic tool.' }],
      tools: { dynamic },
      onStepStart: (event: any) => stepEvents.push(event),
      onLanguageModelCallStart: (event: any) => languageCallEvents.push(event)
    })

    await consumeText(result)

    const descriptions = (tools: any[]) => tools.map((tool) => tool.description)
    expect(stepEvents).toHaveLength(1)
    expect(languageCallEvents).toHaveLength(1)
    expect(dispatchInputs).toHaveLength(1)
    expect(providerCalls).toHaveLength(1)
    expect(descriptions(stepEvents[0].stepTools)).toEqual([
      'Read https://tool-description-1.example/schema.png'
    ])
    expect(descriptions(dispatchInputs[0].tools)).toEqual([
      'Read https://tool-description-2.example/schema.png'
    ])
    expect(languageCallEvents[0].tools).toEqual(dispatchInputs[0].tools)
    expect(providerCalls[0].tools).toEqual(dispatchInputs[0].tools)
    expect(dispatchInputs[0].prompt).toEqual(providerCalls[0].prompt)
  })

  it('observes each actual retry dispatch with the exact prompt and tools', async () => {
    const dispatchInputs: any[] = []
    const providerCalls: any[] = []
    let attempts = 0
    const baseModel = new aiTest.MockLanguageModelV4({
      provider: 'contract-test',
      modelId: 'retry-exact-dispatch',
      doStream: async (call: any) => {
        attempts++
        providerCalls.push(call)
        if (attempts === 1) {
          throw new provider.APICallError({
            message: 'transient provider failure (test)',
            url: 'https://provider.invalid/chat',
            requestBodyValues: {},
            statusCode: 503
          })
        }
        return {
          stream: aiTest.convertArrayToReadableStream(textChunks('recovered')),
          request: { body: { retryAttempt: attempts } }
        }
      }
    })
    const model = ai.wrapLanguageModel({
      model: baseModel,
      middleware: {
        specificationVersion: 'v4',
        wrapStream: async ({ params, doStream }: any) => {
          dispatchInputs.push({ prompt: params.prompt, tools: params.tools })
          return doStream()
        }
      }
    })
    const result = ai.streamText({
      model,
      allowSystemInMessages: true,
      messages: [{ role: 'user', content: 'Retry once.' }],
      maxRetries: 1
    })

    await consumeText(result)

    expect(attempts).toBe(2)
    expect(dispatchInputs).toHaveLength(2)
    expect(providerCalls).toHaveLength(2)
    for (let index = 0; index < attempts; index++) {
      expect(dispatchInputs[index].prompt).toEqual(providerCalls[index].prompt)
      expect(dispatchInputs[index].tools).toEqual(providerCalls[index].tools)
    }
  })

  it('observes a tool result on the next request, but never observes the final max-step result as a request', async () => {
    const providerCalls: any[] = []
    const observed: any[] = []
    let callNumber = 0
    const model = new aiTest.MockLanguageModelV4({
      provider: 'contract-test',
      modelId: 'max-step-tool-result',
      doStream: async (call: any) => {
        providerCalls.push(call)
        callNumber++
        return {
          stream: aiTest.convertArrayToReadableStream(
            toolCallChunks(`call-${callNumber}`, callNumber === 1 ? 'first-result' : 'final-result')
          ),
          request: { body: { probe: `step-${callNumber}` } }
        }
      }
    })
    const result = ai.streamText({
      model,
      allowSystemInMessages: true,
      messages: [{ role: 'user', content: 'Run echo twice.' }],
      tools: {
        echo: ai.tool({
          description: 'Echo test input.',
          inputSchema: providerUtils.jsonSchema({
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false
          }),
          execute: async ({ value }: any) => `tool-result:${value}`
        })
      },
      stopWhen: ai.isStepCount(2),
      onStepStart: (event: any) => observed.push(event.promptMessages)
    })

    await consumeText(result)

    expect(providerCalls).toHaveLength(2)
    expect(observed).toHaveLength(2)
    expect(observed[0]).toEqual(providerCalls[0].prompt)
    expect(observed[1]).toEqual(providerCalls[1].prompt)
    expect(JSON.stringify(observed[0])).not.toContain('tool-result:first-result')
    expect(JSON.stringify(observed[1])).toContain('tool-result:first-result')
    expect(JSON.stringify(observed)).not.toContain('tool-result:final-result')
  })

  it('observes both parallel tool results at the next dispatch, before the run finish callback', async () => {
    const providerCalls: any[] = []
    const dispatchObservations: any[] = []
    let callNumber = 0
    const baseModel = new aiTest.MockLanguageModelV4({
      provider: 'contract-test',
      modelId: 'parallel-tool-results',
      doStream: async (call: any) => {
        providerCalls.push(call)
        callNumber++
        const chunks = callNumber === 1
          ? [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'response-metadata' as const, id: 'parallel-response', modelId: 'contract-model' },
              { type: 'tool-call' as const, toolCallId: 'parallel-1', toolName: 'first', input: '{}' },
              { type: 'tool-call' as const, toolCallId: 'parallel-2', toolName: 'second', input: '{}' },
              finish('tool-calls')
            ]
          : textChunks('finished after both tools')
        return {
          stream: aiTest.convertArrayToReadableStream(chunks),
          request: { body: { callNumber } }
        }
      }
    })
    const model = ai.wrapLanguageModel({
      model: baseModel,
      middleware: {
        specificationVersion: 'v4',
        wrapStream: async ({ params, doStream }: any) => {
          dispatchObservations.push({ prompt: params.prompt, tools: params.tools })
          return doStream()
        }
      }
    })
    const result = ai.streamText({
      model,
      allowSystemInMessages: true,
      messages: [{ role: 'user', content: 'Run the two checks.' }],
      tools: {
        first: ai.tool({
          description: 'First parallel test.',
          inputSchema: providerUtils.jsonSchema({ type: 'object', properties: {} }),
          execute: async () => 'parallel-result:first'
        }),
        second: ai.tool({
          description: 'Second parallel test.',
          inputSchema: providerUtils.jsonSchema({ type: 'object', properties: {} }),
          execute: async () => 'parallel-result:second'
        })
      },
      stopWhen: ai.isStepCount(2)
    })

    await consumeText(result)

    expect(providerCalls).toHaveLength(2)
    expect(dispatchObservations).toHaveLength(2)
    expect(dispatchObservations[0].prompt).toEqual(providerCalls[0].prompt)
    expect(dispatchObservations[1].prompt).toEqual(providerCalls[1].prompt)
    const finalProviderPrompt = providerCalls[1].prompt
    const resultTexts = finalProviderPrompt
      .filter((message: any) => message.role === 'tool')
      .flatMap((message: any) => message.content)
      .filter((part: any) => part.type === 'tool-result')
      .map((part: any) => part.output.value)
    expect(new Set(resultTexts)).toEqual(new Set(['parallel-result:first', 'parallel-result:second']))
  })

  it('keeps mixed read-only prompt bytes identical with the callback absent or throwing', async () => {
    const localApprovalReason = 'Local approval explanation that must stay private.'
    const denialDeliveredToModel = 'The request was denied by execution policy.'
    const messages: any[] = [
      { role: 'system', content: 'Server prompt with cacheable prefix.', providerOptions: { contract: { cache: 'prefix' } } },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[The user said, mid-reply: inspect this evidence.]' },
          { type: 'file', data: new Uint8Array([137, 80, 78, 71, 0, 1]), mediaType: 'image/png' }
        ],
        providerOptions: { contract: { cache: 'turn' } }
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'approval-call', toolName: 'guarded', input: { path: '/private/file' } },
          { type: 'tool-approval-request', approvalId: 'approval-id', toolCallId: 'approval-call' }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-approval-response',
            approvalId: 'approval-id',
            approved: false,
            reason: localApprovalReason,
            providerExecuted: false
          },
          {
            type: 'tool-result',
            toolCallId: 'approval-call',
            toolName: 'guarded',
            output: { type: 'execution-denied', reason: denialDeliveredToModel }
          }
        ]
      },
      { role: 'user', content: 'Continue safely.' }
    ]

    const run = async (callback: ((event: any) => unknown) | undefined) => {
      const providerCalls: any[] = []
      const observed: any[] = []
      const baseModel = new aiTest.MockLanguageModelV4({
        provider: 'contract-test',
        modelId: 'read-only-parity',
        doStream: async (call: any) => {
          providerCalls.push(call)
          return {
            stream: aiTest.convertArrayToReadableStream(textChunks('done')),
            request: { body: { stableProbe: true } }
          }
        }
      })
      const model = ai.wrapLanguageModel({
        model: baseModel,
        middleware: {
          specificationVersion: 'v4',
          wrapStream: async ({ params, doStream }: any) => {
            const request = {
              prompt: params.prompt,
              tools: params.tools,
              providerOptions: params.providerOptions,
              headers: params.headers,
              maxOutputTokens: params.maxOutputTokens,
              temperature: params.temperature,
              topP: params.topP,
              topK: params.topK,
              stopSequences: params.stopSequences,
              seed: params.seed
            }
            if (callback) {
              observed.push(request)
              try {
                await callback(request)
              } catch {
                // The production observer is read-only; a reporting error cannot replace a call.
              }
            }
            return doStream()
          }
        }
      })
      const result = ai.streamText({
        model,
        allowSystemInMessages: true,
        messages,
        tools: {
          guarded: ai.tool({
            description: 'A guarded tool.',
            inputSchema: providerUtils.jsonSchema({
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false
            })
          })
        },
      })
      await consumeText(result)
      return { providerCalls, observed }
    }

    const withoutCallback = await run(undefined)
    const callbackEnabled = await run(() => undefined)
    let threwCallback = false
    const callbackThrows = await run(() => {
      threwCallback = true
      throw new Error('observation callback failure')
    })

    expect(withoutCallback.providerCalls).toHaveLength(1)
    expect(callbackEnabled.observed[0].prompt).toEqual(callbackEnabled.providerCalls[0].prompt)
    expect(callbackThrows.observed[0].prompt).toEqual(callbackThrows.providerCalls[0].prompt)
    expect(threwCallback).toBe(true)
    expect(providerRequestProjection(withoutCallback.providerCalls[0])).toBe(
      providerRequestProjection(callbackEnabled.providerCalls[0])
    )
    expect(providerRequestProjection(withoutCallback.providerCalls[0])).toBe(
      providerRequestProjection(callbackThrows.providerCalls[0])
    )

    const serializedPrompt = JSON.stringify(withoutCallback.providerCalls[0].prompt)
    expect(serializedPrompt).toContain('[The user said, mid-reply: inspect this evidence.]')
    expect(serializedPrompt).toContain('cache')
    const imagePart = withoutCallback.providerCalls[0].prompt.find((message: any) => message.role === 'user')
      .content.find((part: any) => part.type === 'file')
    expect(Object.values(imagePart.data.data)).toEqual([137, 80, 78, 71, 0, 1])
    expect(serializedPrompt).not.toContain(localApprovalReason)
    expect(serializedPrompt).toContain(denialDeliveredToModel)
  })
})
