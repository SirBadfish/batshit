import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

function compact(agent: Record<string, unknown>, choice = { modelMode: 'current' as const, modelPresetId: null as string | null }) {
  return generateModelSummary({
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
})

describe('a "current model" compact runs on the preset the agent names (BL-801)', () => {
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
    ['Codex', { provider: 'openai-codex', modelId: 'codex/codex-cli', connection: { id: 'codex-cli', type: 'direct', service: 'codex' } }],
    ['Claude', { provider: 'anthropic-claude-cli', modelId: 'claude/claude-cli', connection: { id: 'claude-cli', type: 'direct', service: 'claude' } }]
  ])('refuses loudly an API agent whose named preset is a %s CLI preset, and calls no model', async (_name, cli) => {
    await redis.set('model:preset-live', { ...LIVE_PRESET, ...cli, settings: {} } as any)

    const failure = await compact(agentNamingPreset()).catch((error) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('Compact cannot run through CLI model presets yet')
    expect(model.getModelCalls).toHaveLength(0)
    expect(model.generateCalls).toHaveLength(0)
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
