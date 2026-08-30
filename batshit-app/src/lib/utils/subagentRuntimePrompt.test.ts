import { describe, expect, it } from 'vitest'
import { buildSubagentRuntimePrompt } from './subagentRuntimePrompt'

describe('buildSubagentRuntimePrompt', () => {
  it('marks stored n8n subnode records retired and unavailable', () => {
    const prompt = buildSubagentRuntimePrompt({
      displayName: 'Research Friend',
      subagentType: 'n8n-subnode',
    })

    expect(prompt).toContain('type: n8n-subnode (n8n Subnode Subagent (retired))')
    expect(prompt).toContain('runtime: retired n8n Subnode Subagent record')
    expect(prompt).toContain('tool_surface: unavailable')
    expect(prompt).toContain('must be deleted from Agent Settings')
    expect(prompt).toContain('Roleplay or friendly conversational answers are fine')
  })

  it('adds n8n workflow identity and workflow-specific max iteration guidance', () => {
    const prompt = buildSubagentRuntimePrompt({
      displayName: 'Workflow Helper',
      subagentType: 'n8n-workflow',
      webhookUrl: 'http://localhost:5678/webhook/subagent',
    })

    expect(prompt).toContain('type: n8n-workflow (n8n Workflow Subagent)')
    expect(prompt).toContain('dedicated n8n workflow')
    expect(prompt).toContain('10 max iterations')
    expect(prompt).toContain('Batshit Subagent Tools when wired')
  })

  it('adds API subagent identity without n8n max iteration wording', () => {
    const prompt = buildSubagentRuntimePrompt({
      displayName: 'API Helper',
      subagentType: 'api',
    })

    expect(prompt).toContain('type: api (API Subagent)')
    expect(prompt).toContain('Batshit direct API subagent runner')
    expect(prompt).toContain('bounded tool rounds')
    expect(prompt).not.toContain('n8n AI Agent nodes default')
  })

  it('adds CLI subagent identity and non-interactive boundary guidance', () => {
    const prompt = buildSubagentRuntimePrompt({
      displayName: 'CLI Helper',
      subagentType: 'cli',
    })

    expect(prompt).toContain('type: cli (CLI Subagent)')
    expect(prompt).toContain('Codex or Claude CLI one-shot')
    expect(prompt).toContain('non-interactive one-shot calls')
    expect(prompt).toContain('Approval or policy boundary hits fail')
  })
})
