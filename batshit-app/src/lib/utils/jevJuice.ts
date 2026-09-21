/**
 * SA-120 Jev Juice — browser-safe feature registry and copy helpers.
 *
 * The product-facing name is **Jev Juice** (DL-120-13): two capitalized words,
 * always. Internal identifiers stay plain (`typesafe`). Feature ids are added here
 * by the packet that ships the feature; the Execution Viewer table and the inline
 * chat note read their labels from this one table so the wording stays consistent.
 */

import type {
  JevJuiceGap,
  JevJuiceNote,
  JevJuicePostTurnFinding,
  JevJuicePostTurnLane,
  JevJuicePostTurnRecord,
  TypesafeCallReason,
  TypesafeCallRecord,
  UntrustedTextFinding,
  UntrustedTextFindingId,
  UntrustedTextScreen
} from '$lib/types/typesafe'

export const JEV_JUICE_NAME = 'Jev Juice'
export const TYPESAFE_VENDOR_NAME = 'TypeSafe'

export interface TypesafeFeatureDefinition {
  /** Short noun phrase used in the Execution Viewer and the inline note. */
  label: string
  /** The per-feature switch wording, `Jev Juice: <what it does>` (DL-120-13), except on the Jev Juice card itself, where the card is the prefix. `null` for non-switch lanes. */
  switchLabel: string | null
}

export const TYPESAFE_FEATURES = {
  /** The Settings → Admin → Jev Juice "Test" button: one fixed sample question. Not a feature switch. */
  connection_test: { label: 'Connection test', switchLabel: null },
  /** SA-120 P1: skill and tool hints in the DCM tail plus the capability-gap chip (per-agent switch). */
  skill_tool_hints: { label: 'Skill and tool hints', switchLabel: 'Jev Juice: Suggest Skills and Tools' },
  /** SA-120 P2: the agent-callable `sys.judge.ask` tool (per-agent switch). */
  judge_ask: { label: 'Judgment tool (sys.judge.ask)', switchLabel: 'Jev Juice: Judgment Tool' },
  /** SA-120 P3: group speaker selection and follow-up gating (the `smart` speaking preset on a group agent). */
  group_speaker: { label: 'Group speaker', switchLabel: 'Jev Juice: Smart' },
  /** SA-120 P4a: a Jev relevance term in the agent's memory search ranking (per-agent switch). */
  memory_rerank: { label: 'Memory search rerank', switchLabel: 'Jev Juice: Rerank Memory Search' },
  /** SA-120 P4b: long-term memories that bear on the message join `Memory context:` without a trigger word (per-agent switch). */
  memory_recall: { label: 'Memory recall', switchLabel: 'Jev Juice: Recall by Meaning' },
  /** SA-120 P5: which zipped tool results a message needs, as DCM tail hints (ONE global switch on `global_zip_settings`). */
  smart_zip: { label: 'Smart zip', switchLabel: 'Jev Juice: Smart Zip' },
  /** SA-120 P6: after a reply, does it claim something the turn did not do? (per-agent switch) */
  reply_check: { label: 'Reply check', switchLabel: 'Jev Juice: Check Replies' },
  /** SA-120 P6: after a reply, repeated openers, closers, phrases, and habits (per-agent switch). */
  style_coach: { label: 'Style coach', switchLabel: 'Jev Juice: Style Coach' },
  /**
   * SA-120 P7: an advisory screen of text that did not come from the user: agent DMs, wake-up webhook
   * messages, and imported SKILL.md files (ONE instance switch on `batshit:typesafe_config`).
   */
  untrusted_text: { label: 'Incoming text screen', switchLabel: 'Screen Incoming Text' },
  /**
   * SA-120 P9: a spoken turn in Voice Mode that asks Batshit itself for a small app action (stop, hang up,
   * show or hide the Goon, open Settings, show the Execution Viewer) is carried out at once, without the
   * agent (ONE global switch on `voice_settings.voiceMode`).
   */
  quick_actions: { label: 'Quick actions', switchLabel: 'Jev Juice: Quick Actions' }
} as const satisfies Record<string, TypesafeFeatureDefinition>

export type TypesafeFeatureId = keyof typeof TYPESAFE_FEATURES

export function typesafeFeatureLabel(featureId: string): string {
  const definition = (TYPESAFE_FEATURES as Record<string, TypesafeFeatureDefinition>)[featureId]
  return definition?.label ?? featureId
}

/** Plain-language reason text shared by the Execution Viewer and the inline note. */
export function describeTypesafeReason(reason: TypesafeCallReason | string | undefined): string {
  switch (reason) {
    case 'master_off':
      return `${JEV_JUICE_NAME} is off in Settings → Admin.`
    case 'feature_off':
      return `This ${JEV_JUICE_NAME} feature is off.`
    case 'no_key':
      return `No ${TYPESAFE_VENDOR_NAME} key is saved.`
    case 'deadline':
      return `${TYPESAFE_VENDOR_NAME} did not answer in time.`
    case 'timeout':
      return `${TYPESAFE_VENDOR_NAME} did not answer before the timeout.`
    case 'rate_limited':
      return `${TYPESAFE_VENDOR_NAME} was busy (rate limited).`
    case 'network':
      return `Batshit could not reach ${TYPESAFE_VENDOR_NAME}.`
    case 'aborted':
      return 'The call was cancelled.'
    case 'unauthorized':
      return `${TYPESAFE_VENDOR_NAME} rejected the key.`
    case 'bad_request':
      return `${TYPESAFE_VENDOR_NAME} rejected the request.`
    case 'server_error':
      return `${TYPESAFE_VENDOR_NAME} returned an error.`
    case 'malformed':
      return `${TYPESAFE_VENDOR_NAME} sent an answer Batshit could not read.`
    case 'local_error':
      return 'Batshit could not prepare the request.'
    default:
      return `${JEV_JUICE_NAME} did not run.`
  }
}

/** Chip text: "Jev Juice: Memory recall skipped". */
export function jevJuiceNoteText(note: JevJuiceNote): string {
  return `${JEV_JUICE_NAME}: ${typesafeFeatureLabel(note.feature)} skipped`
}

/** The after-reply lanes (SA-120 P6): they run once a reply is complete, so a miss never touched the send. */
const AFTER_REPLY_FEATURES = new Set<string>(['reply_check', 'style_coach'])

/** Tooltip text: the reason plus the one promise that matters — the message still went out. */
export function jevJuiceNoteDetail(note: JevJuiceNote): string {
  // SA-120 P7: the incoming-text screen never touches a send; what a miss means is "not screened".
  if (note.feature === 'untrusted_text') {
    return `${describeTypesafeReason(note.reason)} This text was not screened.`
  }
  if (AFTER_REPLY_FEATURES.has(note.feature)) {
    return `${describeTypesafeReason(note.reason)} This reply was not checked.`
  }
  return `${describeTypesafeReason(note.reason)} The message was sent without it.`
}

/** Reads `message.metadata.jevJuice.notes` defensively; older messages have none. */
export function readJevJuiceNotes(metadata: unknown): JevJuiceNote[] {
  const jevJuice = (metadata as { jevJuice?: unknown } | null | undefined)?.jevJuice
  const notes = (jevJuice as { notes?: unknown } | null | undefined)?.notes
  if (!Array.isArray(notes)) return []
  return notes.filter(
    (note): note is JevJuiceNote =>
      Boolean(note) &&
      typeof note === 'object' &&
      typeof (note as JevJuiceNote).feature === 'string' &&
      ((note as JevJuiceNote).status === 'unavailable' || (note as JevJuiceNote).status === 'error')
  )
}

/** Reads `executionMetadata.typesafeCalls` defensively from any snapshot-like object (Execution Viewer). */
export function readTypesafeCallRecords(executionMetadata: unknown): TypesafeCallRecord[] {
  const calls = (executionMetadata as { typesafeCalls?: unknown } | null | undefined)?.typesafeCalls
  if (!Array.isArray(calls)) return []
  return calls.filter(
    (call): call is TypesafeCallRecord =>
      Boolean(call) &&
      typeof call === 'object' &&
      typeof (call as TypesafeCallRecord).feature === 'string' &&
      typeof (call as TypesafeCallRecord).status === 'string'
  )
}

/** Execution Viewer status label for one Jev call. */
export function typesafeCallStatusLabel(status: TypesafeCallRecord['status']): string {
  if (status === 'ok') return 'Answered'
  if (status === 'unavailable') return 'Skipped'
  return 'Error'
}

/** Reads `message.metadata.jevJuice.gaps` defensively; older messages have none. */
export function readJevJuiceGaps(metadata: unknown): JevJuiceGap[] {
  const jevJuice = (metadata as { jevJuice?: unknown } | null | undefined)?.jevJuice
  const gaps = (jevJuice as { gaps?: unknown } | null | undefined)?.gaps
  if (!Array.isArray(gaps)) return []
  return gaps.filter(
    (gap): gap is JevJuiceGap =>
      Boolean(gap) &&
      typeof gap === 'object' &&
      typeof (gap as JevJuiceGap).label === 'string' &&
      typeof (gap as JevJuiceGap).agentId === 'string'
  )
}

/** Chip text: "Might need Web Search (off for Faye)". Names the gap; never widens access. */
export function jevJuiceGapText(gap: JevJuiceGap): string {
  return `Might need ${gap.label} (off for ${gap.agentName})`
}

/** Tooltip text for the gap chip. */
export function jevJuiceGapDetail(gap: JevJuiceGap): string {
  return `Jev thinks this request needs ${gap.label}, which is turned off for ${gap.agentName}. The agent was told. Click to open the agent's settings.`
}

// ---------------------------------------------------------------------------
// SA-120 P6: the after-reply check (reply check + style coach)
// ---------------------------------------------------------------------------

const POST_TURN_FINDING_IDS = new Set<string>([
  'claimed_action',
  'promised_memory',
  'silent_failure',
  'unaddressed_part',
  'repeated_opener',
  'repeated_closer',
  'repeated_phrase',
  'praise_openers',
  'same_move'
])

function isPostTurnFinding(value: unknown): value is JevJuicePostTurnFinding {
  if (!value || typeof value !== 'object') return false
  const finding = value as JevJuicePostTurnFinding
  return (
    POST_TURN_FINDING_IDS.has(finding.id) &&
    (finding.lane === 'reply_check' || finding.lane === 'style_coach') &&
    (finding.source === 'counted' || finding.source === 'inferred')
  )
}

/** Reads one stored after-reply record defensively; anything unreadable is dropped, never guessed. */
export function readJevJuicePostTurnRecord(value: unknown): JevJuicePostTurnRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<JevJuicePostTurnRecord>
  if (typeof raw.messageId !== 'string' || !raw.messageId) return null
  const findings = Array.isArray(raw.findings) ? raw.findings.filter(isPostTurnFinding) : []
  const notes = readJevJuiceNotes({ jevJuice: { notes: raw.notes } })
  if (findings.length === 0 && notes.length === 0) return null
  return {
    messageId: raw.messageId,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    agentId: typeof raw.agentId === 'string' ? raw.agentId : null,
    at: typeof raw.at === 'string' ? raw.at : '',
    findings,
    notes,
    toldAgent: raw.toldAgent === true
  }
}

export function jevJuicePostTurnLaneLabel(lane: JevJuicePostTurnLane): string {
  return lane === 'style_coach' ? 'Style' : 'Reply check'
}

function quoted(detail: string | undefined): string {
  return detail ? `\u201c${detail}\u201d` : 'the same words'
}

function repeatCount(finding: JevJuicePostTurnFinding): string {
  return typeof finding.count === 'number' && typeof finding.window === 'number'
    ? `${finding.count} of the last ${finding.window} replies`
    : 'several recent replies'
}

/** One plain sentence per finding, for the chip's popover. The agent reads its own wording in the DCM. */
export function jevJuicePostTurnFindingText(finding: JevJuicePostTurnFinding): string {
  switch (finding.id) {
    case 'claimed_action':
      return 'Says it did something, but no tool call matches it.'
    case 'promised_memory':
      return 'Says it will remember, but nothing was saved.'
    case 'silent_failure':
      return finding.detail
        ? `A tool failed and the reply does not say so: ${finding.detail}`
        : 'A tool failed and the reply does not say so.'
    case 'unaddressed_part':
      return 'Part of your message may be unanswered.'
    case 'repeated_opener':
      return `Opened ${repeatCount(finding)} with ${quoted(finding.detail)}.`
    case 'repeated_closer':
      return `Closed ${repeatCount(finding)} with ${quoted(finding.detail)}.`
    case 'repeated_phrase':
      return `Used ${quoted(finding.detail)} in ${repeatCount(finding)}.`
    case 'praise_openers':
      return 'Keeps opening by praising you.'
    case 'same_move':
      return 'Recent replies follow the same pattern.'
    default:
      return 'Something looked off.'
  }
}

/**
 * How sure, in the chip's popover: "96% confidence" (Josh, 2026-09-17: always the word, never a
 * bare number, so a newcomer knows what it means); a count says it was counted and how sure Jev
 * is that it is a habit. The agent's own DCM lines keep the raw number.
 */
export function jevJuicePostTurnFindingBasis(finding: JevJuicePostTurnFinding): string {
  const sure =
    typeof finding.probability === 'number' && Number.isFinite(finding.probability)
      ? `${Math.max(0, Math.min(100, Math.round(finding.probability * 100)))}% confidence`
      : ''
  if (finding.source === 'counted') return sure ? `counted, a habit of speech (${sure})` : 'counted'
  return sure || 'a guess'
}

/** Chip text: "Reply check: 2 flags", "Style: 1 note", or both joined. Empty when there are no findings. */
export function jevJuicePostTurnChipText(record: JevJuicePostTurnRecord): string {
  const flags = record.findings.filter((finding) => finding.lane === 'reply_check').length
  const style = record.findings.filter((finding) => finding.lane === 'style_coach').length
  const parts: string[] = []
  if (flags > 0) parts.push(`Reply check: ${flags} ${flags === 1 ? 'flag' : 'flags'}`)
  if (style > 0) parts.push(`Style: ${style} ${style === 1 ? 'note' : 'notes'}`)
  return parts.join(' \u00b7 ')
}

/** The popover's closing line: what happens next, and the one promise that matters. */
export function jevJuicePostTurnToldText(record: JevJuicePostTurnRecord): string {
  return record.toldAgent
    ? 'The agent was told on its next turn. The reply itself was never changed.'
    : 'The agent is told on its next turn. The reply itself is never changed.'
}

// ---------------------------------------------------------------------------
// SA-120 P7: the incoming-text screen (agent DMs, wake-up webhooks, imported skills)
// ---------------------------------------------------------------------------

const UNTRUSTED_TEXT_FINDING_IDS = new Set<string>(['override', 'aimed_at_assistant', 'against_user'])

function isUntrustedTextFinding(value: unknown): value is UntrustedTextFinding {
  if (!value || typeof value !== 'object') return false
  const finding = value as UntrustedTextFinding
  return (
    UNTRUSTED_TEXT_FINDING_IDS.has(finding.id) &&
    typeof finding.probability === 'number' &&
    Number.isFinite(finding.probability)
  )
}

/**
 * What a user-facing surface may draw from a stored screen: a FLAG, or the note that the screen
 * could not run. `no_flag` reads as `null` on purpose, here and therefore everywhere: a missing
 * flag proves nothing, so no badge, chip, or tooltip may ever say "clean" (DL-120-12). Anything
 * unreadable is dropped, never guessed.
 */
export type UntrustedTextScreenView =
  | {
      status: 'flagged'
      severity: 'serious' | 'caution'
      findings: UntrustedTextFinding[]
      harm: number | null
      clipped: boolean
      source: UntrustedTextScreen['source']
    }
  | { status: 'skipped'; reason: TypesafeCallReason; source: UntrustedTextScreen['source'] }

export type UntrustedTextFlagView = Extract<UntrustedTextScreenView, { status: 'flagged' }>

export function readUntrustedTextScreen(value: unknown): UntrustedTextScreenView | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<UntrustedTextScreen>
  const source = raw.source === 'webhook' || raw.source === 'skill' ? raw.source : 'agent_dm'
  if (raw.status === 'flagged') {
    const findings = Array.isArray(raw.findings) ? raw.findings.filter(isUntrustedTextFinding) : []
    if (findings.length === 0) return null
    return {
      status: 'flagged',
      severity: raw.severity === 'serious' ? 'serious' : 'caution',
      findings,
      harm: typeof raw.harm === 'number' && Number.isFinite(raw.harm) ? raw.harm : null,
      clipped: raw.clipped === true,
      source
    }
  }
  if (raw.status === 'skipped') {
    return { status: 'skipped', reason: (raw.reason ?? 'master_off') as TypesafeCallReason, source }
  }
  return null
}

/**
 * The words the USER reads. Josh's review (2026-09-17) set every one of them: Jev is the model
 * that does things, Jev Juice is the feature, so a sentence about an action says "Jev". Each
 * finding is a CATEGORY with its confidence in parentheses, and the word "confidence" is never
 * dropped, even in a list, because a newcomer cannot know what a bare percentage means.
 */
export const JEV_MODEL_NAME = 'Jev'
export const UNTRUSTED_TEXT_BADGE_TEXT = `Flagged by ${JEV_MODEL_NAME}`
/** The same words mid-sentence, for a tool card's subtitle ("to Cooper · woke a chat · flagged by Jev"). */
export const UNTRUSTED_TEXT_INLINE_TEXT = `flagged by ${JEV_MODEL_NAME}`
/** The notice card's title mark: the feature name, because it names WHICH feature raised the card. */
export const UNTRUSTED_TEXT_NOTICE_TITLE = `${JEV_JUICE_NAME} flag`

/** One category name per finding, for a message or for a skill file. Every one is "potential": a flag is a guess. */
export function untrustedTextCategoryText(id: UntrustedTextFindingId, source: UntrustedTextScreen['source']): string {
  switch (id) {
    case 'override':
      return 'Potential takeover attempt'
    case 'aimed_at_assistant':
      return source === 'skill' ? 'Potential overreach' : 'Potential hidden instructions'
    case 'against_user':
      return 'Potentially unwanted request'
    default:
      return 'Potential problem'
  }
}

/** "96% confidence": a whole percent and always the word. */
export function untrustedTextConfidenceText(finding: UntrustedTextFinding): string {
  const percent = Math.max(0, Math.min(100, Math.round(finding.probability * 100)))
  return `${percent}% confidence`
}

/**
 * The category lines of a flag: one line "Category: <name> (96% confidence)", or a "Categories:"
 * heading followed by one line per category, each with its own confidence.
 */
export function untrustedTextCategoryLines(view: UntrustedTextFlagView): string[] {
  const items = view.findings.map(
    (finding) => `${untrustedTextCategoryText(finding.id, view.source)} (${untrustedTextConfidenceText(finding)})`
  )
  if (items.length === 1) return [`Category: ${items[0]}`]
  return ['Categories:', ...items]
}

/** "Potential harm: serious" or "Potential harm: minor". */
export function untrustedTextHarmText(view: UntrustedTextFlagView): string {
  return view.severity === 'serious' ? 'Potential harm: serious' : 'Potential harm: minor'
}

/** The promise every flag carries: it is a guess, it may be wrong, and it blocked nothing. */
export const UNTRUSTED_TEXT_ADVISORY_TEXT = `This is ${JEV_MODEL_NAME}'s best guess, and ${JEV_MODEL_NAME} can be wrong. Nothing was blocked; this flag is only to inform you.`
/** The DM tool card's closing line: the reader saw the flag too. */
export const UNTRUSTED_TEXT_DM_CARD_TOLD_TEXT = 'The agent that read this DM was told the same.'
/** The drawer's closing line: the DM may not be read yet. */
export const UNTRUSTED_TEXT_DRAWER_TOLD_TEXT = 'The agent is told the same when it reads this DM.'
/** The wake-up message's own closing line: it is the text of this turn, so the agent was told in this turn. */
export const UNTRUSTED_TEXT_WAKE_MESSAGE_TOLD_TEXT = 'The agent was told the same in this turn.'
/** Only the first part of a long text was read. */
export const UNTRUSTED_TEXT_CLIPPED_TEXT = 'Only the first part of the text was read.'

/** Every line of a flag block, in order: categories, harm, the promise, the clipped note, then the surface's own closing line. */
export function untrustedTextFlagLines(view: UntrustedTextFlagView, closing?: string | null): string[] {
  const lines = [...untrustedTextCategoryLines(view), untrustedTextHarmText(view), UNTRUSTED_TEXT_ADVISORY_TEXT]
  if (view.clipped) lines.push(UNTRUSTED_TEXT_CLIPPED_TEXT)
  if (closing) lines.push(closing)
  return lines
}

/** One string for a tooltip: the same lines, joined. */
export function untrustedTextFlagDetail(view: UntrustedTextFlagView, closing?: string | null): string {
  return untrustedTextFlagLines(view, closing).join(' ')
}

// --- The notice card above an approval card, in a chat a wake-up message started ---

/** The notice card's first line. A DM that woke a chat is a wake-up message as much as a webhook's is. */
export const UNTRUSTED_TEXT_NOTICE_LEAD = `${JEV_MODEL_NAME} flagged the wake-up message that started this chat.`
/** Shown only when an approval card sits under the notice. */
export const UNTRUSTED_TEXT_APPROVAL_HINT = 'If an approval card follows, read the message before deciding to Approve or Deny.'
export const UNTRUSTED_TEXT_SHOW_MESSAGE_TEXT = 'Show the message'
export const UNTRUSTED_TEXT_DISMISS_TEXT = 'Close this notice'

/** A short quote of the message for the notice card: the subject, then the start of the body, one line. */
export function untrustedTextQuote(subject: string | null | undefined, body: string | null | undefined, maxChars = 160): string {
  const parts = [subject, body]
    .map((part) => (typeof part === 'string' ? part.replace(/\s+/g, ' ').trim() : ''))
    .filter((part) => part.length > 0)
  const text = parts.join(' · ')
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

// --- The origin line on an approval card in a woken turn (no Jev involved) ---

export type WakeOrigin = { kind: 'agent' | 'webhook' | 'schedule'; name: string }

/**
 * "This turn was started by a wake-up message from webhook "Nightly build", not by you." It is
 * drawn on EVERY approval card of a turn a wake-up started, flagged or not, so the card never
 * reads like an ordinary "the agent wants a tool" card. The origin is Batshit's own record of
 * who wrote the DM; Jev has no part in it.
 */
export function wakeOriginText(origin: WakeOrigin | null | undefined): string | null {
  if (!origin || typeof origin.name !== 'string') return null
  const name = origin.name.trim() || 'unknown'
  const who =
    origin.kind === 'webhook'
      ? `webhook "${name}"`
      : origin.kind === 'schedule'
        ? `the schedule "${name}"`
        : `agent "${name}"`
  return `This turn was started by a wake-up message from ${who}, not by you.`
}

// --- The skill import box ---

/** The import box's closing line: the skill is in the form and saving it is still the user's call. */
export const UNTRUSTED_TEXT_IMPORT_ADVISORY_TEXT = `This is ${JEV_MODEL_NAME}'s best guess, and ${JEV_MODEL_NAME} can be wrong. Nothing was blocked: the skill is in the form, and saving it is still your call. Read SKILL.md first.`
/** The skill import dialog's one quiet line when the screen ran and raised nothing. Never a badge. */
export const UNTRUSTED_TEXT_SKILL_NO_FLAG_TEXT = `${JEV_MODEL_NAME} read SKILL.md and raised no flag. That is not a safety check: still read the skill before you trust it.`

/** The import box's lines: categories (skill names), harm, its own closing line. */
export function untrustedTextImportLines(view: UntrustedTextFlagView): string[] {
  const lines = [...untrustedTextCategoryLines(view), untrustedTextHarmText(view), UNTRUSTED_TEXT_IMPORT_ADVISORY_TEXT]
  if (view.clipped) lines.push(UNTRUSTED_TEXT_CLIPPED_TEXT)
  return lines
}

/** The note a skipped screen shows: the same chip words every Jev Juice miss uses. */
export function untrustedTextSkippedNote(view: Extract<UntrustedTextScreenView, { status: 'skipped' }>): JevJuiceNote {
  return { feature: 'untrusted_text', status: 'unavailable', reason: view.reason, at: '' }
}

/**
 * For each message of a chat, the wake-up that started the turn it belongs to, else `null`.
 *
 * A woken turn's user message carries `metadata.wake.dmId` (the wake primitive writes it), and
 * a reply belongs to the nearest user message before it. One pass, so the chat can hand every
 * reply its answer without walking back per message. Used ONLY to draw: the origin line and
 * the notice card of an approval card, and the flag on the wake-up message itself; it decides
 * nothing.
 */
export type WakeTurnRef = { dmId: string; messageId: string | null }

export function resolveWakeTurnsByIndex(
  messages: ReadonlyArray<{ id?: string; role?: string; metadata?: unknown }>
): Array<WakeTurnRef | null> {
  const out: Array<WakeTurnRef | null> = []
  let current: WakeTurnRef | null = null
  for (const message of messages) {
    if (message?.role === 'user') {
      const dmId = (message.metadata as { wake?: { dmId?: unknown } } | null | undefined)?.wake?.dmId
      current =
        typeof dmId === 'string' && dmId.trim()
          ? { dmId: dmId.trim(), messageId: typeof message.id === 'string' && message.id ? message.id : null }
          : null
      out.push(current)
    } else {
      out.push(message?.role === 'assistant' ? current : null)
    }
  }
  return out
}

/** The DM ids only, for callers that need nothing else. */
export function resolveWakeDmIdsByIndex(
  messages: ReadonlyArray<{ id?: string; role?: string; metadata?: unknown }>
): Array<string | null> {
  return resolveWakeTurnsByIndex(messages).map((turn, index) => {
    // A user message keeps `null` here: it IS the wake-up message, not a reply to one.
    if (messages[index]?.role === 'user') return null
    return turn?.dmId ?? null
  })
}
