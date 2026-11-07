import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart
} from '@ai-sdk/provider'

/**
 * BL-1517: keep a chat-completions model's `reasoning_content` across the tool calls of one reply.
 *
 * MiMo (and other OpenAI-compatible servers) stream their thinking as `delta.reasoning_content`
 * and ask for it back on the assistant messages of the same reply, so the model does not think
 * the whole problem again after every tool call. Batshit talks to them through `@ai-sdk/openai`
 * 4.0.79's chat model, which knows neither half: its stream reads only `delta.content`,
 * `delta.tool_calls` and `annotations`, and its message converter drops an assistant message's
 * reasoning parts. Batshit still SHOWED the reasoning (send-routed's raw-chunk fallback), but the
 * SDK's tool loop never held it, so every step went out without it.
 *
 * The provider stays: it owns the request builder (settings keys such as `openai.reasoningEffort`,
 * tool-schema normalisation, error handling), and swapping it for `@ai-sdk/openai-compatible`
 * would change all of that on the wire. This wrapper adds the two missing halves around it:
 *
 * - In: each raw chunk's `choices[0].delta.reasoning_content` becomes the SDK's own
 *   `reasoning-start` / `reasoning-delta` / `reasoning-end` parts, in stream order, so
 *   `ai`'s loop keeps the step's reasoning in that step's assistant message
 *   (`toResponseMessages`). A non-streamed reply's `message.reasoning_content` becomes a
 *   reasoning content part.
 * - Out: every model call gets a fresh chat model whose `fetch` writes each prompt assistant
 *   message's own reasoning onto the matching assistant message of the body as
 *   `reasoning_content`, the field and value `@ai-sdk/openai-compatible` 3.0.58 writes (its
 *   reasoning parts joined). Nothing is held between calls.
 *
 * Both readers follow `@ai-sdk/openai-compatible`: `reasoning_content`, else `reasoning`.
 */

/** One prompt assistant message: its reasoning parts joined, and its tool calls in order. */
export interface AssistantStepReasoning {
  reasoning: string
  toolCallIds: string[]
}

/** The chat model for one call; `fetch` is set only when that call carries reasoning. */
export type ReasoningContentChatModelFactory = (fetch?: typeof globalThis.fetch) => LanguageModelV4

/** The connection a log line names: the chat model's `provider` and `modelId`. */
export interface ReasoningContentCarryContext {
  provider?: string
  modelId?: string
}

/** Every assistant message of the prompt, in order (the converter makes one body message each). */
export function assistantStepReasoning(prompt: LanguageModelV4Prompt): AssistantStepReasoning[] {
  const steps: AssistantStepReasoning[] = []
  for (const message of prompt) {
    if (message.role !== 'assistant') continue
    let reasoning = ''
    const toolCallIds: string[] = []
    for (const part of message.content) {
      if (part.type === 'reasoning') reasoning += part.text
      else if (part.type === 'tool-call') toolCallIds.push(part.toolCallId)
    }
    steps.push({ reasoning, toolCallIds })
  }
  return steps
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * The request body with each assistant message's own `reasoning_content`, or the body unchanged.
 *
 * `@ai-sdk/openai`'s converter turns each prompt assistant message into exactly one body
 * assistant message (`convertToOpenAIChatMessages`, assistant case), so the two lists line up by
 * order; the tool-call ids of each pair must match too. If they do not (a provider release that
 * changed the converter), nothing is written and the reason is logged: the request still goes out
 * exactly as the SDK built it, as before BL-1517. The contract test pins the alignment.
 */
export function carryAssistantReasoning<T>(
  body: T,
  steps: readonly AssistantStepReasoning[],
  context?: ReasoningContentCarryContext
): T {
  if (!steps.some((step) => step.reasoning.length > 0)) return body
  const messages = (body as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return body

  const assistantIndexes: number[] = []
  messages.forEach((message, index) => {
    if (message && typeof message === 'object' && (message as { role?: unknown }).role === 'assistant') {
      assistantIndexes.push(index)
    }
  })
  if (assistantIndexes.length !== steps.length) {
    console.error('[ReasoningContentCarry] Assistant messages do not line up; reasoning_content not sent', {
      provider: context?.provider,
      modelId: context?.modelId,
      promptAssistantMessages: steps.length,
      bodyAssistantMessages: assistantIndexes.length
    })
    return body
  }

  const next = [...messages]
  for (let step = 0; step < steps.length; step += 1) {
    const { reasoning, toolCallIds } = steps[step]!
    if (!reasoning) continue
    const index = assistantIndexes[step]!
    const message = messages[index] as Record<string, unknown>
    const bodyToolCallIds = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call: { id?: unknown }) => String(call?.id ?? ''))
      : []
    if (!sameIds(bodyToolCallIds, toolCallIds)) {
      console.error('[ReasoningContentCarry] Tool calls do not line up; reasoning_content not sent', {
        provider: context?.provider,
        modelId: context?.modelId,
        assistantMessage: step,
        promptToolCalls: toolCallIds.length,
        bodyToolCalls: bodyToolCallIds.length
      })
      return body
    }
    if (message.reasoning_content !== undefined) continue
    const { role, content, ...rest } = message
    next[index] = { role, content, reasoning_content: reasoning, ...rest }
  }
  return { ...(body as object), messages: next } as T
}

function parseJsonBody(body: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof body !== 'string') return { ok: false }
  try {
    return { ok: true, value: JSON.parse(body) }
  } catch {
    return { ok: false }
  }
}

/**
 * A `fetch` that applies `carryAssistantReasoning` to one call's JSON request body. `onCarried`
 * receives the body object it sent, only when a field was added. A body it cannot read while a
 * step carries reasoning is logged and sent unchanged: a no-send is never silent.
 */
export function withAssistantReasoningContent(
  steps: readonly AssistantStepReasoning[],
  baseFetch?: typeof globalThis.fetch,
  options: { context?: ReasoningContentCarryContext; onCarried?: (body: unknown) => void } = {}
): typeof globalThis.fetch {
  const { context, onCarried } = options
  const carriesReasoning = steps.some((step) => step.reasoning.length > 0)
  return async (input, init) => {
    const send = baseFetch ?? globalThis.fetch
    const parsed = parseJsonBody(init?.body)
    if (!parsed.ok) {
      if (carriesReasoning) {
        console.error('[ReasoningContentCarry] Request body is not JSON; reasoning_content not sent', {
          provider: context?.provider,
          modelId: context?.modelId
        })
      }
      return send(input, init)
    }
    const carried = carryAssistantReasoning(parsed.value, steps, context)
    if (carried === parsed.value) return send(input, init)
    onCarried?.(carried)
    return send(input, { ...init, body: JSON.stringify(carried) })
  }
}

function readReasoning(record: unknown): string {
  if (!record || typeof record !== 'object') return ''
  const value =
    (record as { reasoning_content?: unknown }).reasoning_content ??
    (record as { reasoning?: unknown }).reasoning
  return typeof value === 'string' ? value : ''
}

function firstChoice(value: unknown): Record<string, unknown> | null {
  const choices = (value as { choices?: unknown } | null)?.choices
  const first = Array.isArray(choices) ? choices[0] : null
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : null
}

/** A streamed chunk's reasoning text, read from the parsed chunk the provider passes as `raw`. */
export function streamedReasoningContent(rawValue: unknown): string {
  return readReasoning(firstChoice(rawValue)?.delta)
}

/** Parts that leave the reasoning block open: they carry no model output. */
const OUTPUT_NEUTRAL_PARTS = new Set<LanguageModelV4StreamPart['type']>(['stream-start', 'response-metadata'])

function reasoningPartsFromRawChunks(keepRaw: boolean) {
  let openId: string | null = null
  let blocks = 0
  const close = (controller: TransformStreamDefaultController<LanguageModelV4StreamPart>) => {
    if (!openId) return
    controller.enqueue({ type: 'reasoning-end', id: openId })
    openId = null
  }
  return new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
    transform(part, controller) {
      if (part.type === 'raw') {
        if (keepRaw) controller.enqueue(part)
        const delta = streamedReasoningContent(part.rawValue)
        if (!delta) return
        if (!openId) {
          openId = `reasoning-content-${blocks}`
          blocks += 1
          controller.enqueue({ type: 'reasoning-start', id: openId })
        }
        controller.enqueue({ type: 'reasoning-delta', id: openId, delta })
        return
      }
      if (!OUTPUT_NEUTRAL_PARTS.has(part.type)) close(controller)
      controller.enqueue(part)
    },
    flush(controller) {
      close(controller)
    }
  })
}

/**
 * Wraps one chat model (`createChatModel()` with no fetch is the plain provider model) so its
 * reasoning reaches the SDK as reasoning and goes back out on later steps. Opt in per connection
 * with `reasoningContent` in `registerOpenAICompatibleProvider`.
 */
export function reasoningContentChatModel(createChatModel: ReasoningContentChatModelFactory, baseFetch?: typeof globalThis.fetch): LanguageModelV4 {
  const base = createChatModel()
  const context: ReasoningContentCarryContext = { provider: base.provider, modelId: base.modelId }
  /** One model call: its chat model, and the body its fetch sent once a field was added. */
  const callFor = (steps: readonly AssistantStepReasoning[]) => {
    if (!steps.some((step) => step.reasoning.length > 0)) return { model: base, carriedBody: () => undefined }
    let carried: unknown
    const model = createChatModel(
      withAssistantReasoningContent(steps, baseFetch, { context, onCarried: (body) => { carried = body } })
    )
    return { model, carriedBody: () => carried }
  }
  // The request evidence (Execution Viewer) shows the body that went out, reasoning included:
  // the object the fetch sent, never a second rewrite (which would log a mismatch twice).
  const sentRequest = <R extends { request?: { body?: unknown } }>(result: R, carried: unknown) =>
    result.request && carried !== undefined ? { ...result.request, body: carried } : result.request

  return {
    specificationVersion: 'v4',
    provider: base.provider,
    modelId: base.modelId,
    supportedUrls: base.supportedUrls,
    doGenerate: async (options) => {
      const call = callFor(assistantStepReasoning(options.prompt))
      const result = await call.model.doGenerate(options)
      const reasoning = readReasoning(firstChoice(result.response?.body)?.message)
      const content: LanguageModelV4Content[] = reasoning
        ? [{ type: 'reasoning', text: reasoning }, ...result.content]
        : result.content
      return { ...result, content, request: sentRequest(result, call.carriedBody()) }
    },
    doStream: async (options) => {
      const call = callFor(assistantStepReasoning(options.prompt))
      const result = await call.model.doStream({ ...options, includeRawChunks: true })
      return {
        ...result,
        request: sentRequest(result, call.carriedBody()),
        stream: result.stream.pipeThrough(reasoningPartsFromRawChunks(options.includeRawChunks === true))
      }
    }
  }
}
