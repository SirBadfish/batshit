import { describe, expect, it } from 'vitest'

import { buildInlineCoolToolStep } from './buildInlineCoolToolStep'

describe('buildInlineCoolToolStep', () => {
  it('preserves normalized skill_read identity for inline native-pack tool data', () => {
    const inlineStep = buildInlineCoolToolStep(
      {
        toolName: 'batshit Native Tools',
        toolArgs: {
          action: 'read',
          skillId: 'agent_browser',
          path: '/Users/example/batshit/.agents/skills/agent-browser/SKILL.md'
        },
        toolResult: {
          action: 'read',
          skillId: 'agent_browser',
          skillName: 'Agent Browser',
          content: '# Agent Browser'
        },
        operationKind: 'skill_read',
        rendererFamily: 'skill_read',
        metadata: {
          toolProvider: 'batshit-server'
        }
      },
      'batshit Native Tools'
    )

    expect(inlineStep).toMatchObject({
      toolName: 'batshit Native Tools',
      originalToolName: 'batshit Native Tools',
      operationKind: 'skill_read',
      rendererFamily: 'skill_read',
      toolArgs: {
        action: 'read',
        skillId: 'agent_browser',
        path: '/Users/example/batshit/.agents/skills/agent-browser/SKILL.md'
      },
      toolResult: {
        action: 'read',
        skillId: 'agent_browser',
        skillName: 'Agent Browser',
        content: '# Agent Browser'
      },
      observation: {
        action: 'read',
        skillId: 'agent_browser',
        skillName: 'Agent Browser',
        content: '# Agent Browser'
      },
      metadata: {
        toolProvider: 'batshit-server',
        operationKind: 'skill_read',
        rendererFamily: 'skill_read'
      }
    })
    expect(typeof inlineStep?.timestamp).toBe('string')
  })

  it('hoists normalized identity from metadata when tool data only carries the raw wrapper name', () => {
    const inlineStep = buildInlineCoolToolStep(
      {
        tool: 'batshit Native Tools',
        input: {
          action: 'read',
          skillId: 'agent_browser'
        },
        result: {
          action: 'read',
          skillName: 'Agent Browser'
        },
        metadata: {
          operationKind: 'skill_read',
          rendererFamily: 'skill_read',
          displayToolName: 'Skill Read'
        }
      },
      'batshit Native Tools'
    )

    expect(inlineStep).toMatchObject({
      toolName: 'batshit Native Tools',
      originalToolName: 'batshit Native Tools',
      displayToolName: 'Skill Read',
      operationKind: 'skill_read',
      rendererFamily: 'skill_read',
      toolArgs: {
        action: 'read',
        skillId: 'agent_browser'
      },
      toolResult: {
        action: 'read',
        skillName: 'Agent Browser'
      },
      metadata: {
        displayToolName: 'Skill Read',
        operationKind: 'skill_read',
        rendererFamily: 'skill_read'
      }
    })
  })
})
