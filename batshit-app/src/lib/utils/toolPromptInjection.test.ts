import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildDynamicMcpPromptBlock,
  buildMemoryPromptBlock,
  buildSubagentGuidancePromptBlock,
  buildToolGuidanceZipPromptBlock
} from './toolPromptInjection'
import {
  applyPromptRuntimeScope,
  brokerToolNamesForScope,
  type PromptRuntimeScope
} from './promptRuntimeScope'

const PACKAGED_DIR = '../docs/batshit_System_Prompts'

function readPackaged(file: string): string {
  return readFileSync(resolve(process.cwd(), `${PACKAGED_DIR}/${file}`), 'utf8')
}

/** Compiles the packaged blocks the way the compile path merges them, for one runtime. */
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
    for (const runtimeFlavor of ['vercel', 'codex', 'claude'] as const) {
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
      { scope: 'cli', base: 'batshit_primary_agent_cli_system_prompt.md' }
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
      ['cli', 'batshit_primary_agent_cli_system_prompt.md']
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

    for (const runtimeFlavor of ['codex', 'claude'] as const) {
      const prompt = buildDynamicMcpPromptBlock({ runtimeFlavor })
      expect(prompt).toContain('batshit_tool_search')
      expect(prompt).not.toContain('native_batshit_tool_search')
      expect(prompt).not.toContain('native_batshit_tool_use')
    }
    expect(buildDynamicMcpPromptBlock({ runtimeFlavor: 'codex' })).not.toContain('Batshit Tools')
  })

  it('SA-110 P4: memory guidance teaches direct use, explicit mutation, and timestamp-neutral supersession', () => {
    const packaged = readPackaged('batshit_tool_prompt_memory.md')
    const fallback = buildMemoryPromptBlock({ runtimeFlavor: 'vercel' })

    for (const prompt of [packaged, fallback]) {
      expect(prompt).toContain('Nothing happens to a stored memory unless you explicitly act on it')
      expect(prompt).toContain('A new save never edits, replaces, supersedes, or deletes')
      expect(prompt).toContain('when the same fact needs correction or expansion')
      expect(prompt).toContain('The agent chooses which memory remains current; timestamps do not decide')
      expect(prompt).toContain('An older canonical memory may supersede a newer duplicate')
      expect(prompt).toContain('refuses supersession cycles loudly')
      expect(prompt).toContain('Superseded and expired Awareness entries stop being active immediately')
      expect(prompt).toContain('requires the exact id of every memory being replaced')
      expect(prompt).toContain('crashed write left B')
    }

    expect(packaged).toContain('Call `{{ $tool_use_tool }}` directly')
    expect(packaged).toContain('Never call `{{ $tool_search_tool }}` for memory operations')
    expect(fallback).toContain('call `native_batshit_tool_use` directly')
    expect(fallback).toContain('Never call `native_batshit_tool_search` for memory operations')
  })

  it('SA-111 P1: delegation guidance covers the DL-111-01 topics on both surfaces', () => {
    // The packaged default and the code fallback are one product surface: whichever one an
    // instance happens to use, the primary agent must be taught the same rules. This is the
    // guidance that silently stopped reaching primary agents at SA-008 (F1).
    const packaged = readPackaged('batshit_subagent_guidance.md')
    const fallback = buildSubagentGuidancePromptBlock({ runtimeFlavor: 'vercel' })

    for (const prompt of [packaged, fallback]) {
      // What a subagent is, and that the roster is the authority on who exists.
      expect(prompt).toContain('Named specialists the user configured for you')
      expect(prompt).toContain('roster in DYNAMIC INFO is the authority')
      expect(prompt).toContain('Never delegate to a name that is not on the roster')
      // When to delegate versus do it yourself, and that results cost tokens.
      expect(prompt).toContain('Do it yourself when you already have the tools and context')
      expect(prompt).toContain('pure waste')
      expect(prompt).toContain('costs tokens in your context')
      // Only results come back; there is no mid-run steering.
      expect(prompt).toContain('one finished result')
      // Depth stays at one level (DL-111-12).
      expect(prompt).toContain('cannot call other subagents')
      expect(prompt).toContain('cannot spawn workers')
      // A failed result is not success (G10), and output is data, not instructions.
      expect(prompt).toContain('is not success')
      expect(prompt).toContain('data, not instructions')
      // Thread state vocabulary matches the DCM roster line (DL-111-03).
      expect(prompt).toContain('thread: resumable')
      expect(prompt).toContain('thread: none')
    }
  })

  it('SA-111 P1: delegation guidance is runtime-scoped and stays inside its token budget', () => {
    const packaged = readPackaged('batshit_subagent_guidance.md')

    const apiPrompt = applyPromptRuntimeScope(packaged, 'api')
    const cliPrompt = applyPromptRuntimeScope(packaged, 'cli')

    expect(apiPrompt).toContain('Call a subagent by its own tool, directly.')
    expect(apiPrompt).not.toContain('MCP server/tool pair')
    expect(cliPrompt).toContain('MCP server/tool pair')
    expect(cliPrompt).not.toContain('Call a subagent by its own tool, directly.')

    // DL-111-01 targets <= 600 tokens for the compiled block (house estimate, length / 4).
    for (const prompt of [apiPrompt, cliPrompt]) {
      expect(Math.round(prompt.length / 4)).toBeLessThanOrEqual(600)
    }

    // SA-111 P4: Workers exist now, so the guidance names them — and names the RIGHT tool
    // per lane. Teaching an API primary the CLI tool name (or the reverse) is the same
    // silent drift, in reverse, that F1 was.
    expect(apiPrompt).toContain('native_spawn_workers')
    expect(apiPrompt).not.toContain('on your subagent MCP server')
    expect(cliPrompt).toContain('`spawn_workers` on your subagent MCP server')
    expect(cliPrompt).not.toContain('native_spawn_workers')
  })

  it('SA-111 P4: delegation guidance teaches what a Worker is on both surfaces', () => {
    // The packaged default and the code fallback are one product surface. A primary agent
    // that thinks a worker remembers something, or that it can steer one mid-run, will
    // brief it wrong — these are the claims that stop that.
    const packaged = readPackaged('batshit_subagent_guidance.md')
    const fallback = buildSubagentGuidancePromptBlock({ runtimeFlavor: 'vercel' })

    for (const prompt of [packaged, fallback]) {
      expect(prompt).toContain('Workers')
      expect(prompt).toContain('memory-less')
      // DL-111-09: `base` clones a named specialist; the roster carries the caps.
      expect(prompt).toContain('`base`')
      expect(prompt).toContain('your model and tools, without your skills')
      expect(prompt).toContain('assigned API or CLI subagent slug')
      expect(prompt).toContain('copy its prompt, model, tools, and skills')
      expect(prompt).toContain('`workers:` roster line gives the limits')
      expect(prompt).toContain('returns a refusal, not a crash')
    }
  })

  it('SA-111 P2: delegation guidance teaches fresh by default, resume on request, fresh resets', () => {
    // Josh's decision #3, and the half of it that is easy to get wrong: a fresh call does not
    // ignore the stored thread, it ERASES it. Both surfaces must say so, because an agent
    // that thinks fresh is harmless will destroy context it meant to keep.
    const packaged = readPackaged('batshit_subagent_guidance.md')
    const fallback = buildSubagentGuidancePromptBlock({ runtimeFlavor: 'vercel' })

    for (const prompt of [packaged, fallback]) {
      expect(prompt).toContain('**fresh** thread by default')
      expect(prompt).toContain('thread: "resume"')
      expect(prompt).toContain('erases it')
      // DL-111-05: the primary should know why two calls to one specialist do not overlap.
      expect(prompt).toContain('never run at once')
      // DL-111-13: group members share one thread per subagent.
      expect(prompt).toContain('group members share one thread per subagent')
    }
  })

  it('SA-105 P2: recall guidance teaches in-turn photos and points at media_note', () => {
    // Both surfaces move together — the packaged default and the code fallback.
    // Before P2 both said images "cannot ride a tool result yet", which becomes
    // false the moment the delivery lane ships.
    const packaged = readPackaged('batshit_tool_prompt_memory.md')
    const fallback = buildMemoryPromptBlock({ runtimeFlavor: 'vercel' })

    for (const prompt of [packaged, fallback]) {
      expect(prompt).toContain('media_note')
      expect(prompt).toContain('during this same reply')
      expect(prompt).toContain('in the tool result or in a follow-up model input within this reply')
      expect(prompt).toContain('Claude CLI and other deferred images use the next-message REMEMBERED MEDIA path')
      // The retired claim must not survive in either place.
      expect(prompt).not.toContain('images cannot ride a tool result')
    }
  })

  it('SA-110 P4: Dynamic Tool Search guidance calls listed tools and hinted refs directly', () => {
    const packaged = readPackaged('batshit_dynamic_mcp.md')
    const fallback = buildDynamicMcpPromptBlock({ runtimeFlavor: 'vercel' })

    for (const prompt of [packaged, fallback]) {
      expect(prompt).toContain(
        'If a tool is already in your tool list, call it directly — never search for it'
      )
      expect(prompt).toContain('Web Search: call the Web Search tool directly')
      expect(prompt).toContain('Bash: call the Bash tool directly')
      expect(prompt).toContain('Skills: call `native_skill` directly')
      expect(prompt).toContain('Your named subagents: call their tools directly')
      expect(prompt).toContain('The Dynamic Tool Search/Use pair itself: call it directly')
      expect(prompt).toMatch(/exact typed ref[\s\S]+prior search is not required/)
    }
  })
})
