import { describe, expect, it } from 'vitest'
import {
  canonicalizePrimaryAgentRecord,
  normalizePrimaryAgentType,
} from './primaryAgentType'

describe('primaryAgentType utilities', () => {
  it('keeps canonical primary agent types unchanged', () => {
    expect(normalizePrimaryAgentType({ agentType: 'n8n' })).toBe('n8n')
    expect(normalizePrimaryAgentType({ agentType: 'api' })).toBe('api')
    expect(normalizePrimaryAgentType({ agentType: 'cli' })).toBe('cli')
  })

  it('maps legacy batshit direct agents to api', () => {
    expect(
      normalizePrimaryAgentType({
        agentType: 'batshit',
        batshitMode: 'direct',
      })
    ).toBe('api')
  })

  it('maps legacy batshit cli agents to cli', () => {
    expect(
      normalizePrimaryAgentType({
        agentType: 'batshit',
        batshitMode: 'cli',
      })
    ).toBe('cli')
  })

  it('maps legacy vercel-native agents to api when no cli hints exist', () => {
    expect(
      normalizePrimaryAgentType({
        mode: 'vercel-native',
        primary_model_provider: 'anthropic',
      })
    ).toBe('api')
  })

  it('maps legacy vercel-native agents with codex or claude-cli hints to cli', () => {
    expect(
      normalizePrimaryAgentType({
        mode: 'vercel-native',
        primary_model_provider: 'codex',
      })
    ).toBe('cli')

    expect(
      normalizePrimaryAgentType({
        mode: 'vercel-native',
        primary_model_connection: { id: 'claude-cli' },
      })
    ).toBe('cli')
  })

  it('canonicalizes records and removes legacy fields', () => {
    const record = canonicalizePrimaryAgentRecord({
      agentType: 'batshit',
      batshitMode: 'cli',
      n8nImplementation: 'enhanced',
      mode: 'vercel-native',
    })

    expect(record.agentType).toBe('cli')
    expect('batshitMode' in record).toBe(false)
    expect('n8nImplementation' in record).toBe(false)
    expect('mode' in record).toBe(false)
  })
})
