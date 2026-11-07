import { describe, expect, it } from 'vitest'
import {
  canonicalizePrimaryAgentRecord,
  getPrimaryAgentSystemPromptRedisKey,
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

  it('maps legacy vercel-native agents with a Codex CLI or claude-cli hint to cli (a Codex CLI record stays cli so the send path refuses it as retired)', () => {
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
  // SA-106 DL-106-02: the retirement flip. These are the highest-risk lines in the
  // story — before SA-106 every one of these cases silently resolved to the dead lane.
  describe('SA-106 retirement (DL-106-02)', () => {
    it('resolves an unrecognised record to a LIVE type, never to the retired lane', () => {
      expect(normalizePrimaryAgentType({})).toBe('api')
      expect(normalizePrimaryAgentType(null)).toBe('api')
      expect(normalizePrimaryAgentType(undefined)).toBe('api')
      expect(normalizePrimaryAgentType({ agentType: 'something-unknown' })).toBe('api')
      expect(normalizePrimaryAgentType(undefined, 'not-a-type')).toBe('api')
    })

    it('still resolves an unrecognised record with CLI hints to cli', () => {
      expect(
        normalizePrimaryAgentType({ primary_model_provider: 'codex' })
      ).toBe('cli')
    })

    it('KEEPS resolving a genuine n8n record to the retired marker so the send guard fires', () => {
      expect(normalizePrimaryAgentType({ agentType: 'n8n' })).toBe('n8n')
      expect(normalizePrimaryAgentType(undefined, 'n8n')).toBe('n8n')
      expect(normalizePrimaryAgentType({ mode: 'n8n-native' })).toBe('n8n')
      expect(normalizePrimaryAgentType({ mode: 'batshit-enhanced' })).toBe('n8n')
    })

    it('does not let the getAgents canonicalize-on-read write-back convert a retired record', () => {
      // lib/server/redis.ts getAgents() json.set()s the canonicalized record back
      // whenever hasLegacyPrimaryAgentFields is true. A retired record must survive
      // that round trip as 'n8n' so DL-106-03's delete-not-convert posture holds.
      const record = canonicalizePrimaryAgentRecord({
        agentType: 'n8n',
        mode: 'n8n-native',
        webhook_url: 'http://localhost:5678/webhook/batshit_n8n_primary',
      })
      expect(record.agentType).toBe('n8n')
    })

    // SA-139 R4: the CLI Primary system prompt (`batshit_mode4_system_prompt`) left with the
    // Claude Code CLI Primary, so the one live type has the one base-system-prompt key.
    it('only exposes the base-system-prompt key for the one live type', () => {
      expect(getPrimaryAgentSystemPromptRedisKey('api')).toBe(
        'batshit:batshit_mode3_system_prompt'
      )
      expect(getPrimaryAgentSystemPromptRedisKey('cli' as never)).toBeUndefined()
    })
  })

  // SA-139 R1: the retired Codex CLI is named by provider or connection only. An OpenAI model id
  // that contains "codex" is an ordinary API model.
  describe('SA-139 R1 Codex CLI identity on legacy untyped records', () => {
    it('resolves a legacy untyped record whose model id is gpt-5-codex to api', () => {
      expect(normalizePrimaryAgentType({ primary_model_provider: 'openai', primary_model_name: 'gpt-5-codex' })).toBe('api')
      expect(normalizePrimaryAgentType({ mode: 'vercel-native', primary_model_provider: 'openai', primary_model_name: 'gpt-5-codex' })).toBe('api')
      expect(normalizePrimaryAgentType({ agentType: 'batshit', primary_model_name: 'gpt-5-codex', primary_model_connection: { id: 'direct:openai', service: 'openai' } })).toBe('api')
    })

    it('resolves a legacy untyped record whose provider is openai-codex to cli, where the send path refuses it as retired', () => {
      expect(normalizePrimaryAgentType({ primary_model_provider: 'openai-codex', primary_model_name: 'gpt-6.1-sol' })).toBe('cli')
      expect(normalizePrimaryAgentType({ primary_model_connection: { id: 'codex-cli' } })).toBe('cli')
    })

    // SA-139 R3 (Faye S12): exact retired ids, never a substring of a custom provider or connection.
    it('resolves a legacy untyped record on a custom provider whose slug contains codex to api', () => {
      expect(normalizePrimaryAgentType({ primary_model_provider: 'codex-proxy', primary_model_name: 'gpt-6.1-sol' })).toBe('api')
      expect(normalizePrimaryAgentType({ primary_model_connection: { id: 'custom:codex-proxy', service: 'codex-proxy' } })).toBe('api')
      // The shape a saved custom provider really has (`customProviders.ts`, `modelConnectionOptions.ts`).
      expect(normalizePrimaryAgentType({ primary_model_provider: 'custom_codex_gw', primary_model_name: 'gw-model',
        primary_model_connection: { id: 'direct:custom_codex_gw', type: 'direct', service: 'custom_codex_gw' } })).toBe('api')
    })
  })
})
