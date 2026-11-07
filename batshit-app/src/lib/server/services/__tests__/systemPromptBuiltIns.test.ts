// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_ONLY_PROMPT_IDS,
  builtInOnlyPrompt,
  builtInPartsFor,
  formatBuiltInText,
  formatStoredBuiltInText
} from '../systemPromptBuiltIns'
import { listCoreSystemPromptDefinitions } from '../systemPromptRegistry'
import {
  buildToolGuidanceZipPromptBlock,
  buildWorkingContextGuidance
} from '$lib/utils/toolPromptInjection'
import { resolveApiReasoningRetention } from '$lib/utils/reasoningRetention'
import { describeAgentSetup } from '../agentSetupCache'

/**
 * Josh (2026-10-23): every system prompt an agent gets must be readable in Admin. The built-in text
 * comes from the builders the compile calls, and no packaged prompt may carry a code-filled
 * guidance placeholder that Admin cannot show.
 */
const PACKAGED_DIR = resolve(process.cwd(), '../docs/batshit_System_Prompts')

describe('systemPromptBuiltIns', () => {
  // SA-139 R4: the CLI part left with the Claude Code CLI Primary; API agents are the one lane.
  it('shows the zip guidance the compile builds, for API agents, with the settings it assumes', () => {
    const parts = builtInPartsFor('tool_guidance_zip')
    expect(parts.map((part) => part.placeholder)).toEqual(['{{ $api_tool_zip_guidance }}'])
    expect(parts[0].text).toBe(buildToolGuidanceZipPromptBlock())
    expect(parts[0].settings).toContain('Refreshed File Reads off')
  })

  // Decision 11 (option A): the memory guidance is one stored text for both lanes, with no
  // code-filled placeholder, so Admin shows it as stored text and has no built-in part for it.
  it('has no built-in part for the memory guidance, which is all stored text', () => {
    expect(builtInPartsFor('tool_guidance_memory')).toEqual([])
    const packaged = readFileSync(resolve(PACKAGED_DIR, 'batshit_tool_prompt_memory.md'), 'utf8')
    expect(packaged).not.toContain('api_memory_guidance')
  })

  it('lists Maintaining Your Working Context as a built-in-only section with the factory text', () => {
    expect(BUILT_IN_ONLY_PROMPT_IDS).toEqual(['working_context', 'agent_setup'])
    const section = builtInOnlyPrompt('working_context')
    expect(section?.label).toBe('Maintaining Your Working Context')
    expect(section?.parts[0].placeholder).toBeNull()
    expect(section?.parts[0].text).toBe(buildWorkingContextGuidance({
      settings: resolveApiReasoningRetention({}), toolNotesEnabled: true, whiteboardAvailable: true, toolZipBlockSent: true
    }))
    expect(section?.parts[0].text.startsWith('# Your Whiteboard\n\nAs discussed earlier, Batshit manages your context')).toBe(true)
    expect(builtInPartsFor('working_context')).toEqual(section?.parts)
  })

  it('explains generated Agent Setup read-only without reading live agent state', () => {
    const section = builtInOnlyPrompt('agent_setup')!
    expect(section.label).toBe('Agent Setup')
    expect(section.parts[0].placeholder).toBeNull()
    expect(section.parts[0].text).toBe(describeAgentSetup())
    expect(section.parts[0].text).toContain('budget applies only to scalable tool-hint groups')
    expect(builtInPartsFor('agent_setup')).toEqual(section.parts)
  })

  it('has nothing to show for a prompt that is all stored text, or an unknown id', () => {
    for (const id of ['api_primary', 'cli_primary', 'dm_guidance', 'nope']) expect(builtInPartsFor(id)).toEqual([])
    expect(builtInOnlyPrompt('api_primary')).toBeNull()
  })

  it('formats each part under a header that names its placeholder and its settings', () => {
    const text = formatBuiltInText(builtInPartsFor('tool_guidance_zip'))
    expect(text.startsWith('Agents: fills {{ $api_tool_zip_guidance }}\nShown with: An agent with the factory settings')).toBe(true)
    // One part, so no separator and no CLI header (SA-139 R4).
    expect(text).not.toContain('\n\n--------------------------------------------------\n\n')
    expect(text).not.toContain('CLI agents: fills')
    expect(formatBuiltInText(builtInOnlyPrompt('working_context')!.parts).startsWith('Agents\nShown with: The factory settings')).toBe(true)
  })

  it('every placeholder it fills is in that prompt’s packaged default', () => {
    for (const definition of listCoreSystemPromptDefinitions()) {
      const packaged = readFileSync(resolve(PACKAGED_DIR, definition.defaultFile), 'utf8')
      for (const part of builtInPartsFor(definition.id)) {
        expect({ id: definition.id, has: packaged.includes(part.placeholder ?? '') }).toEqual({ id: definition.id, has: true })
      }
    }
  })

  // Review F4: the compile's own placeholder rule (`promptVariables.ts`), so a placeholder written
  // another way or named another way cannot slip past.
  const PLAIN_VALUE_PLACEHOLDERS = new Set([
    'tool_search_tool', 'tool_use_tool', 'runtime_flavor', 'zip_ai_view_mode', 'zip_tool_notes_enabled',
    'current_date', 'current_time', 'current_datetime', 'current_timezone', 'buffer_size', 'buffer_terminal',
    'buffer_diff', 'buffer_error', 'buffer_subagent', 'threshold_terminal', 'threshold_diff', 'threshold_error',
    'threshold_subagent', 'model_name', 'model_provider', 'model_temperature', 'agent_name', 'agent_id'
  ])

  it('every placeholder in a packaged prompt is a plain value or text Admin can show', () => {
    const covered = new Set(
      listCoreSystemPromptDefinitions().flatMap((definition) =>
        builtInPartsFor(definition.id).map((part) => /\$(\w+)/.exec(part.placeholder ?? '')?.[1]))
    )
    for (const file of readdirSync(PACKAGED_DIR).filter((name) => name.endsWith('.md'))) {
      const text = readFileSync(resolve(PACKAGED_DIR, file), 'utf8')
      for (const match of text.matchAll(/\{\{\s*\$(\w+)\s*\}\}/g)) {
        const shown = covered.has(match[1]) || PLAIN_VALUE_PLACEHOLDERS.has(match[1])
        expect({ file, placeholder: match[0], shown }).toEqual({ file, placeholder: match[0], shown: true })
      }
    }
  })

  it('shows a stored prompt’s built-in text as sent: a removed placeholder is named as not sent', () => {
    const packaged = readFileSync(resolve(PACKAGED_DIR, 'batshit_tool_prompt_zips.md'), 'utf8')
    expect(formatStoredBuiltInText('tool_guidance_zip', packaged)).toBe(formatBuiltInText(builtInPartsFor('tool_guidance_zip')))
    // The compile fills `{{$x}}` written without spaces too.
    expect(formatStoredBuiltInText('tool_guidance_zip', packaged.replace('{{ $api_tool_zip_guidance }}', '{{$api_tool_zip_guidance}}')))
      .toBe(formatBuiltInText(builtInPartsFor('tool_guidance_zip')))
    // SA-139 R4: one part, so a removed API placeholder means nothing built in is sent.
    const NOT_SENT = 'Not sent: the saved prompt no longer contains {{ $api_tool_zip_guidance }}, so Batshit sends no built-in text there. Reset the prompt to bring it back.'
    expect(formatStoredBuiltInText('tool_guidance_zip', packaged.replace('{{ $api_tool_zip_guidance }}', ''))).toBe(NOT_SENT)
    expect(formatStoredBuiltInText('tool_guidance_zip', 'Admin text only.')).toBe(NOT_SENT)
    expect(formatStoredBuiltInText('api_primary', 'anything')).toBeNull()
  })
})
