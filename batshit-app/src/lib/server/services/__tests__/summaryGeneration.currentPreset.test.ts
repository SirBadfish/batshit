import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reasoningOverrideKey } from '$lib/utils/modelReasoningControls'

/**
 * BL-801: a Compact (or a nap) on the agent's "current model" runs on the preset the agent NAMES,
 * read fresh, the way the send path does since BL-515.
 *
 * `resolveSummaryModel` used to read the agent's copied `primary_model_*` values, its copied
 * connection and its `provider_specific_settings` for a "current model" run. Those are what the
 * model picker stored when the preset was picked, so a preset edited since (another connection, a
 * cleared temperature) was not what the Compact ran on. An agent that names a preset whose record is
 * gone now fails loudly with the send path's own error; an agent that names none keeps its copies.
 */

const model = vi.hoisted(() => ({
  generateCalls: [] as Array<Record<string, any>>,
  getModelCalls: [] as Array<{ id: string; options: Record<string, any> }>
}))

vi.mock('ai', () => ({
  generateText: vi.fn(async (options: Record<string, any>) => {
    model.generateCalls.push(options)
    return { text: 'A summary.' }
  })
}))

vi.mock('$lib/server/services/providers', () => ({
  ProviderManager: {
    createForUser: vi.fn(async () => ({
      getModel: (id: string, options: Record<string, any>) => {
        model.getModelCalls.push({ id, options })
        return { modelId: id }
      }
    }))
  }
}))

// SA-139: this build has the Claude plan runtime, so admission reads Claude Code; this fixture reads a signed-out
// stand-in and never the machine's own Claude Code.
vi.mock('$lib/server/services/claudePlanReadiness', () => ({
  readClaudePlanReadiness: vi.fn(async () => ({ state: 'unavailable', code: 'signed_out', reason: 'Claude Code is signed out, so the Claude plan connection cannot start (test).' }))
}))
const { redis } = await import('$lib/server/redis')
const { generateModelSummary } = await import('../summaryGeneration')
const { RuntimeModelPresetError } = await import('../runtimeModelPreset')

const LIVE_PRESET = {
  id: 'preset-live',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-5',
  connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' },
  settings: { temperature: 0.3 }
}

/** An agent whose copied model values are what the picker stored for an OLDER preset. */
function agentNamingPreset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bl801_agent',
    agentType: 'api',
    primary_model_preset_id: 'preset-live',
    primary_model_provider: 'openai',
    primary_model_name: 'gpt-old',
    primary_model_connection: { id: 'direct:openai', type: 'direct', service: 'openai' },
    primary_model_capabilities: null,
    primary_model_temperature: 1.5,
    primary_model_max_tokens: 999,
    primary_model_top_p: 0.5,
    provider_specific_settings: { temperature: 1.2, topP: 0.5, nativeTools: { bashEnabled: false } },
    ...overrides
  }
}

function compact(agent: Record<string, unknown>, choice = { modelMode: 'current' as const, modelPresetId: null as string | null }, extra: Record<string, unknown> = {}) {
  return generateModelSummary({
    ...extra,
    userId: 'bl801_user',
    agent: agent as any,
    choice,
    prompt: 'Summarize this.',
    summaryHardMaxTokens: 5_000
  })
}

beforeEach(async () => {
  await redis.set('model:preset-live', LIVE_PRESET as any)
})

afterEach(async () => {
  await redis.del('model:preset-live')
  await redis.del('model:preset-compact')
  model.generateCalls = []
  model.getModelCalls = []
  await redis.del('local_provider:bl801_user:ollama')
  vi.unstubAllGlobals()
})

describe('a "current model" compact runs on the preset the agent names (BL-801)', () => {
  it('SA-139 (D1, M1, P4): a Claude plan preset of any spelling is not a CLI preset, never reaches a paid client, and runs only as Compact', async () => {
    for (const connection of [{ id: 'claude-plan:local', type: 'direct', service: 'claude-plan' }, { id: 'claude-plan:local', type: 'direct' }, { id: 'direct:claude-plan', type: 'direct' }]) {
      await redis.set('model:preset-live', { id: 'preset-live', provider: 'anthropic', modelId: 'claude-opus-5-5', effectiveModelId: 'claude-opus-5-5', pricing: {},
        connection, settings: { anthropicEffort: 'high' } } as any)
      // Another summary caller (memory graduation, a nap) passes no Compact owner: refused by name.
      const other = await compact(agentNamingPreset()).then(() => null, error => error)
      expect(other).toMatchObject({ name: 'ClaudePlanError', status: 409, code: 'consumer_unsupported' })
      expect(other.message).toMatch(/This summary feature cannot use the Claude plan/)
      expect(other.message).not.toMatch(/CLI model presets/)
      // Compact itself is admitted up to Claude Code's readiness, which refuses readably before any run.
      const failure = await compact(agentNamingPreset(), undefined, { claudePlanCompact: { sessionId: 'bl801_session' } }).then(() => null, error => error)
      // Admission's identity check refuses a half-named spelling; the exact one reaches the readiness check.
      const exact = connection.id === 'claude-plan:local' && 'service' in connection
      expect(failure).toMatchObject({ name: 'ClaudePlanError', status: 409, code: exact ? 'connection_unavailable' : 'connection_invalid' })
      if (exact) expect(failure.message).toBe('Claude Code is signed out, so the Claude plan connection cannot start (test).')
    }
    expect(model.getModelCalls).toEqual([])
  })

  it('captures one selected local snapshot for current-model Compact, using the actual tag rather than its catalog ID', async () => {
    const connection = { type: 'direct' as const, id: 'direct:ollama', service: 'ollama' }, effectiveModelId = 'qwen3.5:9b-q4_K_M'
    const key = reasoningOverrideKey({ presetId: LIVE_PRESET.id, connection, effectiveModelId }, 'thinking')
    await redis.set('model:preset-live', { ...LIVE_PRESET, provider: 'qwen', modelId: 'catalog/qwen-local', effectiveModelId, connection,
      capabilities: { reasoning: false }, settings: { temperature: 0, 'ollama.options.top_k': 1 } } as any)
    await redis.set('local_provider:bl801_user:ollama', { id: 'ollama', enabled: true, baseUrl: 'http://local-model.test', openaiPath: '/v1', imageTransport: 'auto' })
    const http = vi.fn(async (url: string) => Response.json(url.endsWith('/api/version') ? { version: '0.40.3' }
      : { capabilities: ['thinking'], thinking: { values: [false, true], default: true } }))
    vi.stubGlobal('fetch', http)
    const agent = agentNamingPreset({ model_reasoning_overrides: { [key]: { mode: 'provider-default' } } })
    await compact(agent)
    expect(http).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String((http.mock.calls[1] as any)[1].body))).toEqual({ model: effectiveModelId, verbose: false })
    expect(model.getModelCalls[0].id).toBe(effectiveModelId)
    const options = model.generateCalls[0].providerOptions
    expect(options.ollama).toEqual({ options: { top_k: 1 } })
    expect(options.batshit_reasoning.ollama).toMatchObject({ modelId: effectiveModelId, mode: 'provider-default', runtimeVersion: '0.40.3' })
    expect(options.batshit_reasoning.ollama.connectionKey).toMatch(/^[a-f0-9]{64}$/)
    expect(model.generateCalls[0].temperature).toBe(0)
    // An explicit summary preset is independent, even when it selects the same actual tag.
    await redis.set('model:preset-compact', { id: 'preset-compact', provider: 'qwen', modelId: 'catalog/other', effectiveModelId, connection, settings: {} } as any)
    http.mockClear()
    await compact(agent, { modelMode: 'preset', modelPresetId: 'preset-compact' })
    expect(http).not.toHaveBeenCalled()
    expect(model.generateCalls[1].providerOptions).toBeUndefined()
    // Clearing the primary override preserves legacy omission without requiring metadata.
    await compact(agentNamingPreset())
    expect(http).not.toHaveBeenCalled()
    expect(model.generateCalls[2].providerOptions).not.toHaveProperty('batshit_reasoning')
  })

  it('refuses a retained explicit local Compact choice before generation when discovery fails', async () => {
    const connection = { type: 'direct' as const, id: 'direct:ollama', service: 'ollama' }, effectiveModelId = 'qwen3.5:9b-q4_K_M'
    const key = reasoningOverrideKey({ presetId: LIVE_PRESET.id, connection, effectiveModelId }, 'thinking')
    await redis.set('model:preset-live', { ...LIVE_PRESET, provider: 'qwen', modelId: 'catalog/qwen-local', effectiveModelId, connection, settings: {} } as any)
    await redis.set('local_provider:bl801_user:ollama', { id: 'ollama', enabled: true, baseUrl: 'http://local-model.test', openaiPath: '/v1' })
    const http = vi.fn(async () => new Response('', { status: 503 }))
    vi.stubGlobal('fetch', http)
    const agent = agentNamingPreset({ model_reasoning_overrides: { [key]: { mode: 'value', value: true } } })
    await expect(compact(agent)).rejects.toThrow(/not verified|not supported/i)
    expect(http).toHaveBeenCalledTimes(1)
    expect(model.getModelCalls).toHaveLength(0)
    expect(model.generateCalls).toHaveLength(0)
    expect(agent.model_reasoning_overrides).toEqual({ [key]: { mode: 'value', value: true } })
  })

  it('calls the preset\'s model on the preset\'s connection, not the agent\'s copies', async () => {
    const result = await compact(agentNamingPreset())

    expect(model.getModelCalls).toHaveLength(1)
    expect(model.getModelCalls[0].id).toBe('claude-sonnet-4-5')
    expect(model.getModelCalls[0].options).toMatchObject({ transport: 'direct', service: 'anthropic' })
    expect(result).toMatchObject({ provider: 'anthropic', modelId: 'claude-sonnet-4-5' })
  })

  it('sends the live preset\'s values and none of the copies (a value cleared in the preset is not sent)', async () => {
    await compact(agentNamingPreset())

    expect(model.generateCalls).toHaveLength(1)
    const call = model.generateCalls[0]
    expect(call.temperature).toBe(0.3)
    // The agent's copies (top p 0.5, max tokens 999, penalty-free) are not the preset's values.
    expect(call).not.toHaveProperty('topP')
    // No max tokens in the preset: the operational summary bound applies, not the agent's 999.
    expect(call.maxOutputTokens).toBe(5_000)
  })

  it('sends a temperature of 0: zero is a real value', async () => {
    await redis.set('model:preset-live', { ...LIVE_PRESET, settings: { temperature: 0 } } as any)

    await compact(agentNamingPreset())

    expect(model.generateCalls[0].temperature).toBe(0)
  })

  it('follows the preset when it moves to another connection', async () => {
    await redis.set('model:preset-live', {
      ...LIVE_PRESET,
      connection: { id: 'openrouter', type: 'openrouter', service: 'openrouter' }
    } as any)

    await compact(agentNamingPreset())

    expect(model.getModelCalls[0].options).toMatchObject({ transport: 'openrouter', service: 'openrouter' })
  })

  it('fails loudly when the named preset no longer exists, and calls no model', async () => {
    await redis.del('model:preset-live')

    const failure = await compact(agentNamingPreset()).catch((error) => error)

    expect(failure).toBeInstanceOf(RuntimeModelPresetError)
    expect(failure).toMatchObject({ code: 'model_preset_missing', status: 400 })
    expect(model.getModelCalls).toHaveLength(0)
    expect(model.generateCalls).toHaveLength(0)
  })

  it('an agent that names no preset keeps its own copies', async () => {
    const result = await compact(
      agentNamingPreset({
        primary_model_preset_id: undefined,
        primary_model_max_tokens: 999,
        provider_specific_settings: { temperature: 1.2 }
      })
    )

    expect(model.getModelCalls[0].id).toBe('gpt-old')
    expect(model.getModelCalls[0].options).toMatchObject({ transport: 'direct', service: 'openai' })
    expect(model.generateCalls[0].temperature).toBe(1.2)
    expect(model.generateCalls[0].maxOutputTokens).toBe(999)
    expect(result.modelId).toBe('gpt-old')
  })

  it('a stored null on an agent that names no preset is absent, not sent (BL-515\'s rule)', async () => {
    await compact(
      agentNamingPreset({
        primary_model_preset_id: undefined,
        primary_model_temperature: null,
        primary_model_top_p: null,
        provider_specific_settings: null
      })
    )

    expect(model.generateCalls[0]).not.toHaveProperty('temperature')
    expect(model.generateCalls[0]).not.toHaveProperty('topP')
  })

  it.each([
    ['retired Codex', { provider: 'openai-codex', modelId: 'codex/codex-cli', connection: { id: 'codex-cli', type: 'direct', service: 'codex' } }],
    ['Claude', { provider: 'anthropic-claude-cli', modelId: 'claude/claude-cli', connection: { id: 'claude-cli', type: 'direct', service: 'claude' } }]
  ])('refuses loudly an API agent whose named preset is a %s CLI preset, and calls no model', async (_name, cli) => {
    await redis.set('model:preset-live', { ...LIVE_PRESET, ...cli, settings: {} } as any)

    const failure = await compact(agentNamingPreset()).catch((error) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('Compact cannot run through CLI model presets, which Batshit no longer supports.')
    expect(model.getModelCalls).toHaveLength(0)
    expect(model.generateCalls).toHaveLength(0)
  })

  it('SA-139 R1: an API preset whose OpenAI model id contains "codex" is an ordinary API model and compacts', async () => {
    await redis.set('model:preset-live', { ...LIVE_PRESET, provider: 'openai', modelId: 'gpt-5-codex',
      connection: { id: 'direct:openai', type: 'direct', service: 'openai' } } as any)

    const result = await compact(agentNamingPreset())

    expect(model.getModelCalls[0]).toMatchObject({ id: 'gpt-5-codex', options: { transport: 'direct', service: 'openai' } })
    expect(model.generateCalls).toHaveLength(1)
    expect(result.modelId).toBe('gpt-5-codex')
  })

  it('an explicit compact preset still wins over the agent\'s named preset', async () => {
    await redis.set('model:preset-compact', {
      id: 'preset-compact',
      provider: 'mistral',
      modelId: 'mistral-small',
      connection: { id: 'direct:mistral', type: 'direct', service: 'mistral' },
      settings: { temperature: 0.9 }
    } as any)

    await compact(agentNamingPreset(), { modelMode: 'preset', modelPresetId: 'preset-compact' })

    expect(model.getModelCalls[0].id).toBe('mistral-small')
    expect(model.generateCalls[0].temperature).toBe(0.9)
  })
})
