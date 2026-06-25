import type { Message } from '$lib/stores/messages.svelte'
import { countMessageTokens } from '$lib/utils/tokenCounter'
import type { ManualTrimProtections } from '$lib/utils/tokenPanel'
import { isMessageProtectedFromManualTrim } from '$lib/utils/tokenPanel'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'

export const AUTO_COMPACT_SMART_TRIGGER_PERCENT = 0.15
export const AUTO_COMPACT_MIN_TRIGGER_TOKENS = 30_000
export const AUTO_COMPACT_MAX_TRIGGER_TOKENS = 80_000
export const AUTO_COMPACT_DEFAULT_KEEP_TAIL_MESSAGES = 0

export type AutoCompactMode = 'off' | 'ask' | 'auto'
export type AutoCompactAgentMode = 'inherit' | AutoCompactMode
export type AutoCompactTriggerMode = 'smart' | 'remaining_tokens'
export type AutoCompactAgentTriggerMode = 'inherit' | AutoCompactTriggerMode
export type AutoCompactModelMode = 'current' | 'preset'
export type AutoCompactAgentModelMode = 'inherit' | AutoCompactModelMode
export type AutoCompactPromptMode = 'default' | 'custom'
export type AutoCompactAgentPromptMode = 'inherit' | AutoCompactPromptMode
export type AutoCompactEventMode = 'manual' | 'auto'
export type CurrentModelCompactRuntime = 'api' | 'codex-cli' | 'claude-cli' | 'n8n'

export interface GlobalAutoCompactSettings {
  mode: AutoCompactMode
  triggerMode: AutoCompactTriggerMode
  remainingTokens: number | null
  modelMode: AutoCompactModelMode
  modelPresetId: string | null
  promptMode: AutoCompactPromptMode
  prompt: string
}

export interface AgentAutoCompactSettings {
  mode: AutoCompactAgentMode
  triggerMode: AutoCompactAgentTriggerMode
  remainingTokens: number | null
  modelMode: AutoCompactAgentModelMode
  modelPresetId: string | null
  promptMode: AutoCompactAgentPromptMode
  prompt: string
}

export interface EffectiveAutoCompactSettings {
  mode: AutoCompactMode
  triggerMode: AutoCompactTriggerMode
  remainingTokens: number | null
  modelMode: AutoCompactModelMode
  modelPresetId: string | null
  prompt: string
}

export interface ContextCompactionEvent {
  id: string
  createdAt: string
  mode: AutoCompactEventMode
  agentId: string | null
  compactedThroughMessageId: string | null
  sourceMessageIds: string[]
  protectedMessageIds: string[]
  compactedMessageCount: number
  protectedMessageCount: number
  sourceTokenEstimate: number
  summaryTokenEstimate: number
  summarySoftTargetTokens?: number
  summaryHardMaxTokens?: number
  modelMode: AutoCompactModelMode
  modelPresetId: string | null
  modelLabel: string
  provider: string | null
  modelId: string | null
  promptVersion: number
  summary: string
}

export interface ContextCompactionState {
  version: 1
  events: ContextCompactionEvent[]
}

export interface CompactionSelection {
  sourceMessages: Message[]
  sourceMessageIds: string[]
  protectedMessageIds: string[]
  compactedThroughMessageId: string | null
  compactedMessageCount: number
  protectedMessageCount: number
  sourceTokenEstimate: number
}

type CompactRuntimeAgentLike = Parameters<typeof normalizePrimaryAgentType>[0] & {
  primary_model_connection?: {
    id?: string | null
    service?: string | null
    type?: string | null
  } | null
}

export const DEFAULT_AUTO_COMPACT_PROMPT = [
  'You are compacting a Batshit chat so the next agent can continue without feeling a break in continuity.',
  '',
  'Write a dense, practical continuity summary of the old conversation segment. Preserve the facts, decisions, user preferences, current task state, constraints, blockers, file paths, commands, test results, errors, and exact next steps that could matter later.',
  '',
  'Use the requested summary budget as guidance, not as the goal. Quality and continuity matter more than hitting an exact size. Prefer a shorter summary when old context is stale, repetitive, already documented, or low-information. Use more space only when details are still needed for future work. Never let the summary become so large that compaction barely helps.',
  '',
  'Treat Tool Results Summary / Tool Notes blocks as high-signal notes the prior agent wrote before tool output was zipped. Keep the notes that still affect future work, but do not mechanically copy stale search debris or irrelevant tool details.',
  '',
  'Some manually unzipped zip items and active clips are deliberately kept live outside this compact summary. Mention those live items only when their existence or purpose matters. Do not spend summary tokens re-summarizing content the next agent will still receive directly.',
  '',
  'Be explicit about uncertainty. If something was discussed but not resolved, say what must be rechecked before acting. Do not invent results, hidden state, or confidence.',
  '',
  'Format the result with short labeled sections only when useful: Current Goal, Decisions, Important Context, Live Items, Open Risks, Next Steps. Keep it compact but not lossy.'
].join('\n')

export const DEFAULT_GLOBAL_AUTO_COMPACT_SETTINGS: GlobalAutoCompactSettings = {
  mode: 'ask',
  triggerMode: 'smart',
  remainingTokens: null,
  modelMode: 'current',
  modelPresetId: null,
  promptMode: 'default',
  prompt: DEFAULT_AUTO_COMPACT_PROMPT
}

export const DEFAULT_AGENT_AUTO_COMPACT_SETTINGS: AgentAutoCompactSettings = {
  mode: 'inherit',
  triggerMode: 'inherit',
  remainingTokens: null,
  modelMode: 'inherit',
  modelPresetId: null,
  promptMode: 'inherit',
  prompt: ''
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeNumber(value: unknown, min: number, max: number): number | null {
  const raw = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(raw)) return null
  return Math.max(min, Math.min(max, Math.round(raw)))
}

export function getSmartAutoCompactTriggerTokens(contextLimit: number | null | undefined): number {
  const limit =
    typeof contextLimit === 'number' && Number.isFinite(contextLimit) && contextLimit > 0
      ? contextLimit
      : 0
  const smart = Math.round(limit * AUTO_COMPACT_SMART_TRIGGER_PERCENT)
  return Math.max(
    AUTO_COMPACT_MIN_TRIGGER_TOKENS,
    Math.min(AUTO_COMPACT_MAX_TRIGGER_TOKENS, smart)
  )
}

export function normalizeGlobalAutoCompactSettings(
  value: unknown
): GlobalAutoCompactSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
  const mode: AutoCompactMode =
    raw.mode === 'off' || raw.mode === 'auto' || raw.mode === 'ask'
      ? raw.mode
      : DEFAULT_GLOBAL_AUTO_COMPACT_SETTINGS.mode
  const triggerMode: AutoCompactTriggerMode =
    raw.triggerMode === 'remaining_tokens' ? 'remaining_tokens' : 'smart'
  const modelMode: AutoCompactModelMode = raw.modelMode === 'preset' ? 'preset' : 'current'
  const promptMode: AutoCompactPromptMode = raw.promptMode === 'custom' ? 'custom' : 'default'
  const prompt =
    promptMode === 'custom'
      ? normalizeString(raw.prompt) ?? DEFAULT_AUTO_COMPACT_PROMPT
      : DEFAULT_AUTO_COMPACT_PROMPT

  return {
    mode,
    triggerMode,
    remainingTokens: normalizeNumber(raw.remainingTokens, 1_000, 1_000_000),
    modelMode,
    modelPresetId: normalizeString(raw.modelPresetId),
    promptMode,
    prompt
  }
}

export function normalizeAgentAutoCompactSettings(
  value: unknown
): AgentAutoCompactSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
  const mode: AutoCompactAgentMode =
    raw.mode === 'off' || raw.mode === 'auto' || raw.mode === 'ask'
      ? raw.mode
      : 'inherit'
  const triggerMode: AutoCompactAgentTriggerMode =
    raw.triggerMode === 'smart' || raw.triggerMode === 'remaining_tokens'
      ? raw.triggerMode
      : 'inherit'
  const modelMode: AutoCompactAgentModelMode =
    raw.modelMode === 'current' || raw.modelMode === 'preset'
      ? raw.modelMode
      : 'inherit'
  const promptMode: AutoCompactAgentPromptMode =
    raw.promptMode === 'default' || raw.promptMode === 'custom'
      ? raw.promptMode
      : 'inherit'

  return {
    mode,
    triggerMode,
    remainingTokens: normalizeNumber(raw.remainingTokens, 1_000, 1_000_000),
    modelMode,
    modelPresetId: normalizeString(raw.modelPresetId),
    promptMode,
    prompt: normalizeString(raw.prompt) ?? ''
  }
}

export function resolveEffectiveAutoCompactSettings(params: {
  global?: unknown
  agent?: unknown
}): EffectiveAutoCompactSettings {
  const global = normalizeGlobalAutoCompactSettings(params.global)
  const agent = normalizeAgentAutoCompactSettings(params.agent)
  const triggerMode =
    agent.triggerMode === 'inherit' ? global.triggerMode : agent.triggerMode
  const modelMode = agent.modelMode === 'inherit' ? global.modelMode : agent.modelMode
  const promptMode = agent.promptMode === 'inherit' ? global.promptMode : agent.promptMode
  const prompt =
    promptMode === 'custom'
      ? normalizeString(agent.prompt) ?? normalizeString(global.prompt) ?? DEFAULT_AUTO_COMPACT_PROMPT
      : DEFAULT_AUTO_COMPACT_PROMPT

  return {
    mode: agent.mode === 'inherit' ? global.mode : agent.mode,
    triggerMode,
    remainingTokens:
      triggerMode === 'remaining_tokens'
        ? agent.triggerMode === 'inherit'
          ? global.remainingTokens
          : agent.remainingTokens
        : null,
    modelMode,
    modelPresetId:
      modelMode === 'preset'
        ? agent.modelMode === 'inherit'
          ? global.modelPresetId
          : agent.modelPresetId
        : null,
    prompt
  }
}

export function resolveAutoCompactTriggerTokens(
  settings: EffectiveAutoCompactSettings,
  contextLimit: number | null | undefined
): number {
  if (settings.triggerMode === 'remaining_tokens' && settings.remainingTokens) {
    return settings.remainingTokens
  }
  return getSmartAutoCompactTriggerTokens(contextLimit)
}

function includesAny(value: unknown, needles: string[]) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return normalized.length > 0 && needles.some((needle) => normalized.includes(needle))
}

export function resolveCurrentModelCompactRuntime(
  agent?: CompactRuntimeAgentLike | null
): CurrentModelCompactRuntime {
  const type = normalizePrimaryAgentType(agent)
  if (type === 'api') return 'api'
  if (type === 'n8n') return 'n8n'

  const codexNeedles = ['codex', 'openai-codex', 'codex-cli']
  const claudeNeedles = ['claude-cli', 'anthropic-claude-cli']
  const connection = agent?.primary_model_connection ?? null
  const codexHint =
    includesAny(agent?.primary_model_provider, codexNeedles) ||
    includesAny(agent?.primary_model_name, codexNeedles) ||
    includesAny(connection?.id, codexNeedles) ||
    includesAny(connection?.service, codexNeedles) ||
    includesAny(connection?.type, codexNeedles)
  const claudeHint =
    includesAny(agent?.primary_model_provider, claudeNeedles) ||
    includesAny(agent?.primary_model_name, claudeNeedles) ||
    includesAny(connection?.id, claudeNeedles) ||
    includesAny(connection?.service, claudeNeedles) ||
    includesAny(connection?.type, claudeNeedles)

  if (claudeHint && !codexHint) return 'claude-cli'
  return 'codex-cli'
}

export function getContextCompactionState(metadata?: Record<string, any> | null): ContextCompactionState {
  const raw = metadata?.contextCompaction
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 1, events: [] }
  }

  const events = Array.isArray((raw as any).events)
    ? (raw as any).events.filter(isContextCompactionEvent)
    : []

  return { version: 1, events }
}

function isContextCompactionEvent(value: unknown): value is ContextCompactionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, any>
  return (
    typeof raw.id === 'string' &&
    typeof raw.createdAt === 'string' &&
    Array.isArray(raw.sourceMessageIds) &&
    typeof raw.summary === 'string'
  )
}

export function getCompactedMessageIds(events: ContextCompactionEvent[]): string[] {
  const ids = new Set<string>()
  for (const event of events) {
    for (const id of event.sourceMessageIds) {
      if (typeof id === 'string' && id.trim()) ids.add(id)
    }
  }
  return Array.from(ids)
}

export function calculateCompactedTokens(
  messages: Message[],
  events: ContextCompactionEvent[]
): number {
  const compacted = new Set(getCompactedMessageIds(events))
  return messages.reduce((total, message) => {
    if (!compacted.has(message.id)) return total
    return total + countMessageTokens(message)
  }, 0)
}

export function resolveCompactSummaryBudget(params: {
  contextLimit?: number | null
  sourceTokenEstimate?: number | null
}): { softTargetTokens: number; hardMaxTokens: number } {
  const contextLimit =
    typeof params.contextLimit === 'number' && Number.isFinite(params.contextLimit) && params.contextLimit > 0
      ? params.contextLimit
      : 200_000
  const sourceTokens =
    typeof params.sourceTokenEstimate === 'number' &&
    Number.isFinite(params.sourceTokenEstimate) &&
    params.sourceTokenEstimate > 0
      ? params.sourceTokenEstimate
      : contextLimit
  const scaledSoftTarget = Math.round(contextLimit * 0.012)
  const scaledHardMax = Math.round(contextLimit * 0.025)
  const sourceAwareSoftTarget = Math.round(sourceTokens * 0.25)
  const sourceAwareHardMax = Math.round(sourceTokens * 0.4)
  const softTargetTokens = Math.max(
    900,
    Math.min(8_000, scaledSoftTarget, sourceAwareSoftTarget)
  )
  const hardMaxTokens = Math.max(
    softTargetTokens + 500,
    Math.min(16_000, scaledHardMax, sourceAwareHardMax)
  )

  return { softTargetTokens, hardMaxTokens }
}

export function selectMessagesForCompaction(
  messages: Message[],
  events: ContextCompactionEvent[],
  options: {
    protections?: ManualTrimProtections
    keepTailMessages?: number
  } = {}
): CompactionSelection {
  const keepTail = Math.max(0, Math.round(options.keepTailMessages ?? AUTO_COMPACT_DEFAULT_KEEP_TAIL_MESSAGES))
  const alreadyCompacted = new Set(getCompactedMessageIds(events))
  const boundaryIndex = Math.max(0, messages.length - keepTail)
  const candidates = messages.slice(0, boundaryIndex)
  const sourceMessages: Message[] = []
  const protectedMessageIds: string[] = []

  for (const message of candidates) {
    if (!message?.id) continue
    if (alreadyCompacted.has(message.id)) continue
    if (message.metadata?.manualContextTrim || message.metadata?.contextCompactSummary) continue
    if (isMessageProtectedFromManualTrim(message, options.protections)) {
      protectedMessageIds.push(message.id)
      continue
    }
    sourceMessages.push(message)
  }

  return {
    sourceMessages,
    sourceMessageIds: sourceMessages.map((message) => message.id),
    protectedMessageIds,
    compactedThroughMessageId: sourceMessages.at(-1)?.id ?? null,
    compactedMessageCount: sourceMessages.length,
    protectedMessageCount: protectedMessageIds.length,
    sourceTokenEstimate: sourceMessages.reduce((total, message) => total + countMessageTokens(message), 0)
  }
}

export function buildContextCompactSummaryContent(event: ContextCompactionEvent): string {
  const protectedLine =
    event.protectedMessageCount > 0
      ? ` ${event.protectedMessageCount} older message${event.protectedMessageCount === 1 ? '' : 's'} with manually unzipped or active clipped context stayed live outside this summary.`
      : ''

  return [
    'Context compact summary:',
    `Batshit compacted ${event.compactedMessageCount} older chat message${event.compactedMessageCount === 1 ? '' : 's'} on ${event.createdAt}. Those original messages are no longer part of the model-facing context and Reset Trim cannot restore them.${protectedLine}`,
    '',
    event.summary.trim()
  ].join('\n')
}

export function createContextCompactSummaryMessage(event: ContextCompactionEvent): Message {
  return {
    id: `batshit_context_compact_summary_${event.id}`,
    session_id: '',
    user_id: '',
    role: 'system',
    content: buildContextCompactSummaryContent(event),
    timestamp: event.createdAt,
    created_at: event.createdAt,
    metadata: {
      contextCompactSummary: true,
      contextCompactEventId: event.id,
      compactedMessageCount: event.compactedMessageCount,
      sourceMessageIds: event.sourceMessageIds
    }
  }
}

export function applyContextCompactionToMessages(
  messages: Message[],
  events: ContextCompactionEvent[]
): Message[] {
  if (!events.length) return messages

  const sortedEvents = [...events].sort((a, b) => {
    const aTime = Date.parse(a.createdAt)
    const bTime = Date.parse(b.createdAt)
    return (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0)
  })
  const messageIds = new Set(messages.map((message) => message.id))
  const sourceToEvent = new Map<string, ContextCompactionEvent>()
  for (const event of sortedEvents) {
    for (const id of event.sourceMessageIds) {
      if (messageIds.has(id) && !sourceToEvent.has(id)) {
        sourceToEvent.set(id, event)
      }
    }
  }

  const insertedEventIds = new Set<string>(
    messages
      .map((message) =>
        typeof message.metadata?.contextCompactEventId === 'string'
          ? message.metadata.contextCompactEventId
          : ''
      )
      .filter(Boolean)
  )
  const output: Message[] = []
  for (const message of messages) {
    const event = sourceToEvent.get(message.id)
    if (!event) {
      output.push(message)
      continue
    }

    if (!insertedEventIds.has(event.id)) {
      const summaryMessage = createContextCompactSummaryMessage(event)
      output.push({
        ...summaryMessage,
        session_id: message.session_id,
        user_id: message.user_id
      })
      insertedEventIds.add(event.id)
    }
  }

  for (const event of sortedEvents) {
    if (!insertedEventIds.has(event.id) && event.sourceMessageIds.length > 0) {
      output.unshift(createContextCompactSummaryMessage(event))
      insertedEventIds.add(event.id)
    }
  }

  return output
}

function formatToolResultsSummaryForCompact(message: Message): string {
  const zipControl = message.metadata?.zipControl
  const notes = Array.isArray(zipControl?.toolResultsSummary)
    ? zipControl.toolResultsSummary
    : Array.isArray(zipControl?.toolNotes)
      ? zipControl.toolNotes
      : []
  const lines = notes
    .map((note: any) => {
      const summary =
        typeof note?.summary === 'string'
          ? note.summary.replace(/\s+/g, ' ').trim()
          : ''
      if (!summary) return ''
      const label = note?.toolName || note?.toolCallId || 'Tool'
      return `- ${label}: ${summary}`
    })
    .filter(Boolean)
  return lines.length ? `\nTool Results Summary:\n${lines.join('\n')}` : ''
}

export function buildCompactionTranscript(messages: Message[]): string {
  return messages
    .map((message, index) => {
      const timestamp = message.timestamp || message.created_at || 'unknown'
      const role = message.role.toUpperCase()
      const content = message.content?.trim() || '[No content]'
      const toolSummary = formatToolResultsSummaryForCompact(message)
      return [
        `#${index + 1} ${role} | messageId=${message.id} | timestamp=${timestamp}`,
        content,
        toolSummary
      ].filter(Boolean).join('\n')
    })
    .join('\n\n---\n\n')
}

export function buildLiveProtectedItemsNote(params: {
  protectedMessageIds?: string[]
  protectedUnzippedZipIds?: string[]
  userUnzippedZipIds?: string[]
  activeClipIds?: string[]
}): string {
  const unzippedZipIds = Array.from(new Set([
    ...(params.protectedUnzippedZipIds ?? []),
    ...(params.userUnzippedZipIds ?? [])
  ].filter(Boolean)))
  const lines: string[] = []
  if (params.protectedMessageIds?.length) {
    lines.push(
      `${params.protectedMessageIds.length} older message${params.protectedMessageIds.length === 1 ? '' : 's'} were not compacted because they reference manually unzipped zips or active clips.`
    )
  }
  if (unzippedZipIds.length) {
    lines.push(`Live manually unzipped zip IDs: ${unzippedZipIds.join(', ')}`)
  }
  if (params.activeClipIds?.length) {
    lines.push(`Live active clip IDs: ${params.activeClipIds.join(', ')}`)
  }
  return lines.join('\n')
}
