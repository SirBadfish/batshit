import type { GroupChatSessionConfig, GroupChatSpeakPolicy } from '$lib/types/groupChat'
import {
  GROUP_CHAT_SESSION_DEFAULTS,
  normalizeGroupMaxAgents,
  normalizeGroupMaxFollowupsTotal
} from '$lib/types/groupChat'
import { EMOTE_TAG_REGEX_SOURCE, controlTag } from '$lib/utils/controlTags'

export type GroupControlMode = 'responding' | 'listening'

export type LeadingGroupControlParseResult =
  | { kind: 'pending' }
  | { kind: 'passthrough'; content: string }
  | {
      kind: 'control'
      mode: GroupControlMode
      payload: Record<string, any> | null
      remaining: string
    }

// Tag identity comes from the shared control-tag registry (SA-104 P1); the
// group-protocol lead-parsing and presentation-strip mechanics stay here.
const GROUP_TAG = controlTag('group').tag
const CUE_TAG = controlTag('cue').tag
const GROUP_CONTROL_TAG_PREFIX = `<${GROUP_TAG}`
const GROUP_CONTROL_TAG_BLOCK_REGEX = new RegExp(
  `^\\s*<${GROUP_TAG}\\b[^>]*>([\\s\\S]*?)<\\/${GROUP_TAG}>`,
  'i'
)
const GROUP_CONTROL_BUFFER_LIMIT = 2000
const GROUP_PRESENTATION_CUE_BLOCK_REGEX = new RegExp(
  `<${CUE_TAG}\\b[^>]*>[\\s\\S]*?<\\/${CUE_TAG}>`,
  'gi'
)
const GROUP_PRESENTATION_CUE_TAIL_REGEX = new RegExp(`<${CUE_TAG}\\b[\\s\\S]*$`, 'gi')
const GROUP_LEADING_PRESENTATION_CUE_BLOCK_REGEX = new RegExp(
  `^\\s*<${CUE_TAG}\\b[^>]*>[\\s\\S]*?<\\/${CUE_TAG}>`,
  'i'
)
const GROUP_LEADING_PRESENTATION_CUE_START_REGEX = new RegExp(`^\\s*<${CUE_TAG}\\b`, 'i')
const GROUP_EMOTE_TAG_REGEX = new RegExp(EMOTE_TAG_REGEX_SOURCE, 'gi')
const GROUP_LEADING_EMOTE_TAG_REGEX =
  /^\s*<(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?\b[^>]*\/>[ \t]*|^\s*<(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?\b[^>]*>[\s\S]*?<\/(?:emote|goon-emote)(?:-[a-zA-Z0-9_-]+)?>[ \t]*/i
const GROUP_GOON_STAGE_DIRECTION_REGEX = /\*goon:\s*[^*]*\*[ \t]*/gi
const GROUP_LEADING_GOON_STAGE_DIRECTION_REGEX = /^\s*\*goon:\s*[^*]*\*[ \t]*/i

function normalizeGroupControlMode(value: unknown): GroupControlMode {
  if (typeof value !== 'string') return 'responding'
  return value.toLowerCase() === 'listening' ? 'listening' : 'responding'
}

function stripLeadingGroupPresentationControlsForParsing(
  content: string,
  bufferLimit: number
): { kind: 'ready'; content: string } | { kind: 'pending' } | { kind: 'passthrough'; content: string } {
  let remaining = content
  let guard = 0

  while (guard < 10) {
    guard += 1

    const cueMatch = remaining.match(GROUP_LEADING_PRESENTATION_CUE_BLOCK_REGEX)
    if (cueMatch) {
      remaining = remaining.slice(cueMatch[0].length)
      continue
    }

    if (GROUP_LEADING_PRESENTATION_CUE_START_REGEX.test(remaining)) {
      return remaining.length >= bufferLimit ? { kind: 'passthrough', content: '' } : { kind: 'pending' }
    }

    const emoteMatch = remaining.match(GROUP_LEADING_EMOTE_TAG_REGEX)
    if (emoteMatch) {
      remaining = remaining.slice(emoteMatch[0].length)
      continue
    }

    const goonMatch = remaining.match(GROUP_LEADING_GOON_STAGE_DIRECTION_REGEX)
    if (goonMatch) {
      remaining = remaining.slice(goonMatch[0].length)
      continue
    }

    break
  }

  return { kind: 'ready', content: remaining }
}

export function parseLeadingGroupControlFromBuffer(
  buffer: string,
  bufferLimit = GROUP_CONTROL_BUFFER_LIMIT
): LeadingGroupControlParseResult {
  const rawContent = typeof buffer === 'string' ? buffer : ''
  const leadingControlResult = stripLeadingGroupPresentationControlsForParsing(
    rawContent,
    bufferLimit
  )
  if (leadingControlResult.kind === 'pending') {
    return { kind: 'pending' }
  }
  if (leadingControlResult.kind === 'passthrough') {
    return { kind: 'passthrough', content: leadingControlResult.content }
  }

  const content = leadingControlResult.content
  const trimmed = content.trimStart()
  if (trimmed) {
    const isControlPrefix =
      GROUP_CONTROL_TAG_PREFIX.startsWith(trimmed) ||
      trimmed.startsWith(GROUP_CONTROL_TAG_PREFIX)
    const isControlStart = /^<batshit-group\b/i.test(trimmed)
    if (!isControlPrefix && !isControlStart) {
      return { kind: 'passthrough', content }
    }
  }

  const tagStartMatch = content.match(/\s*<batshit-group\b/i)
  if (!tagStartMatch) {
    return content.length >= bufferLimit ? { kind: 'passthrough', content } : { kind: 'pending' }
  }

  const startIndex = tagStartMatch.index ?? 0
  let parseTarget = content
  if (startIndex > 0) {
    const prefix = content.slice(0, startIndex)
    if (prefix.trim().length > 0) {
      return { kind: 'passthrough', content }
    }
    parseTarget = content.slice(startIndex)
  }

  const blockMatch = parseTarget.match(GROUP_CONTROL_TAG_BLOCK_REGEX)
  if (!blockMatch || blockMatch.index !== 0) {
    return parseTarget.length >= bufferLimit
      ? { kind: 'passthrough', content: parseTarget }
      : { kind: 'pending' }
  }

  const payloadText = (blockMatch[1] ?? '').trim()
  let payload: Record<string, any> | null = null
  try {
    const parsed = payloadText ? JSON.parse(payloadText) : null
    payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    payload = null
  }

  return {
    kind: 'control',
    mode: normalizeGroupControlMode(payload?.mode),
    payload,
    remaining: parseTarget.slice(blockMatch[0].length)
  }
}

export function stripRepeatedLeadingGroupControlBlocks(content: string): string {
  if (!content) return content
  let remaining = content
  let guard = 0
  while (guard < 10) {
    guard += 1
    const blockMatch = remaining.match(GROUP_CONTROL_TAG_BLOCK_REGEX)
    if (!blockMatch || blockMatch.index !== 0) break
    remaining = remaining.slice(blockMatch[0].length)
  }
  return remaining
}

export function stripGroupChatPresentationControls(content: string): string {
  if (!content) return content
  return content
    .replace(GROUP_PRESENTATION_CUE_BLOCK_REGEX, '')
    .replace(GROUP_PRESENTATION_CUE_TAIL_REGEX, '')
    .replace(GROUP_EMOTE_TAG_REGEX, '')
    .replace(GROUP_GOON_STAGE_DIRECTION_REGEX, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeGroupChatConfig(raw: any): GroupChatSessionConfig | null {
  if (!raw || typeof raw !== 'object') return null

  const safe = raw as Partial<GroupChatSessionConfig>
  const agentIds = Array.isArray(safe.agent_ids)
    ? safe.agent_ids
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)
    : []
  const sharedToolsSource: unknown[] = Array.isArray((safe as any).shared_tools)
    ? (safe as any).shared_tools
    : Array.isArray((safe as any).zip_settings?.shared_tools)
      ? (safe as any).zip_settings.shared_tools
      : GROUP_CHAT_SESSION_DEFAULTS.shared_tools ?? []
  const sharedTools = Array.from(
    new Set(
      sharedToolsSource
        .map((toolName: unknown) => (typeof toolName === 'string' ? toolName.trim() : ''))
        .filter((toolName): toolName is string => toolName.length > 0)
    )
  )

  return {
    enabled: Boolean(safe.enabled),
    layout: 'interleaved',
    agent_ids: Array.from(new Set(agentIds)),
    agent_settings:
      safe.agent_settings && typeof safe.agent_settings === 'object'
        ? safe.agent_settings
        : {},
    group_system_prompt:
      typeof safe.group_system_prompt === 'string'
        ? safe.group_system_prompt
        : null,
    max_followups_total: normalizeGroupMaxFollowupsTotal(
      safe.max_followups_total,
      GROUP_CHAT_SESSION_DEFAULTS.max_followups_total ?? 5
    ),
    max_agents: normalizeGroupMaxAgents(
      safe.max_agents,
      GROUP_CHAT_SESSION_DEFAULTS.max_agents ?? 4
    ),
    driver_mode:
      typeof safe.driver_mode === 'boolean'
        ? safe.driver_mode
        : GROUP_CHAT_SESSION_DEFAULTS.driver_mode,
    driver_agent_id:
      typeof safe.driver_agent_id === 'string'
        ? safe.driver_agent_id
        : GROUP_CHAT_SESSION_DEFAULTS.driver_agent_id ?? null,
    shared_tools: sharedTools,
    // Group-level zip overrides are retired. Group chat inherits per-agent/global zip behavior.
    zip_settings: null
  }
}

export function buildSpeakPolicyInstructions(
  policy: GroupChatSpeakPolicy,
  topics?: string[]
) {
  const lines: string[] = []
  switch (policy) {
    case 'none':
      lines.push('Speaking preset: none (you decide freely).')
      break
    case 'balanced':
      lines.push('Speaking preset: balanced (speak when you add clear value).')
      break
    case 'quiet':
      lines.push('Speaking preset: quiet (prefer silence unless you add unique value).')
      break
    case 'only_when_asked':
      lines.push('Speaking preset: only when asked (speak only if the user addresses you).')
      break
    case 'topic_only':
      lines.push(
        `Speaking preset: topic-only (${(topics ?? []).join(', ') || 'no topics set'}).`
      )
      break
    default:
      break
  }

  return lines.join('\n')
}

const ADDRESS_BOUNDARY = '[^a-z0-9_]'

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeAlias(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function buildAliasPattern(alias: string) {
  return escapeRegExp(alias).replace(/\s+/g, '\\s+')
}

function aliasMatches(text: string, alias: string) {
  if (!alias) return false
  const aliasPattern = buildAliasPattern(alias)
  const directMention = new RegExp(`(^|\\s)@${aliasPattern}(?=$|${ADDRESS_BOUNDARY})`, 'i')
  if (directMention.test(text)) return true

  const inlineMention = new RegExp(
    `(^|${ADDRESS_BOUNDARY})${aliasPattern}(?=$|${ADDRESS_BOUNDARY})`,
    'i'
  )
  return inlineMention.test(text)
}

export function isAgentAddressed(content: string, agentName: string, aliases: string[] = []) {
  const text = typeof content === 'string' ? content : ''
  if (!text.trim()) return false

  const candidateAliases = new Set<string>()
  const seedAliases = [agentName, ...aliases]
  for (const value of seedAliases) {
    if (typeof value !== 'string') continue
    const normalized = normalizeAlias(value)
    if (!normalized) continue
    candidateAliases.add(normalized)
    if (normalized.includes(' ')) {
      candidateAliases.add(normalized.replace(/\s+/g, '_'))
      candidateAliases.add(normalized.replace(/\s+/g, '-'))
    }
  }

  for (const alias of candidateAliases) {
    if (aliasMatches(text, alias)) return true
  }

  return false
}

export function matchesTopic(content: string, topics?: string[]) {
  if (!topics || topics.length === 0) return false
  const text = content.toLowerCase()
  return topics.some((topic) => topic && text.includes(topic.toLowerCase()))
}

export function buildInterAgentPrompt(options?: {
  sourceAgentName?: string
  message?: string
}) {
  const agentName = options?.sourceAgentName ? `Agent ${options.sourceAgentName}` : 'Another agent'
  const message = options?.message?.trim()
  return [
    `${agentName} just spoke in the group chat.`,
    message ? `${agentName} said:\n${message}` : null,
    'If you have new, non-redundant value, respond. Otherwise, stay silent.'
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildGroupSystemPromptAddendum(options: {
  agentName: string
  policy: GroupChatSpeakPolicy
  topics?: string[]
  eventIndex?: number
  driverMode?: boolean
  driverAgentName?: string | null
  isDriver?: boolean
}) {
  const { agentName, policy, topics, eventIndex, driverMode, driverAgentName, isDriver } = options
  const policyLines = buildSpeakPolicyInstructions(policy, topics)
  const driverLine =
    driverMode && driverAgentName
      ? isDriver
        ? 'Driver mode is ON: you are the default first responder for user turns.'
        : `Driver mode is ON: ${driverAgentName} is the default first responder for user turns.`
      : null

  return [
    '==== GROUP CHAT MODE ====',
    `You are ${agentName} in a multi-agent group conversation.`,
    eventIndex !== undefined ? `Event ${eventIndex}: respond only if you add new value.` : null,
    'Control contract (required):',
    '1) First non-whitespace output must be exactly one <batshit-group> JSON block.',
    '2) Use {"mode":"responding"} when speaking, or {"mode":"listening"} when staying silent.',
    '3) If mode is "listening", output only that control tag and stop immediately.',
    'Never output any text, markdown, or XML before the control tag.',
    'Group chat does not support Goon mood/cue controls. Do not emit <batshit-cue>, <emote>, or *goon:* markup in group chat, and do not copy those blocks from earlier history.',
    driverLine,
    policyLines
  ]
    .filter(Boolean)
    .join('\n')
}
