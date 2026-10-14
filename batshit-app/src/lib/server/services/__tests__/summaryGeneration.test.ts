import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-622 (rule C6): a summary call on the API lane has a limit and can be stopped. A Compact and a
 * nap wait on it; with neither, a model that never answered kept the Compact busy for good.
 */

const model = vi.hoisted(() => ({
  calls: [] as Array<{ abortSignal?: AbortSignal }>,
  /** How the stubbed model answers: at once, or only when its signal aborts. */
  mode: 'answer' as 'answer' | 'hang'
}))

const hidden = vi.hoisted(() => ({
  calls: [] as Array<{ abortSignal?: AbortSignal }>
}))

vi.mock('../codexBridge', () => ({
  CodexBridge: class {
    async generateHiddenText(options: { abortSignal?: AbortSignal }) {
      hidden.calls.push(options)
      return { text: 'Codex summary.', modelLabel: 'Codex test', modelId: 'gpt-test' }
    }
  }
}))

vi.mock('ai', () => ({
  generateText: vi.fn(async (options: { abortSignal?: AbortSignal }) => {
    model.calls.push(options)
    if (model.mode === 'answer') return { text: 'A summary.' }
    return await new Promise((_, reject) => {
      options.abortSignal?.addEventListener('abort', () => reject(new Error('This operation was aborted')), {
        once: true
      })
    })
  })
}))

vi.mock('$lib/server/services/providers', () => ({
  ProviderManager: { createForUser: vi.fn(async () => ({ getModel: () => ({ modelId: 'stub-model' }) })) }
}))

const { generateModelSummary, SUMMARY_CALL_LIMIT_MS, SummaryCallLimitError } = await import(
  '../summaryGeneration'
)

const AGENT = {
  id: 'zcyield_agent',
  agentType: 'api',
  primary_model_provider: 'openai',
  primary_model_name: 'gpt-test',
  primary_model_connection: { id: 'direct:openai', type: 'direct', service: 'openai' }
}

function summarize(abortSignal?: AbortSignal) {
  return generateModelSummary({
    userId: 'zcyield_user',
    agent: AGENT as any,
    choice: { modelMode: 'current', modelPresetId: null },
    prompt: 'Summarize this.',
    summaryHardMaxTokens: 500,
    abortSignal
  })
}

/** Under fake timers: let the call reach the model without moving the clock (vi.waitFor would). */
async function untilModelCalled() {
  for (let step = 0; step < 50 && model.calls.length === 0; step++) await vi.advanceTimersByTimeAsync(0)
  expect(model.calls).toHaveLength(1)
}

afterEach(() => {
  vi.useRealTimers()
  model.calls = []
  model.mode = 'answer'
  hidden.calls = []
})

describe('the summary call has a limit and a stop (BL-622, C6)', () => {
  it.each([false, true])('forwards the exact Compact Stop signal to the hidden Codex worker (already stopped: %s)', async (alreadyStopped) => {
    const stop = new AbortController()
    if (alreadyStopped) stop.abort('stopped')
    const result = await generateModelSummary({
      userId: 'zcyield_user',
      agent: { ...AGENT, agentType: 'cli', cli_runtime: 'codex' } as any,
      choice: { modelMode: 'current', modelPresetId: null },
      prompt: 'Summarize this.',
      summaryHardMaxTokens: 500,
      abortSignal: stop.signal
    })
    expect(result.summary).toBe('Codex summary.')
    expect(hidden.calls).toHaveLength(1)
    expect(hidden.calls[0].abortSignal).toBe(stop.signal)
    expect(hidden.calls[0].abortSignal?.aborted).toBe(alreadyStopped)
    expect(model.calls).toHaveLength(0)
  })

  it('the limit is the Codex lane\'s 180 seconds', () => {
    expect(SUMMARY_CALL_LIMIT_MS).toBe(180_000)
  })

  it('a call that answers is unchanged, and carries a signal', async () => {
    const result = await summarize()

    expect(result.summary).toBe('A summary.')
    expect(model.calls[0].abortSignal).toBeInstanceOf(AbortSignal)
    expect(model.calls[0].abortSignal?.aborted).toBe(false)
  })

  it('the caller\'s stop ends a call that hangs', async () => {
    model.mode = 'hang'
    const stop = new AbortController()
    const pending = summarize(stop.signal)
    await vi.waitFor(() => expect(model.calls).toHaveLength(1))

    stop.abort('stopped')

    await expect(pending).rejects.toThrow('This operation was aborted')
    expect(model.calls[0].abortSignal?.aborted).toBe(true)
  })

  it('a call that hangs ends at the limit, and says so', async () => {
    vi.useFakeTimers()
    model.mode = 'hang'
    const pending = summarize()
    const settled = pending.catch((error) => error)
    await untilModelCalled()

    await vi.advanceTimersByTimeAsync(SUMMARY_CALL_LIMIT_MS - 1)
    expect(model.calls[0].abortSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    const error = await settled
    expect(error).toBeInstanceOf(SummaryCallLimitError)
    expect(error.message).toBe('The summary model did not answer within 180 seconds.')
  })

  it('a call with a caller\'s signal still ends at the limit', async () => {
    vi.useFakeTimers()
    model.mode = 'hang'
    const settled = summarize(new AbortController().signal).catch((error) => error)
    await untilModelCalled()

    await vi.advanceTimersByTimeAsync(SUMMARY_CALL_LIMIT_MS)

    expect(await settled).toBeInstanceOf(SummaryCallLimitError)
  })
})
