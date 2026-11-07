import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  applyPromptRuntimeScope,
  applyPromptSessionScope,
  brokerToolNamesForScope,
  type PromptRuntimeScope
} from '../promptRuntimeScope'
import { replacePromptVariables } from '../promptVariables'

const PACKAGED_DYNAMIC_MCP_PROMPT = resolve(
  __dirname,
  '../../../../../docs/batshit_System_Prompts/batshit_dynamic_mcp.md'
)

function compilePackagedPrompt(scope: PromptRuntimeScope): string {
  const raw = readFileSync(PACKAGED_DYNAMIC_MCP_PROMPT, 'utf8')
  const scoped = applyPromptRuntimeScope(raw, scope)
  const names = brokerToolNamesForScope(scope)
  return replacePromptVariables(scoped, undefined, {
    tool_search_tool: names.search,
    tool_use_tool: names.use
  })
}

describe('applyPromptRuntimeScope', () => {
  it('leaves prompts without markers untouched', () => {
    const prompt = '# Heading\n\nSome guidance.\n'
    expect(applyPromptRuntimeScope(prompt, 'api')).toBe(prompt)
  })

  it('keeps a block whose scope matches and strips its markers', () => {
    const prompt = ['before', '<!-- runtime:api -->', 'api only', '<!-- /runtime -->', 'after'].join(
      '\n'
    )
    const result = applyPromptRuntimeScope(prompt, 'api')
    expect(result).toContain('api only')
    expect(result).not.toContain('<!-- runtime:api -->')
    expect(result).not.toContain('<!-- /runtime -->')
  })

  it('drops a block whose scope does not match', () => {
    const prompt = ['before', '<!-- runtime:cli -->', 'cli only', '<!-- /runtime -->', 'after'].join(
      '\n'
    )
    const result = applyPromptRuntimeScope(prompt, 'api')
    expect(result).not.toContain('cli only')
    expect(result).not.toContain('<!-- runtime:cli -->')
    expect(result).toContain('before')
    expect(result).toContain('after')
  })

  it('tolerates the retired n8n marker while preserving the live scope in customized prompts', () => {
    const shared = ['<!-- runtime:api,n8n -->', 'shared', '<!-- /runtime -->'].join('\n')
    expect(applyPromptRuntimeScope(shared, 'api')).toContain('shared')
    const retiredOnly = ['<!-- runtime:cli,n8n -->', 'retired', '<!-- /runtime -->'].join('\n')
    expect(applyPromptRuntimeScope(retiredOnly, 'api')).not.toContain('retired')
  })

  it('silently drops a stored n8n-only block for the live runtime', () => {
    const prompt = ['before', '<!-- runtime:n8n -->', 'retired', '<!-- /runtime -->', 'after'].join('\n')
    expect(applyPromptRuntimeScope(prompt, 'api')).not.toContain('retired')
  })

  it('SA-139 R4: still parses a saved cli section, a never-active scope, and drops it for an API agent', () => {
    // A saved custom prompt written for the retired Claude Code CLI Primary keeps its
    // `<!-- runtime:cli -->` section; the strict parser must accept it (not throw) and the API
    // compile must never send it.
    const prompt = [
      'Shared intro.',
      '',
      '<!-- runtime:cli -->',
      'Old CLI-only words.',
      '<!-- /runtime -->',
      '',
      '<!-- runtime:api -->',
      'API words.',
      '<!-- /runtime -->',
      '',
      'Shared outro.'
    ].join('\n')
    expect(applyPromptRuntimeScope(prompt, 'api')).toBe(
      ['Shared intro.', '', 'API words.', '', 'Shared outro.'].join('\n')
    )
  })

  it('throws on an unclosed block rather than shipping partial content', () => {
    const prompt = ['<!-- runtime:api -->', 'dangling'].join('\n')
    expect(() => applyPromptRuntimeScope(prompt, 'api')).toThrow(/never closed/i)
  })

  it('throws on a close marker with no open marker', () => {
    const prompt = ['content', '<!-- /runtime -->'].join('\n')
    expect(() => applyPromptRuntimeScope(prompt, 'api')).toThrow(/no matching open marker/i)
  })

  it('throws on an unknown runtime name', () => {
    const prompt = ['<!-- runtime:webhook -->', 'x', '<!-- /runtime -->'].join('\n')
    expect(() => applyPromptRuntimeScope(prompt, 'api')).toThrow(/unknown runtime "webhook"/i)
  })

  it('throws on nested blocks', () => {
    const prompt = [
      '<!-- runtime:api -->',
      '<!-- runtime:cli -->',
      'x',
      '<!-- /runtime -->',
      '<!-- /runtime -->'
    ].join('\n')
    expect(() => applyPromptRuntimeScope(prompt, 'api')).toThrow(/nested runtime blocks/i)
  })

  it('does not leave runaway blank space where a block was removed', () => {
    const prompt = [
      'before',
      '',
      '<!-- runtime:cli -->',
      'cli only',
      '<!-- /runtime -->',
      '',
      'after'
    ].join('\n')
    expect(applyPromptRuntimeScope(prompt, 'api')).not.toMatch(/\n{3,}/)
  })
})

describe('packaged Dynamic Tool Search prompt (SA-096)', () => {
  it('teaches an API agent only the native_ broker names', () => {
    const compiled = compilePackagedPrompt('api')

    expect(compiled).toContain('native_batshit_tool_search')
    expect(compiled).toContain('native_batshit_tool_use')
    // The bare names must never appear as a standalone token an API agent could copy.
    expect(compiled).not.toMatch(/(?<!native_)\bbatshit_tool_search\b/)
    expect(compiled).not.toMatch(/(?<!native_)\bbatshit_tool_use\b/)
  })

  it('shows the API agent one set of preferred call shapes', () => {
    const apiPrompt = compilePackagedPrompt('api')
    expect(apiPrompt).toContain('"query": "web fetch"')
    expect(apiPrompt).not.toContain('"query": "image resize"')
  })

  it('leaves no unresolved prompt variables', () => {
    expect(compilePackagedPrompt('api')).not.toMatch(/\{\{\s*\$\w+\s*\}\}/)
  })

  it('keeps the shared rules the API agent needs', () => {
    const compiled = compilePackagedPrompt('api')
    // Decision 11 (2026-10-23): Josh's approved guide.
    expect(compiled).toContain("2. Put the tool's arguments inside `input`, never at the top level.")
    expect(compiled).toContain('1. Copy a ref exactly; never make one up.')
    expect(compiled).toContain('Use them, not Bash, for saved CLI tools')
    expect(compiled).toContain('tool_discovery')
    expect(compiled).toContain('If a tool is already in your tool list (Bash, `native_skill` scripts), call it directly.')
    expect(compiled).toContain('When a hint tells you enough for a safe call, do not search.')
    expect(compiled).toContain('Every search is a tool call, and its result can be large.')
  })

  it('is smaller than the unscoped source', () => {
    const raw = readFileSync(PACKAGED_DYNAMIC_MCP_PROMPT, 'utf8')
    expect(compilePackagedPrompt('api').length).toBeLessThan(raw.length)
  })
})

describe('applyPromptSessionScope (decision 11, 2026-10-24)', () => {
  const prompt = [
    'Shared intro.',
    '',
    '<!-- session:infinite -->',
    '## Infinite part',
    '<!-- runtime:cli -->',
    'CLI-only infinite line.',
    '<!-- /runtime -->',
    '<!-- /session -->',
    '',
    'Shared outro.'
  ].join('\n')

  it('keeps the block, markers stripped, in an Infinite Session; the runtime pass still applies', () => {
    const kept = applyPromptSessionScope(prompt, { infiniteSession: true })
    expect(kept).toBe(
      ['Shared intro.', '', '## Infinite part', '<!-- runtime:cli -->', 'CLI-only infinite line.', '<!-- /runtime -->', '', 'Shared outro.'].join('\n')
    )
    expect(applyPromptRuntimeScope(kept, 'api')).toBe(['Shared intro.', '', '## Infinite part', '', 'Shared outro.'].join('\n'))
  })

  it('drops the block and one blank line at the seam everywhere else', () => {
    expect(applyPromptSessionScope(prompt, { infiniteSession: false })).toBe('Shared intro.\n\nShared outro.')
  })

  it('passes text without session markers through untouched, runtime markers included', () => {
    const runtimeOnly = '<!-- runtime:api -->\nA\n<!-- /runtime -->'
    expect(applyPromptSessionScope(runtimeOnly, { infiniteSession: false })).toBe(runtimeOnly)
  })

  it('throws on an unknown kind, a nested block, a stray close and an unclosed block', () => {
    expect(() => applyPromptSessionScope('<!-- session:group -->\nx\n<!-- /session -->', { infiniteSession: true })).toThrow(
      /unknown session kind "group"/
    )
    expect(() =>
      applyPromptSessionScope('<!-- session:infinite -->\n<!-- session:infinite -->\nx\n<!-- /session -->\n<!-- /session -->', {
        infiniteSession: true
      })
    ).toThrow(/Nested session blocks/)
    expect(() => applyPromptSessionScope('x\n<!-- /session -->', { infiniteSession: true })).toThrow(/no matching open marker/)
    expect(() => applyPromptSessionScope('<!-- session:infinite -->\nx', { infiniteSession: false })).toThrow(/never closed/)
  })
})
