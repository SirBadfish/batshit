import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  applyPromptRuntimeScope,
  brokerToolNamesForScope,
  runtimeFlavorToScope,
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

describe('runtimeFlavorToScope', () => {
  it('maps the Vercel AI SDK lane to the API primary-agent scope', () => {
    expect(runtimeFlavorToScope('vercel')).toBe('api')
  })

  it('maps both managed CLI flavors to the CLI scope', () => {
    expect(runtimeFlavorToScope('codex')).toBe('cli')
    expect(runtimeFlavorToScope('claude')).toBe('cli')
  })

})

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
    const prompt = ['before', '<!-- runtime:api -->', 'api only', '<!-- /runtime -->', 'after'].join(
      '\n'
    )
    const result = applyPromptRuntimeScope(prompt, 'cli')
    expect(result).not.toContain('api only')
    expect(result).toContain('before')
    expect(result).toContain('after')
  })

  it('tolerates the retired n8n marker while preserving live scopes in customized prompts', () => {
    const prompt = ['<!-- runtime:cli,n8n -->', 'shared', '<!-- /runtime -->'].join('\n')
    expect(applyPromptRuntimeScope(prompt, 'cli')).toContain('shared')
    expect(applyPromptRuntimeScope(prompt, 'api')).not.toContain('shared')
  })

  it('silently drops a stored n8n-only block for both live runtimes', () => {
    const prompt = ['before', '<!-- runtime:n8n -->', 'retired', '<!-- /runtime -->', 'after'].join('\n')
    expect(applyPromptRuntimeScope(prompt, 'api')).not.toContain('retired')
    expect(applyPromptRuntimeScope(prompt, 'cli')).not.toContain('retired')
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

  it('teaches managed CLI agents only the bridge broker names', () => {
    const compiled = compilePackagedPrompt('cli')
    expect(compiled).toContain('batshit_tool_search')
    expect(compiled).toContain('batshit_tool_use')
    expect(compiled).not.toContain('native_batshit_tool_search')
    expect(compiled).not.toContain('native_batshit_tool_use')
  })

  it('shows each runtime exactly one set of preferred call shapes', () => {
    const apiPrompt = compilePackagedPrompt('api')
    expect(apiPrompt).toContain('"query": "web fetch"')
    expect(apiPrompt).not.toContain('"query": "image resize"')

    const cliPrompt = compilePackagedPrompt('cli')
    expect(cliPrompt).toContain('"query": "image resize"')
    expect(cliPrompt).not.toContain('"query": "web fetch"')
  })

  it('leaves no unresolved prompt variables in any runtime', () => {
    for (const scope of ['api', 'cli', 'n8n'] as const) {
      expect(compilePackagedPrompt(scope)).not.toMatch(/\{\{\s*\$\w+\s*\}\}/)
    }
  })

  it('keeps the shared rules every runtime needs', () => {
    for (const scope of ['api', 'cli', 'n8n'] as const) {
      const compiled = compilePackagedPrompt(scope)
      expect(compiled).toContain('Never flatten required fields to the top level')
      expect(compiled).toContain('Never invent placeholder refs')
      expect(compiled).toContain('input.inputFile')
      expect(compiled).toContain('are separate primitives')
      expect(compiled).toContain('tool_discovery')
      expect(compiled).toContain(
        'If a tool is already in your tool list, call it directly — never search for it'
      )
      expect(compiled).toContain('Web Search: call the Web Search tool directly')
      expect(compiled).toContain('The Dynamic Tool Search/Use pair itself: call it directly')
      expect(compiled).toContain('A prior search is not required')
    }
  })

  it('is smaller for every runtime than the unscoped source', () => {
    const raw = readFileSync(PACKAGED_DYNAMIC_MCP_PROMPT, 'utf8')
    for (const scope of ['api', 'cli', 'n8n'] as const) {
      expect(compilePackagedPrompt(scope).length).toBeLessThan(raw.length)
    }
  })
})
