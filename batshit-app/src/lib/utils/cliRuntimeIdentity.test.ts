import { describe, expect, it } from 'vitest'
import {
  namesRetiredCodexCliModel,
  primaryCliRuntimeCandidates,
  subagentCliRuntimeCandidates
} from './cliRuntimeIdentity'

describe('shared configured CLI candidate predicates', () => {
  it('retains exact Primary connection spelling and existing normalized provider aliases', () => {
    expect(primaryCliRuntimeCandidates('codex', null)).toEqual({ codex: true, claude: false })
    expect(primaryCliRuntimeCandidates('openai-codex', null)).toEqual({ codex: true, claude: false })
    expect(primaryCliRuntimeCandidates('anthropic-claude-cli', 'codex-cli')).toEqual({ codex: true, claude: true })
    expect(primaryCliRuntimeCandidates('anthropic-claude-cli', null)).toEqual({ codex: false, claude: true })
    expect(primaryCliRuntimeCandidates('', 'claude-cli')).toEqual({ codex: false, claude: true })
    expect(primaryCliRuntimeCandidates('', 'CODEX-CLI')).toEqual({ codex: false, claude: false })
  })

  // SA-139 R5: no CLI Subagent runs, so no runtime is picked from these candidates any more. They
  // still decide which removal sentence a leftover reads (Codex CLI or Claude Code CLI) and which
  // leftovers the retired-type sweep may delete (Codex CLI ones only).
  it('reads a Subagent hint that names Codex as Codex, also beside a Claude name', () => {
    const both = { primary_model_provider: 'claude-cli', primary_model_name: ' codex ', model: 'ignored' }
    expect(subagentCliRuntimeCandidates(both)).toEqual({ codex: true, claude: true })
    expect(subagentCliRuntimeCandidates({ primary_model_provider: 'codex', primary_model_name: 'gpt-6.1-sol' })).toEqual({ codex: true, claude: false })
    expect(subagentCliRuntimeCandidates({ primary_model_name: ' ', model: '' })).toEqual({ codex: false, claude: false })
    expect(subagentCliRuntimeCandidates({ primary_model_name: ' ', model: 'Claude' })).toEqual({ codex: false, claude: true })
    expect(subagentCliRuntimeCandidates({ primary_model_provider: 'claude-cli', primary_model_name: 'opus' })).toEqual({ codex: false, claude: true })
  })
})

describe('namesRetiredCodexCliModel', () => {
  it('names the retired lane by provider id', () => {
    expect(namesRetiredCodexCliModel({ primary_model_provider: 'codex' })).toBe(true)
    expect(namesRetiredCodexCliModel({ primary_model_provider: ' OpenAI-Codex ' })).toBe(true)
  })

  it('names the retired lane by connection id or connection service', () => {
    expect(namesRetiredCodexCliModel({ primary_model_connection: { id: 'codex-cli' } })).toBe(true)
    expect(namesRetiredCodexCliModel({ primary_model_connection: { id: 'CODEX-CLI' } })).toBe(true)
    expect(namesRetiredCodexCliModel({ primary_model_connection: { service: 'openai-codex' } })).toBe(true)
    expect(namesRetiredCodexCliModel({ primary_model_connection: { service: 'codex' } })).toBe(true)
  })

  it('never names the retired lane by a model id that contains "codex"', () => {
    const apiCodexModel = {
      primary_model_provider: 'openai',
      primary_model_name: 'gpt-5-codex',
      primary_model_connection: { id: 'direct:openai', service: 'openai' }
    }
    expect(namesRetiredCodexCliModel(apiCodexModel)).toBe(false)
    const chatgptPlanCodexModel = {
      primary_model_provider: 'openai',
      primary_model_name: 'gpt-5.1-codex-max',
      primary_model_connection: { id: 'chatgpt-plan:account-a', service: 'chatgpt-plan' }
    }
    expect(namesRetiredCodexCliModel(chatgptPlanCodexModel)).toBe(false)
  })

  it('does not name the retired lane for Claude CLI, API or empty fields', () => {
    expect(namesRetiredCodexCliModel({ primary_model_provider: 'anthropic-claude-cli', primary_model_connection: { id: 'claude-cli' } })).toBe(false)
    expect(namesRetiredCodexCliModel({ primary_model_provider: 'anthropic', primary_model_connection: { id: 'direct:anthropic' } })).toBe(false)
    expect(namesRetiredCodexCliModel({})).toBe(false)
    expect(namesRetiredCodexCliModel({ primary_model_provider: null, primary_model_connection: null })).toBe(false)
  })
})
