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
    expect(getCompatibleSubagentTypesForPrimaryAgent('n8n')).toEqual([])
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
    expect(isSubagentCompatibleWithPrimaryAgent('n8n', 'n8n-subnode')).toBe(false)
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
  // SA-106 DL-106-02: only the retired half of the terminal default changed. The
  // Category 2 halves (`n8n-workflow` via workflow target, and the legacy
  // batshit/mcp_agent mapping) must stay exactly as they were — a literal edit at the
  // wrong line here would delete a live Category 2 path.
  describe('SA-106 retirement (DL-106-02)', () => {
    it('resolves an unrecognised subagent record to a LIVE type', () => {
      expect(normalizeSubagentType({})).toBe('api')
      expect(normalizeSubagentType(null)).toBe('api')
      expect(normalizeSubagentType(undefined, 'not-a-type')).toBe('api')
    })

    it('KEEPS the Category 2 workflow-target resolution untouched', () => {
      expect(
        normalizeSubagentType({ webhook_url: 'http://localhost:5678/webhook/sub' })
      ).toBe('n8n-workflow')
      expect(normalizeSubagentType({ workflow_name: 'Some Workflow' })).toBe(
        'n8n-workflow'
      )
      expect(normalizeSubagentType(undefined, 'batshit')).toBe('n8n-workflow')
      expect(normalizeSubagentType(undefined, 'mcp_agent')).toBe('n8n-workflow')
    })

    it('KEEPS the legacy bare n8n alias pointing at the retired subnode type', () => {
      // A stored record must stay recognisable so it can be surfaced for deletion
      // (DL-106-04) rather than silently becoming a live subagent.
      expect(normalizeSubagentType(undefined, 'n8n')).toBe('n8n-subnode')
      expect(normalizeSubagentType({ subagentType: 'n8n' })).toBe('n8n-subnode')
    })
  })
})
