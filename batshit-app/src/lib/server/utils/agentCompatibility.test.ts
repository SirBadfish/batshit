import { describe, expect, it } from 'vitest'
import { getCompatibleSubagents, isSubagentCompatible } from './agentCompatibility'

describe('agentCompatibility', () => {
  const allSubagents = [
    { id: 'sa-1', displayName: 'Planner', subagentType: 'n8n-subnode' },
    { id: 'sa-2', displayName: 'Workflow Helper', subagentType: 'n8n-workflow' },
    { id: 'sa-3', displayName: 'API Builder', subagentType: 'api' },
    { id: 'sa-4', displayName: 'Codex Helper', subagentType: 'cli' },
  ]

  it('returns the SA-062 compatibility matrix', () => {
    expect(getCompatibleSubagents('n8n', allSubagents as any).compatible.map((item) => item.id)).toEqual([
      'sa-1',
    ])
    expect(getCompatibleSubagents('api', allSubagents as any).compatible.map((item) => item.id)).toEqual([
      'sa-2',
      'sa-3',
      'sa-4',
    ])
    expect(getCompatibleSubagents('cli', allSubagents as any).compatible.map((item) => item.id)).toEqual([
      'sa-2',
      'sa-3',
      'sa-4',
    ])
  })

  it('validates single subagent compatibility', () => {
    expect(isSubagentCompatible('n8n', 'n8n-subnode')).toBe(true)
    expect(isSubagentCompatible('n8n', 'api')).toBe(false)
    expect(isSubagentCompatible('api', 'api')).toBe(true)
    expect(isSubagentCompatible('api', 'cli')).toBe(true)
    expect(isSubagentCompatible('cli', 'n8n-workflow')).toBe(true)
    expect(isSubagentCompatible('cli', 'api')).toBe(true)
    expect(isSubagentCompatible('cli', 'cli')).toBe(true)
  })
})
