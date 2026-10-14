import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { hasClaudeToolEntry, isClaudeToolEnabled, withClaudeToolEnabled } from '../claudeToolSwitch'

describe('hasClaudeToolEntry', () => {
  it('matches case-insensitively and trims whitespace', () => {
    expect(hasClaudeToolEntry([' WebSearch '], 'websearch')).toBe(true)
    expect(hasClaudeToolEntry(['Bash(ls)'], 'WebSearch')).toBe(false)
    expect(hasClaudeToolEntry([], 'WebSearch')).toBe(false)
  })
})

/**
 * BL-499: Agent Settings' "Allow Claude Web Search" switch used to show OFF the moment any
 * unrelated entry existed under Advanced Tool Rules > Allowed Tools, even though Claude Code
 * still ran WebSearch fine (`--allowedTools` only skips the permission prompt for the tools it
 * names; it is not an allowlist that gates every other tool off). These tests pin the fixed
 * contract: the switch reads `disallowedTools` alone.
 */
describe('isClaudeToolEnabled (BL-499)', () => {
  it('is enabled with no denial at all', () => {
    expect(isClaudeToolEnabled([], 'WebSearch')).toBe(true)
  })

  it('is enabled even when an unrelated Allowed Tools rule would exist -- allowedTools is not a parameter, so it cannot be consulted', () => {
    // The exact BL-499 scenario: some other Allowed Tools entry exists, WebSearch itself is not
    // denied. There is no allowedTools argument here at all, by construction: a future edit
    // cannot silently start reading it again without changing this function's signature.
    const disallowedTools: string[] = []
    expect(isClaudeToolEnabled(disallowedTools, 'WebSearch')).toBe(true)
  })

  it('is disabled only when explicitly denied', () => {
    expect(isClaudeToolEnabled(['WebSearch'], 'WebSearch')).toBe(false)
    expect(isClaudeToolEnabled(['websearch'], 'WebSearch')).toBe(false)
    expect(isClaudeToolEnabled(['Bash(ls)', 'WebSearch'], 'WebSearch')).toBe(false)
  })
})

describe('withClaudeToolEnabled (BL-499)', () => {
  it('turning it OFF adds the tool to disallowedTools and returns a new array', () => {
    const before: string[] = []
    const after = withClaudeToolEnabled(before, 'WebSearch', false)
    expect(after).toEqual(['WebSearch'])
    expect(after).not.toBe(before)
  })

  it('turning it OFF alongside an existing Allowed Tools rule still only touches disallowedTools -- the caller decides whether to leave allowedTools alone, and this function gives it nothing to change', () => {
    // Mirrors the live-proof scenario: an Allowed Tools rule for something else is present in
    // the surrounding form, but this function only ever sees disallowedTools.
    const disallowedTools: string[] = []
    expect(withClaudeToolEnabled(disallowedTools, 'WebSearch', false)).toEqual(['WebSearch'])
  })

  it('turning it OFF is a no-op (same reference) if already denied', () => {
    const before = ['WebSearch']
    expect(withClaudeToolEnabled(before, 'WebSearch', false)).toBe(before)
  })

  it('turning it ON removes the tool from disallowedTools and returns a new array', () => {
    const before = ['Bash(ls)', 'WebSearch']
    const after = withClaudeToolEnabled(before, 'WebSearch', true)
    expect(after).toEqual(['Bash(ls)'])
    expect(after).not.toBe(before)
  })

  it('turning it ON is a no-op (same reference) if not denied', () => {
    const before = ['Bash(ls)']
    expect(withClaudeToolEnabled(before, 'WebSearch', true)).toBe(before)
  })

  it('ignores a blank tool name (same reference, no change)', () => {
    const before = ['Bash(ls)']
    expect(withClaudeToolEnabled(before, '   ', false)).toBe(before)
  })
})

// The panel is 15,000+ lines with two call sites (agent and subagent scope) sharing one
// implementation; pin that it delegates to this tested module rather than reimplementing the
// check inline, and that neither call site reads or writes allowedTools from the switch.
describe('BL-499: Agent Settings wires the switch to this module, never inline, never allowedTools', () => {
  const panel = readFileSync(
    'src/lib/components/settings/panels/AgentSettingsPanel.svelte',
    'utf8'
  )

  it('imports the shared functions', () => {
    expect(panel).toContain(
      'import { isClaudeToolEnabled, withClaudeToolEnabled } from "$lib/utils/claudeToolSwitch";'
    )
  })

  it('getClaudeToolEnabled delegates to isClaudeToolEnabled(form.disallowedTools, ...)', () => {
    expect(panel).toContain('return isClaudeToolEnabled(form.disallowedTools, toolName);')
  })

  it('setClaudeToolEnabled delegates to withClaudeToolEnabled(current.disallowedTools, ...)', () => {
    expect(panel).toContain(
      'const nextDisallowed = withClaudeToolEnabled(current.disallowedTools, toolName, enabled);'
    )
  })

  it('never reads or writes allowedTools around the switch', () => {
    const start = panel.indexOf('function getClaudeToolEnabled')
    const end = panel.indexOf('function addCodexConfig')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const switchRegion = panel.slice(start, end)
    // Not a plain /allowedTools/ match: that also matches inside "disallowedTools", which this
    // region is full of on purpose. Only a bare "allowedTools" (not preceded by "dis") counts.
    expect(switchRegion).not.toMatch(/(?<!dis)allowedTools/)
  })

  it('both the agent-scope and subagent-scope switches call the same function', () => {
    expect(panel).toContain('checked={getClaudeToolEnabled("WebSearch")}')
    expect(panel).toContain('checked={getClaudeToolEnabled("WebSearch", "subagent")}')
  })
})
