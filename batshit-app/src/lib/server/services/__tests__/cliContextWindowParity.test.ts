import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { ClaudeBridge } from '$lib/server/services/claudeBridge'
import { resolveAgentBudgetSettings } from '$lib/server/services/contextTokenPreview'
import { applyClaudeContextGuard } from '$lib/server/services/claudeContextGuard'
import { reportForCliSnapshot } from '$lib/utils/cliContextWindow'
import { summarizeContextUsage } from '$lib/utils/tokenPanel'

useRedisTestServer()
beforeEach(() => {
  for (const key of ['CLAUDE_CODE_DISABLE_1M_CONTEXT', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) vi.stubEnv(key, '')
})
afterEach(() => vi.unstubAllEnvs())

describe('BL-991 shared Claude context-window precedence', () => {
  it('keeps the matching runtime window across guard, preview budget and meter despite a smaller preset', async () => {
    const preset = { id: 'bl991-preset', provider: 'anthropic-claude-cli', modelId: 'claude-cli',
      connection: { type: 'direct', service: 'anthropic-claude-cli' }, contextWindow: 200_000, settings: {} }
    const agent = { id: 'bl991-agent', user_id: 'bl991-user', agentType: 'cli',
      primary_model_preset_id: preset.id, primary_model_provider: 'anthropic-claude-cli', primary_model_name: 'claude-cli',
      primary_model_connection: preset.connection, claude_settings: { permissionMode: 'default', model: 'sonnet' } }
    const report = reportForCliSnapshot({ runtime: 'claude', model: 'sonnet', actualModel: 'claude-sonnet-5',
      contextWindow: 1_000_000, evidence: 'runtime', disableClaude1M: false, reportedAt: 1 }, agent, preset.contextWindow)
    const snapshot = { id: 'bl991-snapshot', agentId: agent.id, createdAt: '2026-09-29T12:00:00Z',
      runtime: { runtimeId: 'claude', metadata: { cliContextWindow: report } } }
    await redis.set(`model:${preset.id}`, preset)
    await redis.set('session:bl991-session:execution_log', [snapshot])
    const bridge = new ClaudeBridge() as any
    const guard = await bridge.resolveContextGuardConfig({ agent, model: 'sonnet', selection: {
      model: 'sonnet', presetContextWindow: preset.contextWindow, settingsKey: report.settingsKey, priorReport: report
    } })
    const preview = await resolveAgentBudgetSettings(agent, 'bl991-session')
    const meter = summarizeContextUsage({ messages: [], snapshots: [snapshot], activeModel: preset, agent } as any)
    expect([guard.contextWindow, preview.contextLimit, meter.contextLimit]).toEqual([1_000_000, 1_000_000, 1_000_000])

    const reports = vi.fn()
    async function* stream() {
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-5' }
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 300_000, output_tokens: 1000 } } }
    }
    const trip = vi.fn()
    for await (const _event of applyClaudeContextGuard(stream(), { ...guard, onReport: reports, onTrip: trip })) { /* consume real wrapper */ }
    expect(trip).not.toHaveBeenCalled()
    // Identical init/model names add no newly observed runtime-window telemetry.
    expect(reports).not.toHaveBeenCalled()
  })

  it.each(['settings', 'cap'])('discards inherited evidence after a %s change', async change => {
    const agent = { id: 'changed-agent', claude_settings: { permissionMode: 'default', model: 'sonnet' } }
    const report = reportForCliSnapshot({ runtime: 'claude', model: 'sonnet', actualModel: 'claude-sonnet-5',
      contextWindow: 1_000_000, evidence: 'runtime', disableClaude1M: false }, agent, 200_000)
    if (change === 'cap') vi.stubEnv('CLAUDE_CODE_DISABLE_1M_CONTEXT', '1')
    const guard = await (new ClaudeBridge() as any).resolveContextGuardConfig({ agent, model: 'sonnet', selection: {
      model: 'sonnet', presetContextWindow: 200_000,
      settingsKey: change === 'settings' ? 'changed-selection' : report.settingsKey, priorReport: report
    } })
    expect(guard.contextWindow).toBe(200_000)
    expect(guard.reported).toBeNull()
  })

  it('matches a CLI default report even when the primary label says claude', async () => {
    const agent = { id: 'default-agent', agentType: 'cli', primary_model_provider: 'anthropic-claude-cli',
      primary_model_name: 'claude', claude_settings: { permissionMode: 'default', model: null } }
    const report = reportForCliSnapshot({ runtime: 'claude', model: 'default', actualModel: 'claude-sonnet-5',
      contextWindow: 1_000_000, evidence: 'runtime', disableClaude1M: false }, agent)
    const snapshot = { id: 'default-run', agentId: agent.id, createdAt: '2026-09-29T12:00:00Z',
      runtime: { runtimeId: 'claude', metadata: { cliContextWindow: report } } }
    await redis.set('session:default-session:execution_log', [snapshot])
    const guard = await (new ClaudeBridge() as any).resolveContextGuardConfig({ agent, model: null, selection: {
      model: null, presetContextWindow: null, settingsKey: report.settingsKey, priorReport: report
    } })
    const budget = await resolveAgentBudgetSettings(agent, 'default-session')
    const meter = summarizeContextUsage({ messages: [], snapshots: [snapshot], activeModel: null, agent } as any)
    expect([guard.contextWindow, budget.contextLimit, meter.contextLimit]).toEqual([1_000_000, 1_000_000, 1_000_000])
  })

  it('discards inherited telemetry when the actual concrete model changes', async () => {
    const reported = { runtime: 'claude' as const, model: 'sonnet', actualModel: 'claude-sonnet-5',
      contextWindow: 1_000_000, evidence: 'runtime' as const, disableClaude1M: false }
    const reports = vi.fn()
    const trip = vi.fn()
    async function* stream() {
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-4-5-20250929' }
      yield { type: 'assistant', message: { model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 170_000 } } }
    }
    await expect((async () => {
      for await (const _event of applyClaudeContextGuard(stream(), {
        contextWindow: 1_000_000, presetContextWindow: 200_000, model: 'sonnet', threshold: 0.8,
        reported, onReport: reports, onTrip: trip
      })) { /* consume */ }
    })()).rejects.toThrow('200,000')
    expect(reports).toHaveBeenCalledWith(expect.objectContaining({ evidence: 'resolved', contextWindow: 200_000 }))
    expect(trip).toHaveBeenCalledOnce()
  })

  it('keeps fresh result telemetry as the baseline for subsequent assistant events', async () => {
    const reports = vi.fn()
    async function* stream() {
      yield { type: 'system', subtype: 'init', model: 'claude-sonnet-5' }
      yield { type: 'result', modelUsage: { 'claude-sonnet-5': { contextWindow: 500_000 } } }
      yield { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 450_000 } } }
    }
    await expect((async () => {
      for await (const _event of applyClaudeContextGuard(stream(), {
        contextWindow: 1_000_000, presetContextWindow: 200_000, model: 'sonnet', threshold: 0.8,
        reported: { runtime: 'claude', model: 'sonnet', actualModel: 'claude-sonnet-5',
          contextWindow: 1_000_000, evidence: 'runtime', disableClaude1M: false },
        onReport: reports, onTrip: vi.fn()
      })) { /* consume */ }
    })()).rejects.toThrow('500,000')
    expect(reports).toHaveBeenCalledOnce()
    expect(reports).toHaveBeenCalledWith(expect.objectContaining({ evidence: 'runtime', contextWindow: 500_000 }))
  })
})
