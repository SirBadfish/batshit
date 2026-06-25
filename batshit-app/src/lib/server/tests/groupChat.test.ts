/**
 * Group Chat Utils Tests - Story 7.7
 */

import { describe, it, expect } from 'vitest'
import {
  buildGroupSystemPromptAddendum,
  buildInterAgentPrompt,
  buildSpeakPolicyInstructions,
  isAgentAddressed,
  matchesTopic,
  normalizeGroupChatConfig,
  parseLeadingGroupControlFromBuffer,
  stripGroupChatPresentationControls,
  stripRepeatedLeadingGroupControlBlocks
} from '$lib/server/services/groupChatUtils'
import {
  GROUP_CHAT_MAX_FOLLOWUPS_TOTAL,
  GROUP_CHAT_MIN_AGENT_COUNT,
  GROUP_CHAT_SESSION_DEFAULTS
} from '$lib/types/groupChat'

describe('Group chat utils', () => {
  it('normalizes session config and enforces defaults', () => {
    const config = normalizeGroupChatConfig({
      enabled: 'yes',
      layout: 'parallel',
      agent_ids: ['agent-a', '', 'agent-a', 42],
      agent_settings: 'bad'
    })

    expect(config).not.toBeNull()
    expect(config?.enabled).toBe(true)
    expect(config?.layout).toBe('interleaved')
    expect(config?.agent_ids).toEqual(['agent-a'])
    expect(config?.agent_settings).toEqual({})
    expect(config?.max_followups_total).toBe(
      GROUP_CHAT_SESSION_DEFAULTS.max_followups_total
    )
  })

  it('returns null when config is invalid', () => {
    expect(normalizeGroupChatConfig(null)).toBeNull()
    expect(normalizeGroupChatConfig('bad')).toBeNull()
  })

  it('sanitizes follow-up and max-agent values', () => {
    const config = normalizeGroupChatConfig({
      enabled: true,
      agent_ids: ['agent-a', 'agent-b', 'agent-c'],
      max_followups_total: GROUP_CHAT_MAX_FOLLOWUPS_TOTAL + 50,
      max_agents: 1
    })

    expect(config?.max_followups_total).toBe(GROUP_CHAT_MAX_FOLLOWUPS_TOTAL)
    expect(config?.max_agents).toBe(GROUP_CHAT_MIN_AGENT_COUNT)

    const unlimitedConfig = normalizeGroupChatConfig({
      enabled: true,
      agent_ids: ['agent-a', 'agent-b'],
      max_followups_total: -10
    })

    expect(unlimitedConfig?.max_followups_total).toBe(0)
  })

  it('builds speak policy instructions with topics', () => {
    const instructions = buildSpeakPolicyInstructions('topic_only', ['redis', 'svelte'])
    expect(instructions).toContain('topic-only')
    expect(instructions).toContain('redis, svelte')
  })

  it('detects direct agent mentions', () => {
    expect(isAgentAddressed('Hey @Nova can you check?', 'Nova')).toBe(true)
    expect(isAgentAddressed('Nova, your thoughts?', 'Nova')).toBe(true)
    expect(isAgentAddressed('Please ask @nova_prime to review', 'Nova Prime', ['nova_prime'])).toBe(
      true
    )
    expect(isAgentAddressed('Innovation notes for tomorrow', 'Nova')).toBe(false)
    expect(isAgentAddressed('Hello there', 'Nova')).toBe(false)
  })

  it('matches topic filters', () => {
    expect(matchesTopic('Talk about Redis patterns', ['redis'])).toBe(true)
    expect(matchesTopic('Talk about Redis patterns', ['svelte'])).toBe(false)
    expect(matchesTopic('Nothing here', [])).toBe(false)
  })

  it('builds inter-agent prompt with agent context', () => {
    const prompt = buildInterAgentPrompt({ sourceAgentName: 'Jen', message: 'Hello there' })
    expect(prompt).toContain('Jen')
    expect(prompt).toContain('Hello there')
  })

  it('builds group system prompt addendum', () => {
    const addendum = buildGroupSystemPromptAddendum({
      agentName: 'Nova',
      policy: 'balanced',
      topics: ['zip', 'tools'],
      eventIndex: 1,
      driverMode: true,
      driverAgentName: 'Atlas',
      isDriver: false
    })

    expect(addendum).toContain('GROUP CHAT MODE')
    expect(addendum).toContain('Nova')
    expect(addendum).toContain('Event 1')
    expect(addendum).toContain('Control contract (required)')
    expect(addendum).toContain('First non-whitespace output must be exactly one <batshit-group> JSON block')
    expect(addendum).toContain('Group chat does not support Goon mood/cue controls')
    expect(addendum).toContain('Do not emit <batshit-cue>')
    expect(addendum).toContain('Speaking preset: balanced')
    expect(addendum).toContain('Atlas is the default first responder for user turns')
  })

  it('parses the required leading group control block', () => {
    const parsed = parseLeadingGroupControlFromBuffer(
      ' \n<batshit-group>{"mode":"listening"}</batshit-group>\nDo not show me'
    )

    expect(parsed).toEqual({
      kind: 'control',
      mode: 'listening',
      payload: { mode: 'listening' },
      remaining: '\nDo not show me'
    })
  })

  it('ignores unsupported leading cue markup before the group control block', () => {
    const parsed = parseLeadingGroupControlFromBuffer(
      [
        '<batshit-cue>{"mood":"playful"}</batshit-cue>',
        '<emote-wink>.</emote-wink>',
        '*goon: wave*',
        '<batshit-group>{"mode":"listening"}</batshit-group>',
        'Do not show me'
      ].join('\n')
    )

    expect(parsed).toEqual({
      kind: 'control',
      mode: 'listening',
      payload: { mode: 'listening' },
      remaining: '\nDo not show me'
    })
  })

  it('keeps buffering incomplete group control prefixes', () => {
    expect(parseLeadingGroupControlFromBuffer('<batshit-g')).toEqual({ kind: 'pending' })
    expect(parseLeadingGroupControlFromBuffer('<batshit-group>{"mode":"')).toEqual({
      kind: 'pending'
    })
  })

  it('does not accept retired generic Batshit control tags for group decisions', () => {
    const retiredTag = ['batshit', 'controls'].join('_')
    const content = `<${retiredTag}>{"mode":"listening"}</${retiredTag}>`
    const parsed = parseLeadingGroupControlFromBuffer(content)

    expect(parsed).toEqual({
      kind: 'passthrough',
      content
    })
  })

  it('strips repeated leading group controls from repeated model text chunks', () => {
    const cleaned = stripRepeatedLeadingGroupControlBlocks(
      [
        '<batshit-group>{"mode":"responding"}</batshit-group>',
        '<batshit-group>{"mode":"responding"}</batshit-group>',
        'Visible reply.'
      ].join('')
    )

    expect(cleaned).toBe('Visible reply.')
  })

  it('strips presentation cue markup from group chat assistant content', () => {
    const cleaned = stripGroupChatPresentationControls(
      [
        '<batshit-cue>{"mood":"playful"}</batshit-cue>',
        '<emote-wink>.</emote-wink>',
        '*goon: wave*',
        'Visible group reply.'
      ].join('\n')
    )

    expect(cleaned).toBe('Visible group reply.')
  })
})
