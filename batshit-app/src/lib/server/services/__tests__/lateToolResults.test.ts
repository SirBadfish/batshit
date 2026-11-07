// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.unmock('ai')

import { jsonSchema, streamText, tool } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import {
  STOPPED_WITHOUT_RESULT_REASON,
  noteToolProgress,
  runAbortSignalOf,
  trackToolExecution,
  withToolResultsOnStop
} from '../lateToolResults'
import { VercelAIBrain } from '../vercelBrain'

/**
 * BL-1959, on the REAL installed AI SDK (7.0.119): a Stop that lands while a tool runs makes the
 * SDK wait for that tool's `execute` and then end the stream with `abort`, without the call's
 * `tool-result`, so the stopped reply was saved with no step. `withToolResultsOnStop` hands the
 * result on before the `abort`; the tools are wrapped the way `vercelBrain.ts` wraps every API tool.
 */


const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }

/** A model that asks for one tool call, then (a second step) answers in words. */
function toolCallingModel() {
  let step = 0
  return new MockLanguageModelV4({
    doStream: async () => {
      step += 1
      return {
        stream: convertArrayToReadableStream(step === 1
          ? [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'tool-call' as const, toolCallId: 'call_1', toolName: 'run', input: '{"command":"sleep 30"}' },
              { type: 'finish' as const, finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: USAGE }
            ]
          : [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: 't1' },
              { type: 'text-delta' as const, id: 't1', delta: 'done' },
              { type: 'text-end' as const, id: 't1' },
              { type: 'finish' as const, finishReason: { unified: 'stop', raw: 'end_turn' }, usage: USAGE }
            ] as any)
      }
    }
  })
}

/** The tool as `vercelBrain.ts` hands it to the SDK: its `execute` tracked by tool call id. */
function wrapped(execute: (input: any, options: any) => any) {
  const brain = new VercelAIBrain() as any
  return brain.wrapToolsWithReadableModelOutput(
    { run: tool({ inputSchema: jsonSchema({ type: 'object', properties: { command: { type: 'string' } } }), execute }) },
    { userId: 'u', sessionId: 's', messageId: 'm', agentId: 'a', fetchZipAllowed: false }
  )
}

async function readParts(stream: AsyncIterable<any>) {
  const parts: any[] = []
  try {
    for await (const part of stream) parts.push(part)
  } catch (error) {
    parts.push({ type: 'THROWN', error: String(error) })
  }
  return parts
}

const summary = (parts: any[]) => parts.map((part) => `${part.type}${part.toolCallId ? `:${part.toolCallId}` : ''}`)

describe('a Stop during a running tool call (BL-1959)', () => {
  it('the SDK alone drops the result; the wrapped stream hands it on before the abort', async () => {
    for (const withWrapper of [false, true]) {
      const stop = new AbortController()
      const tools = wrapped(async (_input: any, options: any) => {
        setTimeout(() => stop.abort('user'), 10)
        await new Promise((resolve) => options.abortSignal.addEventListener('abort', resolve))
        return { success: false, stopped: true, reason: 'The command was stopped.' }
      })
      const result = streamText({ model: toolCallingModel(), prompt: 'x', tools, abortSignal: stop.signal })
      const parts = await readParts(withWrapper ? withToolResultsOnStop(result.stream, stop.signal) : result.stream)
      if (!withWrapper) {
        // The pin: if the SDK starts streaming the result itself, this wrapper can go.
        expect(summary(parts)).toEqual(['start', 'start-step', 'tool-call:call_1', 'abort'])
        continue
      }
      expect(summary(parts)).toEqual(['start', 'start-step', 'tool-call:call_1', 'tool-result:call_1', 'abort'])
      expect(parts[3]).toMatchObject({
        toolName: 'run',
        input: { command: 'sleep 30' },
        output: { success: false, stopped: true, reason: 'The command was stopped.' }
      })
    }
  })

  it('a tool that throws on the Stop is handed on as a tool-error', async () => {
    const stop = new AbortController()
    const tools = wrapped(async (_input: any, options: any) => {
      setTimeout(() => stop.abort('user'), 10)
      await new Promise((resolve) => options.abortSignal.addEventListener('abort', resolve))
      throw new Error('gateway call cancelled')
    })
    const result = streamText({ model: toolCallingModel(), prompt: 'x', tools, abortSignal: stop.signal })
    const parts = await readParts(withToolResultsOnStop(result.stream, stop.signal))
    expect(summary(parts)).toEqual(['start', 'start-step', 'tool-call:call_1', 'tool-error:call_1', 'abort'])
    expect(String(parts[3].error)).toContain('gateway call cancelled')
  })

  it('a tool that never returns is recorded as stopped with no result, and the stream ends', async () => {
    const stop = new AbortController()
    const tools = wrapped(async () => {
      setTimeout(() => stop.abort('user'), 10)
      return await new Promise(() => {})
    })
    const result = streamText({ model: toolCallingModel(), prompt: 'x', tools, abortSignal: stop.signal })
    const started = Date.now()
    let released = 0
    const parts = await readParts(withToolResultsOnStop(result.stream, stop.signal, { waitMs: 150, onEarlyEnd: () => released++ }))
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(released).toBe(1)
    expect(summary(parts)).toEqual(['start', 'start-step', 'tool-call:call_1', 'tool-result:call_1'])
    expect(parts[3].output).toEqual({
      success: false, blocked: false, stopped: true, neverReturned: true, reason: STOPPED_WITHOUT_RESULT_REASON
    })
  })

  it('a run with no Stop passes every part through unchanged, the same objects in the same order', async () => {
    const raw = await readParts(streamText({ model: toolCallingModel(), prompt: 'x', tools: wrapped(async () => ({ ok: 1 })) }).stream)
    async function* replay() { for (const part of raw) yield part }
    const viaWrapper = await readParts(withToolResultsOnStop(replay(), new AbortController().signal))
    expect(viaWrapper).toEqual(raw)
    viaWrapper.forEach((part, index) => expect(part).toBe(raw[index]))
  })

  it('a call already answered is not answered again (Stop in the next step’s words)', async () => {
    const late = new AbortController()
    const parts: any[] = []
    for await (const part of withToolResultsOnStop(
      streamText({ model: toolCallingModel(), prompt: 'x', tools: wrapped(async () => ({ ok: 1 })), abortSignal: late.signal }).stream,
      late.signal
    )) {
      parts.push(part)
      if (part.type === 'text-delta') late.abort('user')
    }
    expect(summary(parts).filter((part) => part.startsWith('tool-result'))).toEqual(['tool-result:call_1'])
  })

  it('a call an approval click resumes (no tool-call part) is handed on too', async () => {
    const resumeMessages: any = [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'call_a', toolName: 'run', input: { command: 'sleep 30' } },
        { type: 'tool-approval-request', approvalId: 'appr_1', toolCallId: 'call_a' }
      ] },
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'appr_1', approved: true }] }
    ]
    const textModel = new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't1' }, { type: 'text-delta' as const, id: 't1', delta: 'done' }, { type: 'text-end' as const, id: 't1' },
      { type: 'finish' as const, finishReason: { unified: 'stop', raw: 'end_turn' }, usage: USAGE }
    ] as any) }) })
    for (const withWrapper of [false, true]) {
      const stop = new AbortController()
      const tools = wrapped(async (_input: any, options: any) => {
        setTimeout(() => stop.abort('user'), 10)
        await new Promise((resolve) => options.abortSignal.addEventListener('abort', resolve))
        return { success: false, stopped: true, reason: 'The command was stopped.' }
      })
      const result = streamText({ model: textModel, messages: resumeMessages, tools, toolApproval: { run: async () => 'user-approval' }, abortSignal: stop.signal } as any)
      const parts = await readParts(withWrapper ? withToolResultsOnStop(result.stream, stop.signal, { waitMs: 300 }) : result.stream)
      expect(summary(parts)).toEqual(withWrapper ? ['start', 'tool-result:call_a', 'abort'] : ['start', 'abort'])
      if (withWrapper) expect(parts[1]).toMatchObject({ toolName: 'run', input: { command: 'sleep 30' }, output: { stopped: true } })
    }
  })

  it('one run never sees another run’s call, even under the same tool call id', async () => {
    // Run 1 executes `call_1` and nobody reads it through the wrapper; run 2 makes `call_1` too, for
    // a tool waiting on a card (no execute), and is stopped.
    await readParts(streamText({ model: toolCallingModel(), prompt: 'x', tools: wrapped(async () => ({ fromRun: 1 })), abortSignal: new AbortController().signal }).stream)
    const stop = new AbortController()
    const hangingModel = new MockLanguageModelV4({ doStream: async ({ abortSignal }: any) => ({ stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
      controller.enqueue({ type: 'tool-call', toolCallId: 'call_1', toolName: 'run', input: '{"command":"x"}' })
      abortSignal?.addEventListener('abort', () => { try { controller.error(new DOMException('The operation was aborted.', 'AbortError')) } catch {} })
    } }) }) })
    const run2 = streamText({ model: hangingModel, prompt: 'y', tools: wrapped(async () => ({ fromRun: 2 })), toolApproval: { run: async () => 'user-approval' }, abortSignal: stop.signal } as any)
    setTimeout(() => stop.abort('user'), 50)
    const parts = await readParts(withToolResultsOnStop(run2.stream, stop.signal, { waitMs: 300 }))
    expect(parts.filter((part) => part.type === 'tool-result')).toEqual([])

    // And another run's running tool never ends this run's stream early.
    trackToolExecution(new AbortController().signal, 'other_run_call', 'run', {}, new Promise(() => {}))
    const mine = new AbortController()
    async function* slow() {
      mine.abort('user')
      await new Promise((resolve) => setTimeout(resolve, 200))
      yield { type: 'text-delta', text: 'still answering' }
      yield { type: 'abort' }
    }
    expect(summary(await readParts(withToolResultsOnStop(slow(), mine.signal, { waitMs: 50 })))).toEqual(['text-delta', 'abort'])
  })

  it('a stream with no tracked call is read to its own end after a Stop (a CLI lane, a model answering it)', async () => {
    const stop = new AbortController()
    async function* slowStream() {
      yield { type: 'tool-call', toolCallId: 'cli_call', toolName: 'Bash', input: {} }
      stop.abort('user')
      await new Promise((resolve) => setTimeout(resolve, 300))
      yield { type: 'tool-result', toolCallId: 'cli_call', toolName: 'Bash', input: {}, output: 'ended' }
      yield { type: 'abort' }
    }
    const parts = await readParts(withToolResultsOnStop(slowStream(), stop.signal, { waitMs: 50 }))
    expect(summary(parts)).toEqual(['tool-call:cli_call', 'tool-result:cli_call', 'abort'])
  })

  it('a stream that throws the Stop hands the result on first, then throws', async () => {
    const stop = new AbortController()
    trackToolExecution(stop.signal, 'call_t', 'run', { command: 'x' }, Promise.resolve({ stopped: true }))
    async function* throwing() {
      yield { type: 'tool-call', toolCallId: 'call_t', toolName: 'run', input: { command: 'x' } }
      stop.abort('user')
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw 'user'
    }
    const parts = await readParts(withToolResultsOnStop(throwing(), stop.signal))
    expect(summary(parts)).toEqual(['tool-call:call_t', 'tool-result:call_t', 'THROWN'])
  })
})

describe('a reader that leaves early closes the stream, as a for-await over it does (BL-1959)', () => {
  it('runs the stream’s own finally (a CLI adapter finishes its run there)', async () => {
    const closed: string[] = []
    async function* source() {
      try {
        yield { type: 'text-delta', text: 'a' }
        yield { type: 'finish' }
        yield { type: 'never-read' }
      } finally {
        closed.push('finally ran')
      }
    }
    for await (const part of withToolResultsOnStop(source(), new AbortController().signal)) {
      if (part.type === 'finish') break
    }
    expect(closed).toEqual(['finally ran'])
  })
})

describe('a call the stream answered is never answered again (BL-1959)', () => {
  it('even when its tracked execution has not settled by the Stop', async () => {
    const stop = new AbortController()
    trackToolExecution(stop.signal, 'call_answered', 'run', {}, new Promise(() => {}))
    async function* source() {
      yield { type: 'tool-call', toolCallId: 'call_answered', toolName: 'run', input: {} }
      yield { type: 'tool-result', toolCallId: 'call_answered', toolName: 'run', input: {}, output: { ok: 1 } }
      stop.abort('user')
      yield { type: 'abort' }
    }
    const parts = await readParts(withToolResultsOnStop(source(), stop.signal, { waitMs: 50 }))
    expect(summary(parts)).toEqual(['tool-call:call_answered', 'tool-result:call_answered', 'abort'])
  })
})

vi.mock('../chatgptPlanHost', () => ({ getChatgptPlanRuntime: () => ({ assertLease: () => {} }) }))

describe('a tool wrapper that replaces the Stop signal (the ChatGPT plan lane, second review pass)', () => {
  it('still records a call stopped mid-run under the run that streams it', async () => {
    const { planClientTools } = await import('../chatgptPlanInference')
    const stop = new AbortController()
    let innerSignal: AbortSignal | undefined
    const lease = { signal: new AbortController().signal } as any
    const tools = planClientTools(wrapped(async (_input: any, options: any) => {
      innerSignal = options.abortSignal
      setTimeout(() => stop.abort('user'), 10)
      await new Promise((resolve) => options.abortSignal.addEventListener('abort', resolve))
      return { success: false, stopped: true, reason: 'The command was stopped.' }
    }), lease)
    const result = streamText({ model: toolCallingModel(), prompt: 'x', tools, abortSignal: stop.signal })
    const parts = await readParts(withToolResultsOnStop(result.stream, stop.signal, { waitMs: 300 }))
    // The plan wrapper did replace the signal the tool sees; the record still finds the call.
    expect(innerSignal).not.toBe(stop.signal)
    expect(summary(parts)).toEqual(['start', 'start-step', 'tool-call:call_1', 'tool-result:call_1', 'abort'])
  })
})

describe('a call that reported what it already did, then never returned (BL-1978)', () => {
  const PATCH_FACTS = {
    command: "apply_patch <<'PATCH' && npm test\n*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\nPATCH",
    mappedReason: 'apply-patch',
    managedApplyPatch: { managed: true, applied: true, operationsApplied: 1, touchedPaths: ['a.txt'], afterPatch: { command: 'npm test', tail: 'npm test' } }
  }

  it('is saved stopped with no result, and with the facts it reported', async () => {
    const stop = new AbortController()
    const tools = wrapped(async (_input: any, options: any) => {
      noteToolProgress(runAbortSignalOf(options), options.toolCallId, PATCH_FACTS)
      setTimeout(() => stop.abort('user'), 10)
      return await new Promise(() => {})
    })
    const result = streamText({ model: toolCallingModel(), prompt: 'x', tools, abortSignal: stop.signal })
    const parts = await readParts(withToolResultsOnStop(result.stream, stop.signal, { waitMs: 150 }))
    expect(summary(parts)).toEqual(['start', 'start-step', 'tool-call:call_1', 'tool-result:call_1'])
    expect(parts[3].output).toEqual({
      ...PATCH_FACTS, success: false, blocked: false, stopped: true, neverReturned: true, reason: STOPPED_WITHOUT_RESULT_REASON
    })
  })

  it('a call that settles is saved from its own result, never from what it reported', async () => {
    const stop = new AbortController()
    const tools = wrapped(async (_input: any, options: any) => {
      noteToolProgress(runAbortSignalOf(options), options.toolCallId, PATCH_FACTS)
      setTimeout(() => stop.abort('user'), 10)
      await new Promise((resolve) => options.abortSignal.addEventListener('abort', resolve))
      return { success: false, stopped: true, reason: 'The command was stopped.' }
    })
    const result = streamText({ model: toolCallingModel(), prompt: 'x', tools, abortSignal: stop.signal })
    const parts = await readParts(withToolResultsOnStop(result.stream, stop.signal))
    expect(parts[3].output).toEqual({ success: false, stopped: true, reason: 'The command was stopped.' })
  })

  it('one run never carries another run’s report, even under the same tool call id', async () => {
    const other = new AbortController()
    noteToolProgress(other.signal, 'call_1', PATCH_FACTS)
    const stop = new AbortController()
    const tools = wrapped(async () => {
      setTimeout(() => stop.abort('user'), 10)
      return await new Promise(() => {})
    })
    const result = streamText({ model: toolCallingModel(), prompt: 'x', tools, abortSignal: stop.signal })
    const parts = await readParts(withToolResultsOnStop(result.stream, stop.signal, { waitMs: 150 }))
    expect(parts[3].output).toEqual({ success: false, blocked: false, stopped: true, neverReturned: true, reason: STOPPED_WITHOUT_RESULT_REASON })
  })

  it('a later report of the same call is merged over the earlier one', async () => {
    const stop = new AbortController()
    noteToolProgress(stop.signal, 'call_9', { a: 1, b: 1 })
    noteToolProgress(stop.signal, 'call_9', { b: 2 })
    trackToolExecution(stop.signal, 'call_9', 'run', {}, new Promise(() => {}))
    async function* stream() {
      yield { type: 'tool-call', toolCallId: 'call_9' }
      stop.abort('user')
      await new Promise(() => {})
    }
    const parts = await readParts(withToolResultsOnStop(stream(), stop.signal, { waitMs: 50 }))
    expect(parts[1].output).toMatchObject({ a: 1, b: 2, neverReturned: true })
  })
})


describe('the already-ended managed API context-error tail (BL-2004)', () => {
  it('reads queued real SDK output/result/finish after its GLOBAL end, without another provider or tool call', async () => {
    const stop = new AbortController()
    const execute = vi.fn(async () => ({ actualQueuedResult: true }))
    let providerStep = 0
    const provider = vi.fn(async () => ({ stream: convertArrayToReadableStream(++providerStep === 1 ? [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'queued', toolName: 'run', input: '{"command":"already-issued"}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: USAGE }
    ] : [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'tail' }, { type: 'text-delta', id: 'tail', delta: 'already produced' }, { type: 'text-end', id: 'tail' },
      { type: 'error', error: new Error('maximum context length exceeded') },
      { type: 'finish', finishReason: { unified: 'error', raw: 'context_length_exceeded' }, usage: USAGE }
    ] as any) }))
    let globalEnd = false
    const result = streamText({ model: new MockLanguageModelV4({ doStream: provider }), prompt: 'x',
      tools: wrapped(execute), abortSignal: stop.signal, stopWhen: ({ steps }) => steps.length >= 2,
      onEnd: () => { globalEnd = true } })
    const queued = result.stream
    // Deliberately finish a separate SDK copy in this unit pin. Production NEVER consumes/pulls
    // a copy to obtain quiescence; it can only read the Brain's actual global-callback fact.
    await result.consumeStream()
    expect(globalEnd).toBe(true)
    expect(provider).toHaveBeenCalledTimes(2); expect(execute).toHaveBeenCalledOnce()
    let deadline: number | undefined
    const parts: any[] = []
    for await (const part of withToolResultsOnStop(queued, stop.signal, { contextErrorDrainDeadline: () => deadline })) {
      parts.push(part)
      if (part.type === 'error') deadline = performance.now() + 500
    }
    expect(parts.find(part => part.type === 'text-delta')?.text).toBe('already produced')
    expect(parts.filter(part => part.type === 'tool-result').map(part => part.toolCallId)).toEqual(['queued'])
    expect(parts.filter(part => part.type === 'error')).toHaveLength(1)
    expect(parts.at(-1)?.type).toBe('finish')
    expect(provider).toHaveBeenCalledTimes(2); expect(execute).toHaveBeenCalledOnce()
  })

  it('bounds a missing finish AND a never-resolving iterator close without inventing a finish', async () => {
    const close = vi.fn(() => new Promise<IteratorResult<any>>(() => {}))
    let first = true, deadline: number | undefined
    const source: AsyncIterable<any> = { [Symbol.asyncIterator]: () => ({
      next: () => first ? (first = false, Promise.resolve({ value: { type: 'error' }, done: false as const })) : new Promise<IteratorResult<any>>(() => {}),
      return: close,
    }) }
    const early = vi.fn(), parts: any[] = [], started = performance.now()
    for await (const part of withToolResultsOnStop(source, new AbortController().signal, {
      contextErrorDrainDeadline: () => deadline, onEarlyEnd: early,
    })) { parts.push(part); deadline = performance.now() + 40 }
    expect(summary(parts)).toEqual(['error'])
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(early).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
  })

  it('uses one total deadline, including consumer work, and never pulls an already-expired finish', async () => {
    let deadline: number | undefined
    const advancedToFinish = vi.fn(), closed = vi.fn(), parts: any[] = []
    async function* source() {
      try { yield { type: 'error' }; yield { type: 'text-delta' }; advancedToFinish(); yield { type: 'finish' } }
      finally { closed() }
    }
    for await (const part of withToolResultsOnStop(source(), new AbortController().signal, { contextErrorDrainDeadline: () => deadline })) {
      parts.push(part)
      if (part.type === 'error') deadline = performance.now() + 40
      if (part.type === 'text-delta') await new Promise(resolve => setTimeout(resolve, 60))
    }
    expect(summary(parts)).toEqual(['error', 'text-delta'])
    expect(advancedToFinish).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledOnce()
  })

  it('does not revive an abandoned consumer when its pending finish arrives after the deadline', async () => {
    let deadline: number | undefined, first = true, lateFinish: ((part: IteratorResult<any>) => void) | undefined
    const close = vi.fn(async () => ({ value: undefined, done: true as const }))
    const source: AsyncIterable<any> = { [Symbol.asyncIterator]: () => ({
      next: () => first ? (first = false, Promise.resolve({ value: { type: 'error' }, done: false as const }))
        : new Promise<IteratorResult<any>>(resolve => { lateFinish = resolve }),
      return: close,
    }) }
    const parts: any[] = [], early = vi.fn()
    for await (const part of withToolResultsOnStop(source, undefined, { contextErrorDrainDeadline: () => deadline, onEarlyEnd: early })) {
      parts.push(part); deadline = performance.now() + 40
    }
    expect(lateFinish).toBeDefined()
    lateFinish!({ value: { type: 'finish' }, done: false })
    await Promise.resolve()
    expect(summary(parts)).toEqual(['error'])
    expect(early).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
  })

  it('bounds an opted-in early refusal close even when no tail read was admitted', async () => {
    const close = vi.fn(() => new Promise<IteratorResult<any>>(() => {}))
    const next = vi.fn(async () => ({ value: { type: 'error' }, done: false as const }))
    const source: AsyncIterable<any> = { [Symbol.asyncIterator]: () => ({ next, return: close }) }
    let deadline: number | undefined
    const started = performance.now()
    for await (const _part of withToolResultsOnStop(source, undefined, { contextErrorDrainDeadline: () => deadline })) {
      deadline = performance.now() + 40
      break // the route refused: no actual global end, so it must not pull again
    }
    expect(next).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('keeps a Stop during the tail unknown and retains the run’s real applied progress', async () => {
    const stop = new AbortController(), closed = vi.fn(), advanced = vi.fn()
    trackToolExecution(stop.signal, 'stopped-tail', 'run', {}, new Promise(() => {}))
    noteToolProgress(stop.signal, 'stopped-tail', { applied: true })
    let deadline: number | undefined
    async function* source() {
      try { yield { type: 'error' }; advanced(); yield { type: 'finish' } }
      finally { closed() }
    }
    const parts: any[] = []
    for await (const part of withToolResultsOnStop(source(), stop.signal, { contextErrorDrainDeadline: () => deadline })) {
      parts.push(part)
      if (part.type === 'error') { deadline = performance.now() + 500; stop.abort('user') }
    }
    expect(summary(parts)).toEqual(['error', 'tool-result:stopped-tail'])
    expect(parts[1].output).toMatchObject({ applied: true, stopped: true, neverReturned: true, success: false })
    expect(advanced).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledOnce()
  })

  it('propagates a queued stream failure rather than claiming a terminal finish', async () => {
    let deadline: number | undefined
    async function* source() { yield { type: 'error' }; throw new Error('queued transport failed') }
    const parts: any[] = []
    try {
      for await (const part of withToolResultsOnStop(source(), undefined, { contextErrorDrainDeadline: () => deadline })) {
        parts.push(part); deadline = performance.now() + 500
      }
    } catch (error) { parts.push({ type: 'THROWN', error: String(error) }) }
    expect(summary(parts)).toEqual(['error', 'THROWN'])
    expect(parts[1].error).toContain('queued transport failed')
  })

  it('leaves ordinary/non-context opt-outs unchanged, including the same parts and awaited close', async () => {
    const error = { type: 'error' }, closed = vi.fn()
    async function* source() { try { yield error; yield { type: 'finish' } } finally { closed() } }
    const parts: any[] = []
    for await (const part of withToolResultsOnStop(source(), undefined, { contextErrorDrainDeadline: () => undefined })) {
      parts.push(part); break
    }
    expect(parts).toEqual([error]); expect(parts[0]).toBe(error); expect(closed).toHaveBeenCalledOnce()
  })
})
