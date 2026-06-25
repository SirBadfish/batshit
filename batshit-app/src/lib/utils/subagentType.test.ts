import { describe, expect, it } from 'vitest'
import {
  canonicalizeSubagentRecord,
  getCompatibleSubagentTypesForPrimaryAgent,
  isSubagentCompatibleWithPrimaryAgent,
  normalizeSubagentType,
} from './subagentType'

describe('subagentType utilities', () => {
  it('keeps canonical subagent types unchanged', () => {
    expect(normalizeSubagentType(undefined, 'n8n-subnode')).toBe('n8n-subnode')
    expect(normalizeSubagentType(undefined, 'n8n-workflow')).toBe('n8n-workflow')
    expect(normalizeSubagentType(undefined, 'api')).toBe('api')
    expect(normalizeSubagentType(undefined, 'cli')).toBe('cli')
  })

  it('maps legacy n8n and batshit values to the SA-062 taxonomy', () => {
    expect(normalizeSubagentType(undefined, 'n8n')).toBe('n8n-subnode')
    expect(normalizeSubagentType(undefined, 'batshit')).toBe('n8n-workflow')
  })

  it('falls back to workflow-backed when a webhook target exists', () => {
    expect(
      normalizeSubagentType({
        webhook_url: 'http://localhost:5678/webhook/subagent-runner',
      })
    ).toBe('n8n-workflow')
  })

  it('returns the full SA-062 compatibility matrix', () => {
    expect(getCompatibleSubagentTypesForPrimaryAgent('n8n')).toEqual(['n8n-subnode'])
    expect(getCompatibleSubagentTypesForPrimaryAgent('api')).toEqual([
      'n8n-workflow',
      'api',
      'cli',
    ])
    expect(getCompatibleSubagentTypesForPrimaryAgent('cli')).toEqual([
      'n8n-workflow',
      'api',
      'cli',
    ])
  })

  it('checks compatibility against canonicalized types', () => {
    expect(isSubagentCompatibleWithPrimaryAgent('n8n', 'n8n-subnode')).toBe(true)
    expect(isSubagentCompatibleWithPrimaryAgent('n8n', 'n8n-workflow')).toBe(false)
    expect(isSubagentCompatibleWithPrimaryAgent('api', 'n8n-workflow')).toBe(true)
    expect(isSubagentCompatibleWithPrimaryAgent('api', 'api')).toBe(true)
    expect(isSubagentCompatibleWithPrimaryAgent('api', 'cli')).toBe(true)
    expect(isSubagentCompatibleWithPrimaryAgent('cli', 'n8n-workflow')).toBe(true)
    expect(isSubagentCompatibleWithPrimaryAgent('cli', 'api')).toBe(true)
    expect(isSubagentCompatibleWithPrimaryAgent('cli', 'cli')).toBe(true)
  })

  it('canonicalizes records and removes the snake_case field', () => {
    const record = canonicalizeSubagentRecord({
      subagent_type: 'batshit',
      webhook_url: 'http://localhost:5678/webhook/subagent-runner',
    })

    expect(record.subagentType).toBe('n8n-workflow')
    expect('subagent_type' in record).toBe(false)
  })
})
