import { afterEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'

/**
 * BL-622 (rule C6): a summary call on the API lane has a limit and can be stopped. A Compact and a
 * nap wait on it; with neither, a model that never answered kept the Compact busy for good.
 */

const model = vi.hoisted(() => ({
  calls: [] as Array<{ abortSignal?: AbortSignal }>,
  /** How the stubbed model answers: at once, or only when its signal aborts. */
  mode: 'answer' as 'answer' | 'hang'
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
  vi.restoreAllMocks()
  model.calls = []
  model.mode = 'answer'
})

describe('the summary call has a limit and a stop (BL-622, C6)', () => {
  const CODEX_CLI = 'Codex CLI agents were removed from Batshit.'
  const CLAUDE_CLI = 'The Claude Code CLI lane was removed from Batshit.'
  /** An ordinary API compact preset, so a preset-mode Compact that is not refused reaches the model. */
  const API_COMPACT_PRESET = {
    id: 'compact_preset', modelId: 'gpt-test', modelName: 'GPT Test', provider: 'openai', pricing: {},
    connection: { id: 'direct:openai', type: 'direct', service: 'openai' }
  }
  const RETIRED_RECORDS = [
    ['names Codex CLI', { agentType: 'cli', primary_model_provider: 'codex', primary_model_connection: { id: 'codex-cli', type: 'direct', service: 'openai-codex' } }, CODEX_CLI],
    ['names no CLI lane', { agentType: 'cli', primary_model_provider: '', primary_model_connection: null }, CLAUDE_CLI],
    ['is on the Claude Code CLI lane', { agentType: 'cli', primary_model_provider: 'anthropic-claude-cli', primary_model_name: 'claude-cli',
      primary_model_connection: { id: 'claude-cli', type: 'direct', service: 'anthropic-claude-cli' } }, CLAUDE_CLI]
  ] as const

  // SA-139 R4 (D14): a retired Primary type is refused in BOTH modes, before any model call; the
  // saved-preset mode would otherwise compact it on an ordinary API preset.
  it.each(RETIRED_RECORDS.flatMap(([name, fields, sentence]) => (['current', 'preset'] as const).map((mode) => [mode, name, fields, sentence] as const)))(
    'SA-139 R4: a %s-model Compact of a CLI agent that %s refuses readably and calls no model', async (mode, _name, fields, sentence) => {
      const presetRead = vi.spyOn(redis, 'get').mockResolvedValue(API_COMPACT_PRESET as never)
      const failure = await generateModelSummary({
        userId: 'zcyield_user',
        agent: { ...AGENT, ...fields } as any,
        choice: mode === 'preset' ? { modelMode: 'preset', modelPresetId: 'compact_preset' } : { modelMode: 'current', modelPresetId: null },
        prompt: 'Summarize this.',
        summaryHardMaxTokens: 500
      }).catch((error) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure.message).toContain(sentence)
      expect(model.calls).toHaveLength(0)
      expect(presetRead).not.toHaveBeenCalled()
    })

  it('SA-139 R4: an API agent compacts through the same saved API preset (the refusal above is by type)', async () => {
    const presetRead = vi.spyOn(redis, 'get').mockResolvedValue(API_COMPACT_PRESET as never)
    const result = await generateModelSummary({
      userId: 'zcyield_user',
      agent: AGENT as any,
      choice: { modelMode: 'preset', modelPresetId: 'compact_preset' },
      prompt: 'Summarize this.',
      summaryHardMaxTokens: 500
    })
    expect(result.summary).toBe('A summary.')
    expect(presetRead).toHaveBeenCalledWith('model:compact_preset')
    expect(model.calls).toHaveLength(1)
  })

  it('SA-139 R1: an API agent whose OpenAI model id contains "codex" compacts on the API lane', async () => {
    const result = await generateModelSummary({
      userId: 'zcyield_user',
      agent: { ...AGENT, primary_model_name: 'gpt-5-codex' } as any,
      choice: { modelMode: 'current', modelPresetId: null },
      prompt: 'Summarize this.',
      summaryHardMaxTokens: 500
    })
    expect(result.summary).toBe('A summary.')
    expect(model.calls).toHaveLength(1)
  })

  // SA-139 R3 (Faye S12): the retired Codex CLI is named by its exact ids. A custom provider whose
  // slug contains "codex" is an ordinary API selection, so its Compact runs instead of being refused
  // with "Compact cannot run through CLI model presets, which Batshit no longer supports".
  it('SA-139 R3: an API agent on a custom provider whose slug contains "codex" compacts on the API lane', async () => {
    const result = await generateModelSummary({
      userId: 'zcyield_user',
      agent: { ...AGENT, primary_model_provider: 'custom_codex_gw', primary_model_name: 'gw-model',
        primary_model_connection: { id: 'direct:custom_codex_gw', type: 'direct', service: 'custom_codex_gw' } } as any,
      choice: { modelMode: 'current', modelPresetId: null },
      prompt: 'Summarize this.',
      summaryHardMaxTokens: 500
    })
    expect(result.summary).toBe('A summary.')
    expect(model.calls).toHaveLength(1)
  })

  it('the limit is 180 seconds', () => {
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
