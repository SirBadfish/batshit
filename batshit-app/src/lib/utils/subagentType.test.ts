import { describe, expect, it } from 'vitest'
import {
  canonicalizeSubagentRecord,
  getCompatibleSubagentTypesForPrimaryAgent,
  isRetiredSubagentType,
  isSubagentCompatibleWithPrimaryAgent,
  normalizeSubagentType,
  retiredSubagentRefusal,
  retiredSubagentTypeMessage,
  retiredSubagentTypeSentences,
  SUBAGENT_TYPE_RETIRED_CODE,
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

  it('reads a typeless record with a webhook target as the removed Workflow type', () => {
    expect(
      normalizeSubagentType({
        webhook_url: 'http://localhost:5678/webhook/subagent-runner',
      })
    ).toBe('n8n-workflow')
  })

  it('offers only the API Subagent type to an API Primary, and none to a retired Primary (SA-139 R5)', () => {
    expect(getCompatibleSubagentTypesForPrimaryAgent('api')).toEqual(['api'])
    expect(getCompatibleSubagentTypesForPrimaryAgent('n8n')).toEqual([])
    expect(getCompatibleSubagentTypesForPrimaryAgent('cli')).toEqual([])
  })

  it('never treats a removed n8n or CLI Subagent type as compatible (D14 narrow refusal)', () => {
    for (const primary of ['n8n', 'api', 'cli'] as const) {
      expect(isSubagentCompatibleWithPrimaryAgent(primary, 'n8n-subnode')).toBe(false)
      expect(isSubagentCompatibleWithPrimaryAgent(primary, 'n8n-workflow')).toBe(false)
      expect(isSubagentCompatibleWithPrimaryAgent(primary, 'cli')).toBe(false)
      expect(
        isSubagentCompatibleWithPrimaryAgent(primary, {
          webhook_url: 'http://localhost:5678/webhook/sub'
        })
      ).toBe(false)
      expect(isSubagentCompatibleWithPrimaryAgent(primary, { subagentType: 'batshit' })).toBe(false)
      expect(isSubagentCompatibleWithPrimaryAgent(primary, { primary_model_provider: 'anthropic-claude-cli' })).toBe(false)
    }
    expect(isSubagentCompatibleWithPrimaryAgent('api', 'api')).toBe(true)
    // A leftover CLI Primary (SA-139 R4) takes no Subagent at all.
    expect(isSubagentCompatibleWithPrimaryAgent('cli', 'api')).toBe(false)
  })

  it('keeps the SA-106 workflow-target inference for typeless records only: a stored live type always wins', () => {
    // The inference is SA-106's existing `hasWorkflowTarget` branch, reached only when neither an
    // explicit type nor a stored `subagentType`/`subagent_type` names a known type. Every record
    // carries its type (create stores it through `canonicalizeSubagentRecord`), so a leftover
    // webhook or workflow name on an API Subagent never makes it retired, and a stored `cli`
    // stays `cli` (retired since SA-139 R5) whatever else it names.
    for (const type of ['api', 'cli'] as const) {
      expect(normalizeSubagentType({ subagentType: type, webhook_url: 'http://localhost:5678/webhook/x' })).toBe(type)
      expect(normalizeSubagentType({ subagentType: type, webhookUrl: 'http://x', workflowName: 'flow' })).toBe(type)
      expect(normalizeSubagentType({ subagent_type: type, workflow_name: 'flow' })).toBe(type)
    }
    expect(isSubagentCompatibleWithPrimaryAgent('api', { subagentType: 'api', webhook_url: 'http://x' })).toBe(true)
    expect(isSubagentCompatibleWithPrimaryAgent('api', { subagentType: 'cli', webhook_url: 'http://x' })).toBe(false)
    expect(canonicalizeSubagentRecord({ subagentType: 'api', webhook_url: 'http://x' }).subagentType).toBe('api')
    // Typeless with a workflow target: retired, as SA-106 resolved it.
    expect(normalizeSubagentType({ webhook_url: 'http://localhost:5678/webhook/x' })).toBe('n8n-workflow')
  })

  it('names every retired identity as retired and gives the readable refusal', () => {
    for (const type of ['n8n-workflow', 'n8n-subnode', ' N8N-Workflow ', 'cli', ' CLI ']) {
      expect(isRetiredSubagentType(type)).toBe(true)
    }
    for (const type of ['api', '', null, undefined, 'n8n']) {
      expect(isRetiredSubagentType(type)).toBe(false)
    }
    expect(retiredSubagentTypeMessage({ displayName: 'Flow', subagentType: 'n8n-workflow' })).toBe(
      'Flow uses an n8n Subagent type that Batshit removed, so it does not run. n8n workflows still work as tools.'
    )
    expect(retiredSubagentTypeMessage({ displayName: '  ', subagentType: 'n8n-subnode' })).toMatch(/^This Subagent uses an n8n Subagent type/)
    expect(retiredSubagentTypeMessage({ displayName: 'Old helper', subagentType: 'cli' })).toBe(
      'Old helper ran on the Claude Code CLI lane, which Batshit no longer supports, so it can only be deleted. To use your Claude plan, create a new Subagent and pick a Claude plan model.'
    )
  })

  // SA-139 R5 (D14): a typeless record that names a CLI lane was a CLI Subagent. It derives the
  // retired `cli` type, so it never runs as an API Subagent; an API model that merely says
  // "claude" or "codex", and the Claude plan, stay API.
  it('derives the retired cli type for a typeless record with a Claude Code CLI or Codex CLI hint', () => {
    for (const record of [
      { type: 'claude_cli' },
      { primary_model_provider: 'anthropic-claude-cli', primary_model_name: 'opus' },
      { primary_model_provider: 'claude-cli' },
      { primary_model_name: 'claude-cli' },
      { primary_model_connection: { id: 'claude-cli', service: 'anthropic-claude-cli' } },
      { primary_model_provider: 'codex', primary_model_name: 'gpt-6.1-sol' },
      { primary_model_provider: 'openai-codex' },
      { primary_model_connection: { id: 'codex-cli' } },
      { primary_model_connection: { service: 'openai-codex' } },
    ]) {
      expect(normalizeSubagentType(record), JSON.stringify(record)).toBe('cli')
      expect(isSubagentCompatibleWithPrimaryAgent('api', record), JSON.stringify(record)).toBe(false)
    }
    for (const record of [
      { primary_model_provider: 'anthropic', primary_model_name: 'claude-opus-5-5' },
      { primary_model_provider: 'openai', primary_model_name: 'gpt-5-codex', primary_model_connection: { id: 'direct:openai', service: 'openai' } },
      { primary_model_provider: 'anthropic', primary_model_name: 'default', primary_model_connection: { id: 'claude-plan:local', service: 'claude-plan' } },
    ]) {
      expect(normalizeSubagentType(record), JSON.stringify(record)).toBe('api')
    }
    // A stored type always wins over a hint (the routes refuse the CLI model on their own).
    expect(normalizeSubagentType({ subagentType: 'api', primary_model_provider: 'anthropic-claude-cli' })).toBe('api')
  })

  it('refuses a retired stored type and a retired requested type with one code (retiredSubagentRefusal)', () => {
    const claudeLeftover = { displayName: 'Old helper', subagentType: 'cli', primary_model_provider: 'anthropic-claude-cli' }
    const claudeRefusal = {
      code: SUBAGENT_TYPE_RETIRED_CODE,
      error: 'Claude Code CLI Subagents were removed from Batshit.',
      details:
        'Old helper ran on the Claude Code CLI lane, which Batshit no longer supports, so it can only be deleted. To use your Claude plan, create a new Subagent and pick a Claude plan model.',
    }
    expect(SUBAGENT_TYPE_RETIRED_CODE).toBe('subagent_type_retired')
    // The stored type: refused, and a request cannot change its way past it.
    expect(retiredSubagentRefusal(claudeLeftover)).toEqual(claudeRefusal)
    expect(retiredSubagentRefusal(claudeLeftover, 'api')).toEqual(claudeRefusal)
    // A typeless leftover is refused by its derived type.
    expect(retiredSubagentRefusal({ displayName: 'Old helper', primary_model_provider: 'anthropic-claude-cli' })).toEqual(claudeRefusal)
    // The requested type: a live record cannot ask for a retired type.
    const live = { displayName: 'Helper', subagentType: 'api', primary_model_provider: 'anthropic' }
    expect(retiredSubagentRefusal(live, 'cli')).toMatchObject({
      code: SUBAGENT_TYPE_RETIRED_CODE,
      error: 'Claude Code CLI Subagents were removed from Batshit.',
    })
    expect(retiredSubagentRefusal(live, 'n8n-workflow')).toMatchObject({
      code: SUBAGENT_TYPE_RETIRED_CODE,
      error: 'The n8n Subagent types were removed from Batshit.',
    })
    // A live record with a live (or no) requested type: nothing to refuse.
    expect(retiredSubagentRefusal(live)).toBeNull()
    expect(retiredSubagentRefusal(live, 'api')).toBeNull()
    expect(retiredSubagentRefusal(null)).toBeNull()
  })

  it('words a CLI leftover as Claude Code CLI or Codex CLI by what it names', () => {
    expect(retiredSubagentTypeSentences('cli', { displayName: 'Coder', primary_model_provider: 'anthropic-claude-cli', primary_model_name: 'opus' })).toEqual({
      error: 'Claude Code CLI Subagents were removed from Batshit.',
      details:
        'Coder ran on the Claude Code CLI lane, which Batshit no longer supports, so it can only be deleted. To use your Claude plan, create a new Subagent and pick a Claude plan model.',
    })
    const codex = {
      error: 'Codex CLI Subagents were removed from Batshit.',
      details:
        'Coder ran on Codex CLI, which Batshit no longer supports, so it can only be deleted. For ChatGPT models, create a new Subagent with the ChatGPT plan connection or an OpenAI API key.',
    }
    expect(retiredSubagentTypeSentences('cli', { displayName: 'Coder', primary_model_provider: 'codex', primary_model_name: 'gpt-6.1-sol' })).toEqual(codex)
    expect(retiredSubagentTypeSentences('cli', { display_name: 'Coder', primary_model_provider: 'openai-codex' })).toEqual(codex)
    // A record naming no lane (or the Claude plan) reads as Claude Code CLI; no name reads "This Subagent".
    expect(retiredSubagentTypeSentences('cli', {}).details).toMatch(/^This Subagent ran on the Claude Code CLI lane/)
    expect(retiredSubagentTypeSentences('cli', null).error).toBe('Claude Code CLI Subagents were removed from Batshit.')
    expect(retiredSubagentRefusal({ displayName: 'Coder', subagentType: 'cli', primary_model_provider: 'codex' })).toEqual({
      code: SUBAGENT_TYPE_RETIRED_CODE,
      ...codex,
    })
    expect(retiredSubagentTypeMessage({ displayName: 'Coder', primary_model_connection: { id: 'codex-cli' }, primary_model_provider: 'codex' })).toBe(codex.details)
  })

  it('canonicalizes records and removes the snake_case field', () => {
    const record = canonicalizeSubagentRecord({
      subagent_type: 'batshit',
      webhook_url: 'http://localhost:5678/webhook/subagent-runner',
    })

    expect(record.subagentType).toBe('n8n-workflow')
    expect('subagent_type' in record).toBe(false)
  })
  // SA-106 DL-106-02 and SA-139 R2 (D14): a typeless record resolves to a LIVE type, but a
  // record that names a removed n8n type, a legacy alias of one, or a workflow target keeps
  // resolving to a RETIRED type, so it is refused by name and never silently runs as API.
  describe('SA-106 retirement (DL-106-02)', () => {
    it('resolves an unrecognised subagent record to a LIVE type', () => {
      expect(normalizeSubagentType({})).toBe('api')
      expect(normalizeSubagentType(null)).toBe('api')
      expect(normalizeSubagentType(undefined, 'not-a-type')).toBe('api')
    })

    it('keeps resolving a workflow target or legacy alias to the retired workflow type', () => {
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
      // A stored record must stay recognisable as retired rather than silently becoming a
      // live subagent.
      expect(normalizeSubagentType(undefined, 'n8n')).toBe('n8n-subnode')
      expect(normalizeSubagentType({ subagentType: 'n8n' })).toBe('n8n-subnode')
    })
  })
})
