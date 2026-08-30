import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildDynamicMcpPromptBlock, buildToolGuidanceZipPromptBlock } from './toolPromptInjection'
import {
  applyPromptRuntimeScope,
  brokerToolNamesForScope,
  type PromptRuntimeScope
} from './promptRuntimeScope'

const PACKAGED_DIR = '../docs/batshit_System_Prompts'

function readPackaged(file: string): string {
  return readFileSync(resolve(process.cwd(), `${PACKAGED_DIR}/${file}`), 'utf8')
}

/** Compiles the packaged blocks the way both twins merge them, for one runtime. */
function compilePackagedPrompt(scope: PromptRuntimeScope, basePromptFile: string): string {
  const names = brokerToolNamesForScope(scope)
  const render = (file: string) =>
    applyPromptRuntimeScope(readPackaged(file), scope)
      .replaceAll('{{ $tool_search_tool }}', names.search)
      .replaceAll('{{ $tool_use_tool }}', names.use)

  return [
    `==== BASE ====\n\n${render(basePromptFile)}`,
    `==== TOOL + ZIP GUIDANCE (ZIP CONTROL ENABLED) ====\n\n${render(
      'batshit_tool_prompt_zip_control_enabled.md'
    )}`,
    `==== DYNAMIC TOOL SEARCH / DISCOVERY (WHEN ENABLED) ====\n\n${render(
      'batshit_dynamic_mcp.md'
    )}`
  ].join('\n\n')
}

describe('buildToolGuidanceZipPromptBlock', () => {
  it('defaults the AI zip view to appended', () => {
    expect(buildToolGuidanceZipPromptBlock()).toContain('Zip AI view: appended')
  })

  it('honors an explicit inline AI zip view', () => {
    expect(buildToolGuidanceZipPromptBlock({ zipAiViewMode: 'inline' })).toContain(
      'Zip AI view: inline'
    )
  })

  it('teaches one-based current tool result aliases when agent control is enabled', () => {
    const prompt = buildToolGuidanceZipPromptBlock({ zipControlPermission: 'agent' })

    expect(prompt).toContain('Treat natural-language requests as zip-control requests')
    expect(prompt).toContain('the user does not need to mention Batshit zip control')
    expect(prompt).toContain('use `tool_result_N`')
    expect(prompt).toContain('Never use `tool_result_0`')
    expect(prompt).toContain('"unzip":["tool_result_1","tool_result_3"],"zip":["zipId"]')
    expect(prompt).toContain('not private reasoning and not a place for private instructions')
    expect(prompt).toContain('user-visible through an expandable Tool Results Summary panel')
    expect(prompt).toContain('Batshit strips the raw XML/JSON syntax')
    expect(prompt).not.toContain('keepUnzipped')
    expect(prompt).not.toContain('rezip')
    expect(prompt).not.toContain('toolCallId list')
    expect(prompt).not.toContain('"keepUnzipped":["toolCallId"]')
  })

  it('keeps the packaged zip-enabled Admin reset prompt aligned with tool result aliases', () => {
    const prompt = readFileSync(
      resolve(
        process.cwd(),
        '../docs/batshit_System_Prompts/batshit_tool_prompt_zip_control_enabled.md'
      ),
      'utf8'
    )

    expect(prompt).toContain('use `tool_result_N`')
    expect(prompt).toContain('Never use `tool_result_0`')
    expect(prompt).toContain('Treat natural-language requests as zip-control requests')
    expect(prompt).toContain('not private reasoning and not a place for private instructions')
    expect(prompt).toContain('Tool Results Summary notes are user-visible')
    expect(prompt).toContain('raw XML/JSON syntax is stripped')
    expect(prompt).toContain('"unzip":["tool_result_1","tool_result_3"],"zip":["zipId"]')
    expect(prompt).not.toContain('hidden block')
    expect(prompt).not.toContain('Use `zipId` for every zip-control action.')
  })

  it('keeps natural unzip requests explicit when zip control is user-only', () => {
    const prompt = buildToolGuidanceZipPromptBlock({ zipControlPermission: 'user' })

    expect(prompt).toContain('Treat natural-language requests such as "keep this unzipped"')
    expect(prompt).toContain('Because zip control is disabled for you here')
    expect(prompt).toContain('Do NOT include unzip/zip actions')
  })

  it('keeps the packaged zip-disabled Admin reset prompt aligned with user-only zip control', () => {
    const prompt = readFileSync(
      resolve(
        process.cwd(),
        '../docs/batshit_System_Prompts/batshit_tool_prompt_zip_control_disabled.md'
      ),
      'utf8'
    )

    expect(prompt).toContain('Treat natural-language requests such as "keep this unzipped"')
    expect(prompt).toContain('Because zip control is disabled for you here')
    expect(prompt).toContain('Do NOT include unzip/zip action arrays')
    expect(prompt).toContain('not private reasoning and not a place for private instructions')
    expect(prompt).toContain('Tool Results Summary notes are user-visible')
    expect(prompt).toContain('the user can expand that panel')
    expect(prompt).not.toContain('Never show this block to the user')
  })

  it('SA-096 P1: the fallback tool prompt no longer restates broker guidance', () => {
    // Broker guidance lives in the discovery block alone. Both blocks normally ship
    // together, so restating it here was the duplication P1 removed.
    for (const runtimeFlavor of ['vercel', 'codex', 'claude', 'n8n'] as const) {
      const prompt = buildToolGuidanceZipPromptBlock({ runtimeFlavor })

      expect(prompt).not.toContain('family="cli"')
      expect(prompt).not.toContain('cli: ref')
      expect(prompt).not.toContain('Do not invent placeholder tool ids')
      expect(prompt).not.toContain('their own tool lane')

      // Fetch Zip is the one broker ref this block still needs, and it names the tool the
      // receiving agent actually has (DL-4).
      expect(prompt).toContain('fabric:sys.zip.fetch')
      if (runtimeFlavor === 'vercel') {
        expect(prompt).toContain('native_batshit_tool_use')
      } else {
        expect(prompt).toContain('batshit_tool_use')
        expect(prompt).not.toContain('native_batshit_tool_use')
      }
    }
  })

  it('SA-096 P1: the packaged tool prompts no longer restate broker guidance', () => {
    for (const file of [
      'batshit_tool_prompt_zip_control_enabled.md',
      'batshit_tool_prompt_zip_control_disabled.md'
    ]) {
      const prompt = readFileSync(
        resolve(process.cwd(), `../docs/batshit_System_Prompts/${file}`),
        'utf8'
      )

      expect(prompt).not.toContain('## Dynamic Tool Search (When Selected)')
      expect(prompt).not.toContain('Never invent placeholder refs')
      expect(prompt).not.toContain('Runtime-specific names:')
      // The Fetch Zip instruction resolves the broker name per runtime instead of listing
      // every runtime's name inline.
      expect(prompt).toContain('{{ $tool_use_tool }}')
      expect(prompt).not.toContain('`native_batshit_tool_use` for API agents')
    }
  })

  it('SA-096 P1: the packaged API base prompt no longer restates the bash policy', () => {
    const prompt = readFileSync(
      resolve(
        process.cwd(),
        '../docs/batshit_System_Prompts/batshit_primary_agent_api_system_prompt.md'
      ),
      'utf8'
    )

    // The fuller treatment lives in the tool + zip block, which always ships for API agents.
    expect(prompt).not.toContain('POLICY_BLOCKED')
    expect(prompt).not.toContain('native_bash')
    expect(prompt).toContain('==== DYNAMIC INFO ====')

    for (const toolPrompt of [
      'batshit_tool_prompt_zip_control_enabled.md',
      'batshit_tool_prompt_zip_control_disabled.md'
    ]) {
      const surviving = readFileSync(
        resolve(process.cwd(), `../docs/batshit_System_Prompts/${toolPrompt}`),
        'utf8'
      )
      expect(surviving).toContain('POLICY_BLOCKED')
      expect(surviving).toContain('native_bash')
      expect(surviving).toContain('provide the patch or handoff')
    }
  })

  it('SA-096 P1: the packaged tool prompts state the Fetch Zip contract exactly once', () => {
    for (const file of [
      'batshit_tool_prompt_zip_control_enabled.md',
      'batshit_tool_prompt_zip_control_disabled.md'
    ]) {
      const prompt = readFileSync(
        resolve(process.cwd(), `../docs/batshit_System_Prompts/${file}`),
        'utf8'
      )
      const refMentions = prompt.split('fabric:sys.zip.fetch').length - 1
      expect({ file, refMentions }).toEqual({ file, refMentions: 1 })
    }
  })

  it('SA-096 P1: no instruction appears twice in the merged packaged prompt', () => {
    // The acceptance criterion, checked on the packaged path. The parity harness's S16
    // checks the same property on the code-fallback path, which uses different text.
    const CASES: Array<{ scope: PromptRuntimeScope; base: string }> = [
      { scope: 'api', base: 'batshit_primary_agent_api_system_prompt.md' },
      { scope: 'cli', base: 'batshit_primary_agent_cli_system_prompt.md' },
      { scope: 'n8n', base: 'batshit_primary_agent_n8n_system_prompt.md' }
    ]

    const SINGLE_OCCURRENCE = [
      'Never invent placeholder refs',
      'Never flatten required fields to the top level',
      'Prefer the broker over bash',
      'POLICY_BLOCKED',
      'native_bash',
      'fabric:sys.zip.fetch',
      'Do not call `native_skill`'
    ]

    for (const { scope, base } of CASES) {
      const merged = compilePackagedPrompt(scope, base)
      for (const needle of SINGLE_OCCURRENCE) {
        const n = merged.split(needle).length - 1
        expect({ scope, needle, n }).toEqual({ scope, needle, n: 1 })
      }
    }
  })

  it('SA-096 P1: the merged packaged prompt only names the receiving runtime\'s broker tools', () => {
    const api = compilePackagedPrompt('api', 'batshit_primary_agent_api_system_prompt.md')
    expect(api).not.toMatch(/(^|[^_])\bbatshit_tool_search\b/)
    expect(api).not.toMatch(/(^|[^_])\bbatshit_tool_use\b/)

    for (const [scope, base] of [
      ['cli', 'batshit_primary_agent_cli_system_prompt.md'],
      ['n8n', 'batshit_primary_agent_n8n_system_prompt.md']
    ] as Array<[PromptRuntimeScope, string]>) {
      const merged = compilePackagedPrompt(scope, base)
      expect(merged).not.toContain('native_batshit_tool_search')
      expect(merged).not.toContain('native_batshit_tool_use')
    }
  })

  it('teaches broker-first discovery in the Dynamic MCP fallback prompt', () => {
    const prompt = buildDynamicMcpPromptBlock({ runtimeFlavor: 'vercel' })

    expect(prompt).toContain('native_batshit_tool_search')
    expect(prompt).toContain('native_batshit_tool_use')
    expect(prompt).toContain('`mcp:...`')
    expect(prompt).not.toContain('native_dynamic_mcp_find')
    expect(prompt).not.toContain('native_dynamic_mcp_use')
  })

  it('SA-096 P1: the Dynamic MCP fallback absorbs the CLI-lane rules it took over', () => {
    const prompt = buildDynamicMcpPromptBlock({ runtimeFlavor: 'vercel' })

    expect(prompt).toContain('`cli:...`')
    expect(prompt).toContain('not raw shell commands')
    expect(prompt).toContain('Prefer the broker over bash')
    expect(prompt).toContain('input.inputFile')
    expect(prompt).toContain('retry with the exact field names')
  })

  it('SA-096 P1: the Dynamic MCP fallback names only the receiving runtime\'s broker tools', () => {
    const api = buildDynamicMcpPromptBlock({ runtimeFlavor: 'vercel' })
    expect(api).not.toMatch(/(^|[^_])\bbatshit_tool_search\b/)
    expect(api).not.toMatch(/(^|[^_])\bbatshit_tool_use\b/)

    for (const runtimeFlavor of ['codex', 'claude', 'n8n'] as const) {
      const prompt = buildDynamicMcpPromptBlock({ runtimeFlavor })
      expect(prompt).toContain('batshit_tool_search')
      expect(prompt).not.toContain('native_batshit_tool_search')
      expect(prompt).not.toContain('native_batshit_tool_use')
    }

    // Only the n8n lane frames the pair as node actions.
    expect(buildDynamicMcpPromptBlock({ runtimeFlavor: 'n8n' })).toContain('Batshit Tools')
    expect(buildDynamicMcpPromptBlock({ runtimeFlavor: 'codex' })).not.toContain('Batshit Tools')
  })
})
