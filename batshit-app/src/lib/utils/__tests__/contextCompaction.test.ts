import { describe, expect, it } from 'vitest'
import type { Message } from '$lib/stores/messages.svelte'
import {
  applyContextCompactionToMessages,
  buildCompactionTranscript,
  getSmartAutoCompactTriggerTokens,
  resolveCurrentModelCompactRuntime,
  resolveEffectiveAutoCompactSettings,
  selectMessagesForCompaction,
  type ContextCompactionEvent
} from '$lib/utils/contextCompaction'

function message(id: string, content = id): Message {
  return {
    id,
    session_id: 'session-1',
    user_id: 'user-1',
    role: id.startsWith('a') ? 'assistant' : 'user',
    content,
    timestamp: `2026-05-21T00:00:${id.length.toString().padStart(2, '0')}.000Z`,
    created_at: `2026-05-21T00:00:${id.length.toString().padStart(2, '0')}.000Z`
  }
}

describe('contextCompaction helpers', () => {
  it('uses the smart 15% trigger clamped between 30k and 80k tokens', () => {
    expect(getSmartAutoCompactTriggerTokens(128_000)).toBe(30_000)
    expect(getSmartAutoCompactTriggerTokens(400_000)).toBe(60_000)
    expect(getSmartAutoCompactTriggerTokens(1_000_000)).toBe(80_000)
  })

  it('resolves per-agent overrides over global defaults', () => {
    const resolved = resolveEffectiveAutoCompactSettings({
      global: {
        mode: 'ask',
        triggerMode: 'smart',
        modelMode: 'current',
        promptMode: 'default'
      },
      agent: {
        mode: 'auto',
        triggerMode: 'remaining_tokens',
        remainingTokens: 42_000,
        modelMode: 'preset',
        modelPresetId: 'preset-1',
        promptMode: 'custom',
        prompt: 'Compact carefully.'
      }
    })

    expect(resolved).toMatchObject({
      mode: 'auto',
      triggerMode: 'remaining_tokens',
      remainingTokens: 42_000,
      modelMode: 'preset',
      modelPresetId: 'preset-1',
      prompt: 'Compact carefully.'
    })
  })

  it('keeps the recent tail and protected live references out of the compact source set', () => {
    const messages = [
      message('u1', 'old'),
      message('a2', 'old assistant {{batshit-zip:zip-live:::tool execution}}'),
      message('u3', 'old user'),
      message('a4', 'recent assistant'),
      message('u5', 'recent user'),
      message('a6', 'recent assistant')
    ]

    const selection = selectMessagesForCompaction(messages, [], {
      keepTailMessages: 3,
      protections: { userUnzippedZipIds: ['zip-live'] }
    })

    expect(selection.sourceMessageIds).toEqual(['u1', 'u3'])
    expect(selection.protectedMessageIds).toEqual(['a2'])
    expect(selection.compactedThroughMessageId).toBe('u3')
  })

  it('compacts every eligible message by default instead of keeping a raw recent tail', () => {
    const messages = [
      message('u1', 'old'),
      message('a2', 'middle assistant'),
      message('u3', 'latest user')
    ]

    const selection = selectMessagesForCompaction(messages, [], {})

    expect(selection.sourceMessageIds).toEqual(['u1', 'a2', 'u3'])
    expect(selection.protectedMessageIds).toEqual([])
    expect(selection.compactedThroughMessageId).toBe('u3')
  })

  it('protects manually unzipped zip-control references from compaction', () => {
    const messages = [
      message('u1', 'old {{batshit-zip:zip_agent:::agent opened this}}'),
      message('a2', 'assistant')
    ]

    const selection = selectMessagesForCompaction(messages, [], {
      protections: { protectedUnzippedZipIds: ['zip_agent'] }
    })

    expect(selection.sourceMessageIds).toEqual(['a2'])
    expect(selection.protectedMessageIds).toEqual(['u1'])
  })

  it('replaces compacted messages with a permanent summary message', () => {
    const events: ContextCompactionEvent[] = [
      {
        id: 'compact-1',
        createdAt: '2026-05-21T12:00:00.000Z',
        mode: 'manual',
        agentId: 'agent-1',
        compactedThroughMessageId: 'a2',
        sourceMessageIds: ['u1', 'a2'],
        protectedMessageIds: [],
        compactedMessageCount: 2,
        protectedMessageCount: 0,
        sourceTokenEstimate: 100,
        summaryTokenEstimate: 10,
        modelMode: 'current',
        modelPresetId: null,
        modelLabel: 'Current model',
        provider: 'openai',
        modelId: 'gpt',
        promptVersion: 1,
        summary: 'User asked for compacting and the agent agreed.'
      }
    ]

    const compacted = applyContextCompactionToMessages(
      [message('u1'), message('a2'), message('u3')],
      events
    )

    expect(compacted.map((entry) => entry.id)).toEqual([
      'batshit_context_compact_summary_compact-1',
      'u3'
    ])
    expect(compacted[0].content).toContain('Context compact summary')
    expect(compacted[0].metadata?.contextCompactSummary).toBe(true)
  })

  it('includes tool results summaries in the compact transcript', () => {
    const source = message('a1', 'Search output was zipped.')
    source.metadata = {
      zipControl: {
        toolResultsSummary: [
          { toolName: 'web_search', summary: 'The answer was found in the official docs.' }
        ]
      }
    }

    expect(buildCompactionTranscript([source])).toContain(
      'web_search: The answer was found in the official docs.'
    )
  })

  it('routes current-model compaction to the Codex CLI worker for Codex CLI agents', () => {
    expect(
      resolveCurrentModelCompactRuntime({
        agentType: 'cli',
        primary_model_provider: 'openai-codex',
        primary_model_connection: { id: 'codex-cli' }
      })
    ).toBe('codex-cli')
    expect(
      resolveCurrentModelCompactRuntime({
        agentType: 'cli',
        primary_model_provider: 'anthropic-claude-cli',
        primary_model_connection: { id: 'claude-cli' }
      })
    ).toBe('claude-cli')
    expect(resolveCurrentModelCompactRuntime({ agentType: 'api' })).toBe('api')
    expect(resolveCurrentModelCompactRuntime({ agentType: 'n8n' })).toBe('n8n')
  })
})
