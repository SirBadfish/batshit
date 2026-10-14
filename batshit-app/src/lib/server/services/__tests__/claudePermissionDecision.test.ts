import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const permissionBridgePath = path.resolve(process.cwd(), 'scripts/claude-permission-mcp.cjs')
const permissionBridgeSource = readFileSync(permissionBridgePath, 'utf8')
const decisionFunctionStart = permissionBridgeSource.indexOf('function evaluateDecision(')
const mainFunctionStart = permissionBridgeSource.indexOf('async function main()')

if (decisionFunctionStart < 0 || mainFunctionStart < 0 || decisionFunctionStart > mainFunctionStart) {
  throw new Error('Could not find evaluateDecision before the permission bridge entrypoint')
}

type Decision = { decision: 'allow' | 'deny' | 'prompt'; reason?: string }

function loadDecision(env: Record<string, string>) {
  const bridgePrefix = permissionBridgeSource
    .slice(0, mainFunctionStart)
    .replace(/^#![^\n]*\n/, '')

  const bridgeProcess = {
    env: {
      BATSHIT_CLAUDE_WORKDIR: '/workspace',
      ...env
    },
    cwd: () => '/workspace'
  }

  const bridgeRequire = (specifier: string) => {
    if (specifier === 'node:path') return path
    if (specifier === 'node:os') return { homedir: () => '/Users/helper [home]' }
    if (specifier === 'node:process') return bridgeProcess
    if (specifier === 'redis') {
      return { createClient: () => ({ on: () => undefined }) }
    }
    return new Proxy({}, { get: () => class {} })
  }

  const context: Record<string, unknown> = {
    __dirname: path.dirname(permissionBridgePath),
    require: bridgeRequire,
    console,
    Date,
    Math
  }
  vm.runInNewContext(`${bridgePrefix}\nglobalThis.__evaluateDecision = evaluateDecision`, context, {
    filename: permissionBridgePath
  })

  return context.__evaluateDecision as (toolName: string, toolInput: unknown) => Decision
}

function jsonList(...values: string[]) {
  return JSON.stringify(values)
}

describe('Claude permission bridge decisions', () => {
  it.each(['Edit', 'Write', 'NotebookEdit'])('denies %s in absolute plans folders, including comma/space wildcards', (toolName) => {
    const decide = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'bypassPermissions',
      BATSHIT_CLAUDE_DENIED_TOOLS: jsonList('Edit(//Users/person/Claude?Config??Work/plans/**)')
    })
    const input = (filePath: string) => toolName === 'NotebookEdit' ? { notebook_path: filePath } : { file_path: filePath }
    expect(decide(toolName, input('/Users/person/Claude Config, Work/plans/nested/plan.md')))
      .toEqual({ decision: 'deny', reason: 'Denied by rule' })
    expect(decide(toolName, input('/Users/person/Claude/Config/ Work/plans/plan.md')))
      .toEqual({ decision: 'allow' })
    expect(decide(toolName, input('/Users/person/Claude Config, Work/plans-other/plan.md')))
      .toEqual({ decision: 'allow' })
  })

  it('expands a home-relative file rule with literal home characters and tolerates malformed input', () => {
    const decide = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'bypassPermissions',
      BATSHIT_CLAUDE_DENIED_TOOLS: jsonList('Edit(~/.claude/plans/**)')
    })
    expect(decide('NotebookEdit', { notebook_path: '/Users/helper [home]/.claude/plans/p.ipynb' }))
      .toEqual({ decision: 'deny', reason: 'Denied by rule' })
    expect(decide('Write', { file_path: '/Users/helper h/.claude/plans/p.md' }))
      .toEqual({ decision: 'allow' })
    expect(() => decide('Write', { file_path: { path: 'invalid' } })).not.toThrow()
  })

  it('keeps Plan ahead of general user/MCP allows while retaining its explicit Subagent list', () => {
    // BL-878: an ordinary enabled helper; Batshit's Bash helper is never enabled for a CLI run now.
    const ordinaryMcp = 'mcp__batshit_helpers__batshit_tool_use'
    const subagent = 'mcp__assigned_subagents__subagent_helper'
    const decide = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'plan',
      BATSHIT_CLAUDE_ALLOWED_TOOLS: jsonList('Bash(*)', 'Write'),
      BATSHIT_CLAUDE_ALLOWED_MCP_TOOLS: jsonList(ordinaryMcp, subagent),
      BATSHIT_CLAUDE_PLAN_ALLOW_TOOLS: jsonList(subagent)
    })
    for (const name of [ordinaryMcp, 'Bash', 'Write']) {
      expect(decide(name, { command: 'echo probe', file_path: '/workspace/plan.md' }).decision).toBe('deny')
    }
    for (const name of [subagent, 'Read', 'WebSearch', 'WebFetch']) {
      expect(decide(name, {}).decision).toBe('allow')
    }
    const denied = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'plan',
      BATSHIT_CLAUDE_PLAN_ALLOW_TOOLS: jsonList(subagent),
      BATSHIT_CLAUDE_DENIED_TOOLS: jsonList(subagent)
    })
    expect(denied(subagent, {}).decision).toBe('deny')
    const ordinary = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'default',
      BATSHIT_CLAUDE_ALLOWED_MCP_TOOLS: jsonList(ordinaryMcp)
    })
    expect(ordinary(ordinaryMcp, {}).decision).toBe('allow')
  })

  it('uses each editing tool canonical target before unrelated fields or compatibility aliases', () => {
    const decide = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'bypassPermissions',
      BATSHIT_CLAUDE_DENIED_TOOLS: jsonList('Edit(//Users/person/plans/**)')
    })
    for (const maskingPath of [{}, '/workspace/unprotected.md']) {
      expect(decide('NotebookEdit', {
        notebook_path: '/Users/person/plans/p.ipynb', file_path: maskingPath, filePath: '/workspace/other.md'
      }).decision).toBe('deny')
      expect(decide('Write', {
        file_path: '/Users/person/plans/p.md', filePath: maskingPath
      }).decision).toBe('deny')
    }
  })

  it('normalizes the actual target and resolves a relative target against the run workdir', () => {
    const decide = loadDecision({
      BATSHIT_CLAUDE_WORKDIR: '/Users/person/plans',
      BATSHIT_CLAUDE_PERMISSION_MODE: 'bypassPermissions',
      BATSHIT_CLAUDE_DENIED_TOOLS: jsonList('Edit(//Users/person/plans/**)')
    })
    for (const file_path of ['//Users/person/plans/p.md', '/Users/person/./plans/p.md', 'p.md']) {
      expect(decide('Write', { file_path }).decision).toBe('deny')
    }
    expect(decide('Write', { file_path: '../plans-other/p.md' }).decision).toBe('allow')
  })

  it('preserves existing relative file patterns and literal Bash question marks', () => {
    const decide = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'bypassPermissions',
      BATSHIT_CLAUDE_DENIED_TOOLS: jsonList('Edit(notes/**)', 'Bash(echo why?)')
    })
    expect(decide('Edit', { file_path: 'notes/p.md' }).decision).toBe('deny')
    expect(decide('Bash', { command: 'echo why?' }).decision).toBe('deny')
    expect(decide('Bash', { command: 'echo whyx' }).decision).toBe('allow')
  })

  it('prompts for a Bash compound command even when an acceptEdits wildcard matches it', () => {
    const evaluateDecision = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'acceptEdits',
      BATSHIT_CLAUDE_ALLOWED_TOOLS: jsonList('Bash(git status*)')
    })

    expect(
      evaluateDecision('Bash', {
        command: 'git status --short && touch approval-required'
      })
    ).toEqual({ decision: 'prompt' })
  })

  it.each([
    ['Write', '/workspace/.claude/settings.json'],
    ['Edit', '/workspace/.git/config']
  ])('prompts for %s in an allowed directory, including %s', (toolName, filePath) => {
    const evaluateDecision = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'acceptEdits',
      BATSHIT_CLAUDE_ALLOWED_DIRS: jsonList('/workspace')
    })

    expect(evaluateDecision(toolName, { filePath })).toEqual({ decision: 'prompt' })
  })

  it.each([
    ['Write', '/workspace/.claude/settings.json'],
    ['Edit', '/workspace/.git/config']
  ])('prompts for %s matching an allowed rule inside %s', (toolName, filePath) => {
    const evaluateDecision = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'acceptEdits',
      BATSHIT_CLAUDE_ALLOWED_TOOLS: jsonList(`${toolName}(/workspace/**)`)
    })

    expect(evaluateDecision(toolName, { filePath })).toEqual({ decision: 'prompt' })
  })

  it('keeps explicit deny rules ahead of matching allow rules in acceptEdits mode', () => {
    const evaluateDecision = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'acceptEdits',
      BATSHIT_CLAUDE_ALLOWED_TOOLS: jsonList('Bash(git status*)'),
      BATSHIT_CLAUDE_DENIED_TOOLS: jsonList('Bash(git status*)')
    })

    expect(evaluateDecision('Bash', { command: 'git status --short' })).toEqual({
      decision: 'deny',
      reason: 'Denied by rule'
    })
  })

  it('keeps read and configured web auto-allow behavior in acceptEdits mode', () => {
    const evaluateDecision = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'acceptEdits',
      BATSHIT_CLAUDE_AUTO_ALLOW_TOOLS: jsonList('WebSearch', 'WebFetch')
    })

    expect(evaluateDecision('Read', { filePath: '/workspace/notes.txt' })).toEqual({ decision: 'allow' })
    expect(evaluateDecision('WebSearch', { query: 'batshit' })).toEqual({ decision: 'allow' })
    expect(evaluateDecision('WebFetch', { url: 'https://example.invalid' })).toEqual({ decision: 'allow' })
  })

  it('prompts for Bash in default mode and preserves bypass and dontAsk decisions', () => {
    const defaultDecision = loadDecision({ BATSHIT_CLAUDE_PERMISSION_MODE: 'default' })
    expect(defaultDecision('Bash', { command: 'git status --short' })).toEqual({ decision: 'prompt' })

    const bypassDecision = loadDecision({ BATSHIT_CLAUDE_PERMISSION_MODE: 'bypassPermissions' })
    expect(bypassDecision('Bash', { command: 'curl https://example.invalid' })).toEqual({
      decision: 'allow'
    })

    const dontAskDecision = loadDecision({
      BATSHIT_CLAUDE_PERMISSION_MODE: 'dontAsk',
      BATSHIT_CLAUDE_ALLOWED_TOOLS: jsonList('Bash(git status*)'),
      BATSHIT_CLAUDE_ALLOWED_DIRS: jsonList('/workspace')
    })
    expect(dontAskDecision('Bash', { command: 'git status --short' })).toEqual({ decision: 'allow' })
    expect(dontAskDecision('Write', { filePath: '/workspace/.claude/settings.json' })).toEqual({
      decision: 'allow'
    })
    expect(dontAskDecision('Bash', { command: 'curl https://example.invalid' })).toEqual({
      decision: 'deny',
      reason: 'Auto-deny (dontAsk)'
    })
  })
})
