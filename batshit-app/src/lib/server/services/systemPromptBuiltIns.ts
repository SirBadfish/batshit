import {
  buildToolGuidanceZipPromptBlock,
  buildWorkingContextGuidance
} from '$lib/utils/toolPromptInjection'
import { resolveApiReasoningRetention } from '$lib/utils/reasoningRetention'
import { describeAgentSetup } from './agentSetupCache'

/**
 * Josh (2026-10-23): every system prompt an agent gets must be readable in Admin → Core System
 * Prompts. Some text is built in code, not stored: a placeholder the compile fills (the zip
 * guidance) or a whole section with no record (Maintaining Your Working Context). The memory
 * guidance is all stored text since decision 11 (option A: one packaged text for both lanes).
 * This module renders that text read-only for Admin, from the same builders the compile calls,
 * so what Admin shows cannot drift from what agents get.
 *
 * The builders take an agent's settings; Admin shows the factory settings and says which, because
 * a setting that differs changes the matching lines (`settings` on each part).
 */
export interface BuiltInPromptPart {
  /** The placeholder in the stored prompt that this text fills, or null for a section with no record. */
  placeholder: string | null
  /** Who gets it ("API agents"). */
  title: string
  /** The settings the text is shown with, and what changes it. */
  settings: string
  text: string
}

/** A section built entirely in code, with no stored record: listed in Admin as read-only. */
export interface BuiltInOnlyPrompt {
  id: string
  label: string
  description: string
  parts: BuiltInPromptPart[]
}

const ZIP_API_SETTINGS =
  'An agent with the factory settings: Tool Notes on, Refreshed File Reads off, the typed file tools off, the appended Zip view. A setting that differs changes the matching sections.'

/** The built-in text a stored core prompt's placeholders are filled with, or none. */
export function builtInPartsFor(promptId: string): BuiltInPromptPart[] {
  switch (promptId) {
    // SA-139 R4: no compile fills `{{ $cli_tool_zip_guidance }}` with CLI text any more (the CLI
    // Primary lane is gone, and a CLI Subagent's prompt never read this record), so Admin shows the
    // one API part.
    case 'tool_guidance_zip':
      return [
        { placeholder: '{{ $api_tool_zip_guidance }}', title: 'Agents', settings: ZIP_API_SETTINGS,
          text: buildToolGuidanceZipPromptBlock() }
      ]
    default:
      return builtInOnlyPrompt(promptId)?.parts ?? []
  }
}

export const BUILT_IN_ONLY_PROMPT_IDS = ['working_context', 'agent_setup'] as const

/** A section built entirely in code (no stored record), or null. */
export function builtInOnlyPrompt(id: string): BuiltInOnlyPrompt | null {
  if (id === 'agent_setup') return {
    id, label: 'Agent Setup', description: 'Generated runtime facts, skills and tool metadata. Read-only; settings and current access determine its content.',
    parts: [{ placeholder: null, title: 'Primary Agent Setup',
      settings: 'An explanation of generated setup, its live change notes and separate hint accounting. No live user or agent state is read.',
      text: describeAgentSetup() }]
  }
  if (id !== 'working_context') return null
  return {
    id: 'working_context',
    label: 'Maintaining Your Working Context',
    description:
      'Built into Batshit for agents: the Whiteboard, reasoning retention, and Tool Notes. It is the section "MAINTAINING YOUR WORKING CONTEXT" in the agent’s system prompt. Read-only.',
    parts: [
      {
        placeholder: null,
        title: 'Agents',
        settings:
          'The factory settings: reasoning retention Whiteboard, the Whiteboard available, Tool Notes on, after the TOOL + ZIP GUIDANCE block. Without that block it does not open with "As discussed earlier" or name Tool Notes; with Tool Notes off the Whiteboard is the only tool listed; with reasoning kept the reasoning paragraph says so; with no Whiteboard (a group chat, speech-to-speech, Batshit Tools off) the section is "# Your Reasoning", two lines long.',
        text: buildWorkingContextGuidance({
          settings: resolveApiReasoningRetention({}),
          toolNotesEnabled: true,
          whiteboardAvailable: true,
          toolZipBlockSent: true
        })
      }
    ]
  }
}

/** Whether a stored prompt still holds a placeholder, written any way the compile fills it (`promptVariables.ts`). */
function holdsPlaceholder(value: string, placeholder: string): boolean {
  const name = /\$(\w+)/.exec(placeholder)?.[1]
  return Boolean(name && new RegExp(`\\{\\{\\s*\\$${name}\\s*\\}\\}`).test(value))
}

/**
 * Review F2 (2026-10-23): the built-in text of a stored prompt as it is sent, from its saved value:
 * a part whose placeholder an admin removed is not sent, and the viewer says so instead of showing
 * it. Null when the prompt has no built-in text.
 */
export function formatStoredBuiltInText(promptId: string, value: string): string | null {
  const parts = builtInPartsFor(promptId)
  if (parts.length === 0) return null
  const sent = parts.filter((part) => part.placeholder !== null && holdsPlaceholder(value, part.placeholder))
  const notSent = parts.filter((part) => !sent.includes(part))
  const note = notSent.length > 0
    ? `Not sent: the saved prompt no longer contains ${notSent.map((part) => part.placeholder).join(' or ')}, so Batshit sends no built-in text there. Reset the prompt to bring it back.`
    : ''
  return [note, formatBuiltInText(sent)].filter(Boolean).join('\n\n')
}

/** Review F1: every stored prompt the routes answer with says whether it has built-in text. */
export function withBuiltInFlag<T extends { id: string }>(prompt: T): T & { hasBuiltInText: boolean } {
  return { ...prompt, hasBuiltInText: builtInPartsFor(prompt.id).length > 0 }
}

/** One readable text for the read-only viewer: each part under a short header. */
export function formatBuiltInText(parts: readonly BuiltInPromptPart[]): string {
  return parts
    .map((part) =>
      [
        part.placeholder ? `${part.title}: fills ${part.placeholder}` : part.title,
        `Shown with: ${part.settings}`,
        '',
        part.text
      ].join('\n')
    )
    .join('\n\n--------------------------------------------------\n\n')
}

/** The Admin list row of a built-in-only section: the core prompt summary's shape, read-only. */
export function builtInOnlySummary(prompt: BuiltInOnlyPrompt) {
  return {
    id: prompt.id,
    redisKey: '',
    label: prompt.label,
    description: prompt.description,
    warning: '',
    defaultFile: '',
    defaultVersion: '',
    matchesDefault: true,
    customized: false,
    newDefaultAvailable: false,
    lastUpdated: null,
    readOnly: true,
    hasBuiltInText: true
  }
}

/** The answer to a save or reset of a built-in-only section. */
export const BUILT_IN_ONLY_WRITE_REFUSAL = 'This section is built into Batshit and is read-only.'

