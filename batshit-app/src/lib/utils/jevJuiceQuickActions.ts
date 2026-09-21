/**
 * SA-120 P9 — quick actions from speech (F2, DL-120-15): the catalog, the switch, and the words.
 *
 * In Voice Mode, when what the user just said is a small request to Batshit itself ("stop",
 * "hang up", "open the dock", "open settings", "show me what you did"), Batshit does it at
 * once and, when that was all the user said, sends nothing to the agent. Every action here is
 * one the user can do with one click and undo with one click; none writes memory, sends a DM,
 * touches a file, or runs a Fabric control, so nothing risky can ever run from speech
 * (DL-120-12). Goon expressions stay held (DL-120-10).
 *
 * Browser-safe: `ChatInput` reads the switch and runs the actions, `ChatMessage` draws the
 * mark, and the server lane (`quickActions.jev.ts`) and the DCM tell line import the same
 * catalog, so the id, the label, and the tell line can never drift.
 */

import { JEV_MODEL_NAME } from './jevJuice'

export const QUICK_ACTION_FEATURE_ID = 'quick_actions' as const

/** The switch: `voice_settings.voiceMode.jevJuiceQuickActions` (LS-060). Absent means OFF. */
export const VOICE_JEV_QUICK_ACTIONS_FIELD = 'jevJuiceQuickActions' as const
export const VOICE_JEV_QUICK_ACTIONS_LABEL = 'Jev Juice: Quick Actions'

/** THE rule for "may a spoken turn run a quick action?" Reads the normalized Voice Mode block or the raw record. */
export function resolveJevQuickActionsEnabled(voiceModeSettings: unknown): boolean {
  if (!voiceModeSettings || typeof voiceModeSettings !== 'object') return false
  return (voiceModeSettings as Record<string, unknown>)[VOICE_JEV_QUICK_ACTIONS_FIELD] === true
}

/**
 * SA-120 P9b (Josh, 2026-09-18): the wake word. By default a spoken turn is judged only when it
 * starts with the wake word ("Yo, hang up"), so ordinary speech costs no Jev call at all; the
 * word is a setting (default "Yo"), and "Require Wake Word" can be turned off to judge every
 * turn as P9 first shipped. The word is a gate, never a trigger: Jev still judges the rest.
 */
export const VOICE_JEV_QUICK_ACTIONS_WAKE_REQUIRED_FIELD = 'jevJuiceQuickActionsWakeWordRequired' as const
export const VOICE_JEV_QUICK_ACTIONS_WAKE_WORD_FIELD = 'jevJuiceQuickActionsWakeWord' as const
export const VOICE_JEV_QUICK_ACTIONS_WAKE_REQUIRED_LABEL = 'Require Wake Word'
export const VOICE_JEV_QUICK_ACTIONS_WAKE_WORD_LABEL = 'Wake Word'
export const DEFAULT_QUICK_ACTION_WAKE_WORD = 'Yo'
/** One to three words, letters, digits, apostrophes, and hyphens; 24 characters at most. */
export const QUICK_ACTION_WAKE_WORD_MAX_CHARS = 24
const WAKE_WORD_PATTERN = /^[\p{L}\p{N}'’-]+(?: [\p{L}\p{N}'’-]+){0,2}$/u

/** The stored word, tidied; anything unusable reads as the default (a setting can never disable the gate by accident). */
export function normalizeQuickActionWakeWord(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!text || text.length > QUICK_ACTION_WAKE_WORD_MAX_CHARS || !WAKE_WORD_PATTERN.test(text)) return DEFAULT_QUICK_ACTION_WAKE_WORD
  return text
}

/** Write-side check for the Voice panel and the settings route: `null` when the word is fine, else why not. */
export function quickActionWakeWordProblem(value: unknown): string | null {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!text) return `${VOICE_JEV_QUICK_ACTIONS_WAKE_WORD_LABEL} cannot be empty. Turn off ${VOICE_JEV_QUICK_ACTIONS_WAKE_REQUIRED_LABEL} instead.`
  if (text.length > QUICK_ACTION_WAKE_WORD_MAX_CHARS) return `${VOICE_JEV_QUICK_ACTIONS_WAKE_WORD_LABEL} must be ${QUICK_ACTION_WAKE_WORD_MAX_CHARS} characters or fewer.`
  if (!WAKE_WORD_PATTERN.test(text)) return `${VOICE_JEV_QUICK_ACTIONS_WAKE_WORD_LABEL} must be one to three plain words.`
  return null
}

/** THE rule for "is the wake word required?" Absent means REQUIRED (the safe, cheap default). */
export function resolveJevQuickActionsWakeWordRequired(voiceModeSettings: unknown): boolean {
  if (!voiceModeSettings || typeof voiceModeSettings !== 'object') return true
  return (voiceModeSettings as Record<string, unknown>)[VOICE_JEV_QUICK_ACTIONS_WAKE_REQUIRED_FIELD] !== false
}

export function resolveJevQuickActionsWakeWord(voiceModeSettings: unknown): string {
  if (!voiceModeSettings || typeof voiceModeSettings !== 'object') return DEFAULT_QUICK_ACTION_WAKE_WORD
  return normalizeQuickActionWakeWord((voiceModeSettings as Record<string, unknown>)[VOICE_JEV_QUICK_ACTIONS_WAKE_WORD_FIELD])
}

export interface QuickActionWakeGate {
  /** The words Jev judges: the turn with the wake word removed, or the whole turn when none is required. */
  said: string
  /** True when a wake word was found and removed. */
  stripped: boolean
}

const LEADING_JUNK = /^[\s"'“”‘’(\[.,;:!?-]+/u
const TRAILING_JUNK = /[\s"'“”‘’)\].,;:!?-]+$/u

function wakeTokens(text: string): string[] {
  return text.toLowerCase().replace(/[’]/g, "'").split(/\s+/).filter(Boolean)
}

/**
 * The gate. Case and punctuation do not matter ("Yo hang up", "Yo, hang up!", "yo. hang up"), but
 * the word must be the FIRST word and exactly the word ("you" is not "yo": a misheard wake word
 * means the turn simply goes to the agent, the safe direction). Returns `null` when the turn is
 * not to be judged: the wake word is required and absent, or nothing follows it.
 */
export function resolveQuickActionWakeGate(transcript: string, voiceModeSettings: unknown): QuickActionWakeGate | null {
  const text = typeof transcript === 'string' ? transcript.replace(/\s+/g, ' ').trim() : ''
  if (!text) return null
  if (!resolveJevQuickActionsWakeWordRequired(voiceModeSettings)) return { said: text, stripped: false }
  const wanted = wakeTokens(resolveJevQuickActionsWakeWord(voiceModeSettings))
  const words = text.split(' ')
  for (let index = 0; index < wanted.length; index += 1) {
    const heard = words[index]
    if (heard === undefined) return null
    const cleaned = heard.toLowerCase().replace(/[’]/g, "'").replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '')
    if (cleaned !== wanted[index]) return null
  }
  const rest = words.slice(wanted.length).join(' ').replace(LEADING_JUNK, '').trim()
  if (!rest) return null
  return { said: rest, stripped: true }
}

export type QuickActionId =
  | 'stop'
  | 'end_voice_mode'
  | 'open_goon_dock'
  | 'close_goon_dock'
  | 'open_settings'
  | 'show_execution_viewer'

export type QuickActionSettingsTab = 'general' | 'agents' | 'voice' | 'goons' | 'memory' | 'tools'

export interface QuickActionDefinition {
  id: QuickActionId
  /** What Jev is asked: "does the user ask Batshit to <ask>, right now?" */
  ask: string
  /** The words people say, quoted in the question's criteria. */
  words: string
  /** Past tense, for the mark and the tell line: "Batshit <did>". */
  did: string
  /**
   * Josh's rule (DL-120-15, sharpened 2026-09-18): the agent is told ONLY when the action involves
   * it (his example: the Goon making a face before the agent has replied). None of the six v1
   * actions does: opening Settings or the Dock, stopping, or hanging up is the user's business,
   * so the agent is not bothered with it and a swallowed turn is dropped from its history.
   */
  involvesAgent: boolean
}

export const QUICK_ACTIONS: readonly QuickActionDefinition[] = Object.freeze([
  {
    id: 'stop',
    ask: 'stop talking and stop whatever reply it is still writing',
    words: '"stop", "be quiet", "hush", "enough", "shut up"',
    did: 'stopped the spoken reply',
    involvesAgent: false
  },
  {
    id: 'end_voice_mode',
    ask: 'end the voice conversation (hang up) and go back to typing',
    words: '"hang up", "end voice mode", "I\'m done talking", "bye for now"',
    did: 'ended Voice Mode',
    involvesAgent: false
  },
  {
    id: 'open_goon_dock',
    ask: "show the assistant's 3D character on screen (open the Goon Dock)",
    words: '"open the dock", "show the goon", "show yourself", "pull up your avatar"',
    did: 'opened the Goon Dock',
    involvesAgent: false
  },
  {
    id: 'close_goon_dock',
    ask: "hide the assistant's 3D character (close the Goon Dock)",
    words: '"close the dock", "hide the goon", "put the goon away"',
    did: 'closed the Goon Dock',
    involvesAgent: false
  },
  {
    id: 'open_settings',
    ask: "open Batshit's Settings panel, on any of its tabs (general, agents, voice, goons, memory, tools)",
    words: '"open settings", "open the voice settings", "take me to the goon settings", "settings please"',
    did: 'opened Settings',
    involvesAgent: false
  },
  {
    id: 'show_execution_viewer',
    ask: 'open the Execution Viewer, the panel that shows what the assistant did behind its last reply',
    words: '"show me the execution viewer", "show me what you did behind that", "open the execution log"',
    did: 'opened the Execution Viewer',
    involvesAgent: false
  }
])

export const QUICK_ACTION_IDS: readonly QuickActionId[] = Object.freeze(QUICK_ACTIONS.map((action) => action.id))

export const QUICK_ACTION_SETTINGS_TABS: Readonly<Record<QuickActionSettingsTab, string>> = Object.freeze({
  general: 'General settings.',
  agents: 'Agents: the assistants, their prompts and models.',
  voice: 'Voice: speech, microphones, voices, Voice Mode.',
  goons: '3D Goons: the 3D characters.',
  memory: 'Memory.',
  tools: 'Tools, skills, and MCP servers.'
})

export function quickActionDefinition(id: string | null | undefined): QuickActionDefinition | null {
  return QUICK_ACTIONS.find((action) => action.id === id) ?? null
}

/** THE rule for "is the agent told about this action?" (DL-120-15). Unknown ids are never told. */
export function quickActionInvolvesAgent(id: string | null | undefined): boolean {
  return quickActionDefinition(id)?.involvesAgent === true
}

/**
 * A spoken turn that was ONLY a quick action never reached the agent, so it is dropped from the
 * history the agent is compiled with (the user still sees it in the chat, with its chip). A mixed
 * turn (`onlyThis` false) was sent and stays.
 */
export function isSwallowedQuickActionTurn(message: { role?: unknown; metadata?: unknown } | null | undefined): boolean {
  if (!message || message.role !== 'user') return false
  return readQuickActionMark(message.metadata)?.onlyThis === true
}

export function isQuickActionId(value: unknown): value is QuickActionId {
  return typeof value === 'string' && QUICK_ACTION_IDS.includes(value as QuickActionId)
}

export function isQuickActionSettingsTab(value: unknown): value is QuickActionSettingsTab {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(QUICK_ACTION_SETTINGS_TABS, value)
}

/**
 * `message.metadata.quickAction` on a user message spoken in Voice Mode: what Jev decided and
 * what Batshit did. `onlyThis` true means nothing was sent to the agent for that turn.
 */
export interface QuickActionMark {
  id: QuickActionId
  /** The Settings tab, only for `open_settings`; `null` when none was named. */
  tab: QuickActionSettingsTab | null
  /** Jev's probability for the action, 0-1. */
  confidence: number
  /** True: the request was the whole turn, so no agent turn ran. False: the rest of the turn went to the agent. */
  onlyThis: boolean
  /** The Execution Viewer entry the check wrote (`qa_…`), for the tooltip. */
  snapshotId: string | null
  at: string
}

export function readQuickActionMark(metadata: unknown): QuickActionMark | null {
  if (!metadata || typeof metadata !== 'object') return null
  const raw = (metadata as { quickAction?: unknown }).quickAction
  if (!raw || typeof raw !== 'object') return null
  const mark = raw as Record<string, unknown>
  if (!isQuickActionId(mark.id)) return null
  const confidence = typeof mark.confidence === 'number' && Number.isFinite(mark.confidence) ? mark.confidence : 0
  return {
    id: mark.id,
    tab: isQuickActionSettingsTab(mark.tab) ? mark.tab : null,
    confidence: Math.max(0, Math.min(1, confidence)),
    onlyThis: mark.onlyThis === true,
    snapshotId: typeof mark.snapshotId === 'string' ? mark.snapshotId : null,
    at: typeof mark.at === 'string' ? mark.at : ''
  }
}

/** The route's answer, as the browser reads it. */
export interface QuickActionVerdict {
  action: QuickActionId | null
  tab: QuickActionSettingsTab | null
  onlyThis: boolean
  confidence: number
  snapshotId: string | null
}

export function readQuickActionVerdict(payload: unknown): QuickActionVerdict {
  const raw = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const action = isQuickActionId(raw.action) ? raw.action : null
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0
  return {
    action,
    tab: action === 'open_settings' && isQuickActionSettingsTab(raw.tab) ? raw.tab : null,
    onlyThis: action !== null && raw.onlyThis === true,
    confidence,
    snapshotId: typeof raw.snapshotId === 'string' ? raw.snapshotId : null
  }
}

/** The mark to store on the user message for a verdict that fired. */
export function quickActionMarkOf(verdict: QuickActionVerdict, at = new Date()): QuickActionMark | null {
  if (!verdict.action) return null
  return {
    id: verdict.action,
    tab: verdict.tab,
    confidence: verdict.confidence,
    onlyThis: verdict.onlyThis,
    snapshotId: verdict.snapshotId,
    at: at.toISOString()
  }
}

/** Window event the composer sends for the actions the page owns (the Goon Dock); detail `{ id }`. */
export const QUICK_ACTION_EVENT = 'batshit:quick-action'

/** Settings tab ids as `batshit:open-settings` knows them (`SettingsPanel` tab values); `general` and none open the usual tab. */
export function quickActionSettingsTabTarget(tab: QuickActionSettingsTab | null): string | undefined {
  switch (tab) {
    case 'agents':
      return 'agents'
    case 'voice':
      return 'voice'
    case 'goons':
      return '3d-goons'
    case 'memory':
      return 'memory'
    case 'tools':
      return 'tools'
    default:
      return undefined
  }
}

/** "opened Settings (Voice)". */
export function quickActionDidText(mark: Pick<QuickActionMark, 'id' | 'tab'>): string {
  const definition = quickActionDefinition(mark.id)
  if (!definition) return mark.id
  if (mark.id === 'open_settings' && mark.tab) {
    const tabName = mark.tab === 'goons' ? '3D Goons' : mark.tab[0].toUpperCase() + mark.tab.slice(1)
    return `${definition.did} (${tabName})`
  }
  return definition.did
}

/** Every number a user sees says "confidence" (Josh, 2026-09-17). */
export function quickActionConfidenceText(confidence: number): string {
  return `${Math.max(0, Math.min(100, Math.round(confidence * 100)))}% confidence`
}

/** The chip under the user's bubble: "Quick action by Jev: opened the Goon Dock (94% confidence)". */
export function quickActionMarkText(mark: QuickActionMark): string {
  return `Quick action by ${JEV_MODEL_NAME}: ${quickActionDidText(mark)} (${quickActionConfidenceText(mark.confidence)})`
}

/** The chip's second line: who got the turn. */
export function quickActionRoutingText(mark: QuickActionMark, agentName: string): string {
  return mark.onlyThis ? `Nothing was sent to ${agentName}.` : `The rest went to ${agentName}.`
}

export const QUICK_ACTION_MARK_DETAIL_TEXT = `${JEV_MODEL_NAME} judged what you said and Batshit acted on it without your agent. ${JEV_MODEL_NAME} can be wrong; every quick action is one click to undo.`

/**
 * The line the agent reads in its next turn (DL-120-15: the agent is told; design record rule 4).
 * `said` is what the user spoke; the agent had no part in it.
 */
export function quickActionTellLine(mark: Pick<QuickActionMark, 'id' | 'tab' | 'onlyThis'>, said: string): string {
  const did = quickActionDidText(mark)
  const quote = said.trim().replace(/\s+/g, ' ').slice(0, 160)
  const who = `a quick action by ${JEV_MODEL_NAME}, not you`
  return mark.onlyThis
    ? `The user said "${quote}" and Batshit ${did} for them (${who}); that turn never reached you.`
    : `In this message the user also asked Batshit to act, and Batshit ${did} (${who}) before you read it.`
}
