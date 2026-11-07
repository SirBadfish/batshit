import { describe, expect, it } from 'vitest'
import { buildSubagentRuntimePrompt, buildWorkerRuntimePrompt } from './subagentRuntimePrompt'

describe('buildSubagentRuntimePrompt', () => {
  it('refuses to build a runtime block for a removed n8n Subagent type (SA-139 R2, D14)', () => {
    for (const subagentType of ['n8n-subnode', 'n8n-workflow']) {
      expect(() => buildSubagentRuntimePrompt({ displayName: 'Research Friend', subagentType })).toThrow(
        'Research Friend uses an n8n Subagent type that Batshit removed, so it does not run. n8n workflows still work as tools.'
      )
    }
    expect(() => buildSubagentRuntimePrompt({ displayName: 'Flow', webhookUrl: 'http://localhost:5678/webhook/sub' }))
      .toThrow(/removed/)
  })

  it('refuses to build a runtime block for a leftover CLI Subagent, in its own wording (SA-139 R5, D14)', () => {
    expect(() => buildSubagentRuntimePrompt({ displayName: 'CLI Helper', subagentType: 'cli' })).toThrow(
      'CLI Helper ran on the Claude Code CLI lane, which Batshit no longer supports, so it can only be deleted. To use your Claude plan, create a new Subagent and pick a Claude plan model.'
    )
    expect(() => buildSubagentRuntimePrompt({ displayName: 'Codex Helper', subagentType: 'cli', primary_model_provider: 'codex' })).toThrow(
      /^Codex Helper ran on Codex CLI, which Batshit no longer supports/
    )
    // A typeless record that names the Claude Code CLI lane is refused too, never built as API.
    expect(() => buildSubagentRuntimePrompt({ displayName: 'Old', primary_model_provider: 'anthropic-claude-cli' })).toThrow(
      /^Old ran on the Claude Code CLI lane/
    )
  })

  it('adds the Subagent runtime identity, with no type line (SA-139 R6: one Subagent kind)', () => {
    const prompt = buildSubagentRuntimePrompt({
      displayName: 'API Helper',
      subagentType: 'api',
    })

    expect(prompt).not.toMatch(/^type: /m)
    expect(prompt).not.toContain('API Subagent')
    expect(prompt).toContain('runtime: Batshit direct subagent runner.')
    expect(prompt).toContain('tool_surface: use only the native Batshit tools and Dynamic Tool Search/Use entries')
  })

  it('delegation limits: says no limit by default, and the stall guard, on the managed lane', () => {
    // Josh, 2026-10-24: no time and no tool-step limit unless the Subagent sets one; a run
    // that shows no progress for 10 minutes is stopped. The old text promised 10 rounds.
    // SA-139 R5: the API lane is the one managed Subagent lane.
    const prompt = buildSubagentRuntimePrompt({ displayName: 'Helper', subagentType: 'api' })
    const limits = prompt.split('\n').find((line) => line.startsWith('limits: ')) ?? ''
    expect(limits).toContain('no time limit and no tool-step limit.')
    expect(limits).toContain(
      'Batshit stops a run that shows no progress for 10 minutes; a tool call that is still running counts as progress.'
    )
    expect(limits).not.toMatch(/normally 10|bounded tool rounds|hard time limit/)
    const worker = buildWorkerRuntimePrompt({ lane: 'api' })
    expect(worker).toContain('This run has no time limit and no tool-step limit.')
    expect(worker).not.toMatch(/normally 10|hard time limit/)
  })

  it('delegation limits: names a limit the Subagent sets, and a base clone carries it', () => {
    const prompt = buildSubagentRuntimePrompt({
      displayName: 'Builder',
      subagentType: 'api',
      timeout_seconds: 7_200,
      max_tool_steps: 40,
    })
    expect(prompt).toContain('a time limit of 2 hours (return your result before it)')
    expect(prompt).toContain('a limit of 40 tool steps, one per tool call (at the limit Batshit stops you and returns your work so far, marked partial)')

    const clone = buildWorkerRuntimePrompt({
      lane: 'api',
      baseLabel: 'Builder',
      limits: { timeout_seconds: 90, max_tool_steps: 1 },
    })
    expect(clone).toContain('a time limit of 1 minute 30 seconds')
    expect(clone).toContain('a limit of 1 tool step, one per tool call')
  })

  it('SA-111 P4: a worker gets its own runtime block, not the subagent one', () => {
    // A worker is not a subagent: it has no memory, no configured tool surface of its own,
    // and cannot delegate. Reusing the subagent block would tell it that subagent memory
    // "may persist within the current Batshit session", which is false for a worker.
    const prompt = buildWorkerRuntimePrompt({ lane: 'api', role: 'docs scout' })

    expect(prompt).toContain('==== WORKER RUNTIME CONTEXT ====')
    expect(prompt).toContain('type: worker (Worker)')
    expect(prompt).toContain('role: docs scout')
    expect(prompt).toContain('memory: none')
    // SA-139 P7 (Josh, 2026-10-28): the Worker's runtime line names no lane.
    expect(prompt).toContain('runtime: Batshit ephemeral worker run, inheriting')
    expect(prompt).not.toContain('direct API lane')
    expect(prompt).toContain("inheriting the Primary Agent's model and tool scope")
    expect(prompt).toContain('subagents, and worker spawning are deliberately unavailable')
    expect(prompt).not.toContain('SUBAGENT RUNTIME CONTEXT')
  })

  it('SA-111 P4: a base clone says which specialist it copies', () => {
    // SA-139 R5 removed the CLI Worker lane; P7 (Josh, 2026-10-28) took the lane out of the line.
    const prompt = buildWorkerRuntimePrompt({ lane: 'api', baseLabel: 'Researcher' })

    expect(prompt).toContain('based_on: Researcher')
    expect(prompt).toContain('no memory of its past calls')
    expect(prompt).toContain('runtime: Batshit ephemeral worker run, inheriting')
    expect(prompt).not.toContain('managed CLI lane')
    expect(prompt).toContain("inheriting the named specialist's model and tool scope")
    expect(prompt).not.toContain("inheriting the Primary Agent's")
    // No role was given, so no role line is invented.
    expect(prompt).not.toContain('role:')
  })
})
