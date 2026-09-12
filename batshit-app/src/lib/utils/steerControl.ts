/**
 * SA-114 — steer: THE shared rules for a message sent while the agent is still replying.
 *
 * Two verbs, one channel. **Steer** hands the text to the server, which holds it until the
 * agent's next tool call finishes and then places it inside the same reply. **Interrupt**
 * is today's behaviour: the reply stops and the message starts a new turn. This module is
 * browser-safe on purpose — the route, the registry, the compiler twins, the Execution
 * Viewer, and (from P3) the client all read the same rules from here rather than restating
 * them, which is the mistake `decideRiskGate` had to be built to undo in SA-116.
 */

import { escapeHtml } from '$lib/utils/htmlEntities'

/**
 * How many steers may wait for one turn. A sixth is refused with a reason rather than
 * queued: the honest answer at that point is "wait for the reply".
 */
export const MAX_PENDING_STEERS = 5

/**
 * AMD-114-03: DL-114-03 says "capped at the normal message size", but Batshit has no such
 * cap — an ordinary chat message is unbounded. The DM body ceiling is the nearest measured
 * sibling for agent-facing text, so the steer route uses the same number rather than
 * inventing a second one.
 */
export const STEER_TEXT_MAX_CHARS = 40_000

/**
 * P4 (DL-114-13) — why a second agent DM was not allowed to join a reply.
 *
 * It lives HERE rather than in `dmControl.ts`, which is where every other DM sentence
 * lives, because `steerInboxRegistry.ts` raises the refusal and a static test pins that
 * module's only import to this one. Two copies of one sentence in two modules is how they
 * would come to disagree, so there is one, in the module both sides can reach.
 */
export const STEER_DM_ALREADY_PENDING_REASON =
  'Another agent DM is already waiting to land in that reply.'

/**
 * DL-114-01 — what a send does while the agent is still replying.
 *
 * `steer` is the default: the words wait for the agent's next tool call and land inside the
 * same reply. `interrupt` is what Batshit did before this story: the reply stops and the
 * message starts a new turn. There is no third mode — "queue" is what a steer BECOMES when
 * no tool boundary arrives, so naming it would put three buttons on one behaviour.
 */
export type BusySendMode = 'steer' | 'interrupt'

/** Josh's call (2026-09-07): steer is the default, interrupt stays one click away. */
export const DEFAULT_BUSY_SEND_MODE: BusySendMode = 'steer'

/** The new per-user settings block DL-114-01 adds. */
export interface GlobalChatSettings {
  busy_send_mode?: BusySendMode
}

/**
 * THE rule for "what does my send do right now" (DL-114-01).
 *
 * Every reader goes through this: the send button's label, the keyboard shortcut's
 * opposite, and the branch `handleSendMessage` takes. Restating `settings?.x ?? 'steer'`
 * at any of those call sites is how the button would come to promise one thing while the
 * send did another, so none of them does.
 *
 * Anything unreadable resolves to the default rather than throwing — a settings record
 * that has never been written is the normal first-run state, not an error.
 */
export function resolveBusySendMode(settings: unknown): BusySendMode {
  const raw = (settings as any)?.global_chat_settings?.busy_send_mode
  return raw === 'interrupt' || raw === 'steer' ? raw : DEFAULT_BUSY_SEND_MODE
}

/**
 * What the settings route stores (DL-114-01).
 *
 * The sibling global blocks are passed through unvalidated, and this one is not, because a
 * mode is one of exactly two words: storing anything else would leave a record that reads
 * back as the default forever with no way to tell it from a real choice. Unknown keys are
 * dropped for the same reason.
 */
export function normalizeGlobalChatSettings(value: unknown): GlobalChatSettings {
  return { busy_send_mode: resolveBusySendMode({ global_chat_settings: value }) }
}

/**
 * The mode Cmd/Ctrl+Enter sends with for ONE message (DL-114-01).
 *
 * The shortcut is "the other way", not "interrupt": with the setting on `interrupt`, the
 * one-off has to be able to steer, or the shortcut would be dead for anyone who flipped
 * the default.
 */
export function otherBusySendMode(mode: BusySendMode): BusySendMode {
  return mode === 'steer' ? 'interrupt' : 'steer'
}

/** The send button's label while the agent is busy (DL-114-01). */
export function busySendModeLabel(mode: BusySendMode): string {
  return mode === 'steer' ? 'Steer' : 'Interrupt and send'
}

/**
 * What this send will ACTUALLY do (DL-114-01 + DL-114-09).
 *
 * The setting says what the user wants; the running reply says what is possible. This is
 * where the two meet, and it is one function because the send button's label and the branch
 * `handleSendMessage` takes must never disagree — a button that says "Steer" over a send
 * that interrupts is the exact failure this story exists to remove.
 *
 * `steerable` is the server's verdict for the reply in flight (`resolveSteerability`, read
 * off the run). `null` means "not told yet", and it is treated as steerable on purpose: the
 * alternative is labelling every fresh reply "Interrupt and send" for the fraction of a
 * second before its `start` event lands, and the route's 409 is already the backstop.
 */
export function resolveEffectiveBusySendMode(input: {
  mode: BusySendMode
  steerable?: boolean | null
}): BusySendMode {
  if (input.mode === 'interrupt') return 'interrupt'
  return input.steerable === false ? 'interrupt' : 'steer'
}

/** Where a steer came from. A DM steer is labelled as not from the user (DL-114-13, P4). */
export type SteerSource = 'user' | 'dm'

/** Which transport delivered a steer. Only `api` can deliver in P1. */
export type SteerLane = 'api' | 'codex' | 'claude'

export interface SteerEntry {
  steerId: string
  /** The ASSISTANT message id this steer belongs inside. The route pins it to the live turn. */
  messageId: string
  text: string
  /** ISO timestamp of acceptance, not delivery. */
  at: string
  source: SteerSource
  /** DM source only (DL-114-13). */
  dmId?: string
  /** DM source only: the sender's display name, frozen at send time. */
  label?: string
}

/** A steer that reached the model, recorded in the assistant record by DL-114-04. */
export interface DeliveredSteer extends SteerEntry {
  /** The step index the lane delivered at. The API lane's `prepareStep` sees `steps.length`. */
  step: number
  lane: SteerLane
}

/**
 * A steer id travels inside stored assistant content as `{{batshit-steer:<id>}}`, so it has
 * to be safe to put there. This charset cannot close the braces, cannot contain the `:::`
 * separator the zip family uses, and cannot introduce whitespace.
 */
const STEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function isValidSteerId(value: unknown): value is string {
  return typeof value === 'string' && STEER_ID_PATTERN.test(value)
}

/**
 * The transcript placeholder (DL-114-04). It joins the zip placeholder's family in the
 * compile helpers but is NOT a control tag: it is written by Batshit at a tool boundary,
 * never by the model, so `controlTags.ts` does not own it.
 */
export function buildSteerPlaceholder(steerId: string): string {
  return `{{batshit-steer:${steerId}}}`
}

/**
 * A FRESH regex per call, never one shared module-level `/g` instance.
 *
 * A global regex carries `lastIndex` between calls: `test()` leaves it advanced, and
 * `matchAll` starts from wherever it was left. Sharing one instance across these helpers
 * made a marker invisible to the second reader — which is exactly how the raw braces would
 * have reached the chat.
 */
const steerPlaceholderRegex = () => /\{\{batshit-steer:([A-Za-z0-9_-]{1,64})\}\}/g

/**
 * The expansion variant, which also eats the blank lines around the marker.
 *
 * The stored content already separates the marker from the tool zips before it with a
 * blank line, and the expansion adds its own — without this the compiled history grows a
 * four-newline gap around every steer.
 */
const steerPlaceholderWithGapsRegex = () =>
  /[ \t]*\n*\{\{batshit-steer:([A-Za-z0-9_-]{1,64})\}\}\n*[ \t]*/g

export function hasSteerPlaceholder(content: string | null | undefined): boolean {
  if (!content) return false
  return steerPlaceholderRegex().test(content)
}

/** Every steer id referenced by this content, in the order it appears. */
export function extractSteerPlaceholderIds(content: string | null | undefined): string[] {
  if (!content) return []
  const ids: string[] = []
  for (const match of content.matchAll(steerPlaceholderRegex())) {
    ids.push(match[1])
  }
  return ids
}

/**
 * Read `metadata.steers[]` off a stored message. Returns `[]` for anything malformed so a
 * compile can never throw on a bad record — the placeholder then falls back to a plain
 * note rather than leaking raw braces into the chat.
 */
export function readMessageSteers(message: unknown): DeliveredSteer[] {
  const raw = (message as any)?.metadata?.steers
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is DeliveredSteer =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      isValidSteerId((entry as any).steerId) &&
      typeof (entry as any).text === 'string'
  )
}

/**
 * The AI view of a delivered steer (DL-114-04). A user steer reads as the user's own words
 * so the agent honours it; a DM steer is explicitly marked as NOT from the user, because an
 * agent's text must never be mistaken for an instruction from Josh.
 */
export function formatSteerForAI(steer: DeliveredSteer): string {
  const text = steer.text.trim()
  if (steer.source === 'dm') {
    const from = (steer.label ?? '').trim() || 'another agent'
    return `[Agent DM — from ${from}, not from the user, delivered mid-reply: ${text}]`
  }
  return `[The user said, mid-reply: ${text}]`
}

/**
 * The user view of a delivered steer: the inset bubble, at the spot it arrived (DL-114-04).
 *
 * P1 rendered a markdown blockquote so the chat was honest the moment a steer could land;
 * P3 replaces that with the inset. The placeholder and `metadata.steers[]` did not change
 * when it did — only what this one function returns.
 *
 * It emits HTML rather than markdown because a blockquote cannot look like a small user
 * bubble sitting inside the agent's reply. That is a supported path, not a hack:
 * `MarkdownRenderer` already injects `batshit-skill-pill` markup the same way, `div` /
 * `span` / `br` with `class` survive its DOMPurify allow-list, and the styles live beside
 * that pill's in `markdown.css`. Two consequences are load-bearing:
 *
 * - the text is HTML-escaped, because it is whatever the user typed; and
 * - newlines become `<br>`, because marked ends an HTML block at the first BLANK line, so a
 *   steer with a paragraph break would otherwise spill its second half out of the bubble.
 */
export function formatSteerForUser(steer: DeliveredSteer): string {
  const label =
    steer.source === 'dm'
      ? `Agent DM from ${(steer.label ?? '').trim() || 'another agent'}, mid-reply`
      : 'You, mid-reply'
  const body = escapeHtml(steer.text.trim()).replace(/\r?\n/g, '<br>')
  const dmClass = steer.source === 'dm' ? ' is-dm' : ''
  return (
    `<div class="batshit-steer-inset${dmClass}">` +
    `<span class="batshit-steer-inset-label">${escapeHtml(label)}</span>` +
    `<span class="batshit-steer-inset-text">${body}</span>` +
    `</div>`
  )
}

/**
 * Replace every `{{batshit-steer:id}}` in `content` using the message's own `steers[]`.
 *
 * A placeholder with no matching metadata entry is replaced with a short honest note rather
 * than left as raw braces: the steer demonstrably happened (Batshit wrote the marker), only
 * its text is missing.
 */
export function expandSteerPlaceholders(
  content: string,
  steers: DeliveredSteer[],
  format: (steer: DeliveredSteer) => string
): string {
  if (!content) return content
  const bySteerId = new Map(steers.map((steer) => [steer.steerId, steer]))
  const expanded = content.replace(
    steerPlaceholderWithGapsRegex(),
    (match: string, steerId: string, offset: number, whole: string) => {
      const steer = bySteerId.get(steerId)
      const line = steer
        ? format(steer)
        : '[A message arrived mid-reply, but its text is no longer stored.]'
      // Several steers that landed at the same boundary are stored as consecutive markers.
      // This match has already eaten the blank line after its own marker, and the next
      // expansion supplies its own leading one, so adding a trailing pair here would grow a
      // four-newline gap between two steers (F-P1-4).
      const followedByAnotherMarker = whole
        .slice(offset + match.length)
        .startsWith('{{batshit-steer:')
      return followedByAnotherMarker ? `\n\n${line}` : `\n\n${line}\n\n`
    }
  )
  // A marker at the very start or end of the content would otherwise leave a leading or
  // trailing blank line that was not in the stored message. Only the edges the expansion
  // itself added are removed — content that genuinely began or ended with whitespace keeps
  // it, because the compiled bytes of a stored message must stay predictable.
  let result = expanded
  if (!/^\s/.test(content)) result = result.replace(/^\n+/, '')
  if (!/\s$/.test(content)) result = result.replace(/\n+$/, '')
  return result
}

/**
 * DL-114-09 — who can be steered, decided in ONE place.
 *
 * The route answers `409 not_steerable` with this reason as its backstop, and from P3 the
 * client shows the same reason in the send button's tooltip. Restating the rule at either
 * call site is how the two would drift, so neither does.
 *
 * **P2 made this a real transport check.** The three delivery mechanisms are genuinely
 * different — the SDK's between-step hook for `api`, the app server's `turn/steer` for
 * managed Codex, a second line on the open stdin for managed Claude — so the rule needs to
 * know which transport a run will actually use, not only what type of agent it is. It is
 * given that as DATA (this module stays browser-safe); send-routed resolves it once, at the
 * same moment it registers the run, and the run registry carries the verdict from there.
 */
export type SteerabilityVerdict =
  | { steerable: true; lane: SteerLane }
  | { steerable: false; reason: string }

/**
 * What a `cli` primary is actually running, as plain data.
 *
 * `configScope` is `'managed'` for every live Batshit CLI agent today (both settings
 * builders hard-code it), but the type allows a user-owned profile, and DL-114-09 refuses
 * those: Batshit does not reach into a profile it does not own to change how its process is
 * driven. `codexTransport` is `resolveCodexTransportLane`'s answer — the `exec` lane writes
 * the prompt and closes stdin, so it has no channel left to steer through.
 */
export interface SteerCliRuntime {
  provider: 'codex' | 'claude' | null
  configScope: string | null | undefined
  codexTransport?: 'app-server' | 'exec' | null
}

const NOT_STEERABLE_GROUP =
  'Group chats cannot be steered — each agent speaks in turn, so a message interrupts instead.'
const NOT_STEERABLE_UNKNOWN =
  'This agent cannot be steered mid-reply. Your message interrupts instead.'
const NOT_STEERABLE_CODEX_EXEC =
  'This Codex agent runs on the one-shot exec transport, which closes its input as soon as the prompt is sent. Your message interrupts instead.'
const NOT_STEERABLE_UNMANAGED =
  'This agent runs from your own CLI profile, which Batshit does not drive, so it cannot be steered mid-reply. Your message interrupts instead.'

export function resolveSteerability(input: {
  /** Live primary agent type, already normalised by `normalizePrimaryAgentType`. */
  primaryAgentType: string | null | undefined
  isGroupSession: boolean
  /** Set for `cli` primaries only; ignored for every other type. */
  cli?: SteerCliRuntime | null
}): SteerabilityVerdict {
  if (input.isGroupSession) {
    return { steerable: false, reason: NOT_STEERABLE_GROUP }
  }

  const type =
    typeof input.primaryAgentType === 'string' ? input.primaryAgentType.trim().toLowerCase() : ''

  if (type === 'api') {
    return { steerable: true, lane: 'api' }
  }

  if (type === 'cli') {
    const cli = input.cli ?? null
    // A `cli` primary whose runtime Batshit could not resolve is refused rather than
    // guessed at: a wrong "yes" here sends the user's words into a transport that cannot
    // carry them, and they would sit waiting for a boundary that never comes.
    if (!cli || !cli.provider) {
      return { steerable: false, reason: NOT_STEERABLE_UNKNOWN }
    }
    if (cli.configScope !== 'managed') {
      return { steerable: false, reason: NOT_STEERABLE_UNMANAGED }
    }
    if (cli.provider === 'codex') {
      if (cli.codexTransport !== 'app-server') {
        return { steerable: false, reason: NOT_STEERABLE_CODEX_EXEC }
      }
      return { steerable: true, lane: 'codex' }
    }
    return { steerable: true, lane: 'claude' }
  }

  return { steerable: false, reason: NOT_STEERABLE_UNKNOWN }
}

/**
 * The text a lane hands to the model for one delivery (DL-114-05).
 *
 * All three transports send the same wrapper so an agent sees one shape whatever it is
 * running on: the API lane injects it as a user message, Codex sends it as a `turn/steer`
 * text item (P2), and Claude writes it as a second stream-json user line (P2).
 *
 * Several steers that arrive before the same boundary are joined into ONE message, in
 * acceptance order, because they are one interruption from the user's point of view.
 */
export function buildSteerInjectionText(steers: SteerEntry[]): string {
  return steers
    .map((steer) => {
      const text = steer.text.trim()
      if (steer.source === 'dm') {
        const from = (steer.label ?? '').trim() || 'another agent'
        return `[Agent DM — from ${from}, not from the user, delivered mid-reply]\n${text}`
      }
      return `[Steer — from the user, mid-reply]\n${text}`
    })
    .join('\n\n')
}

/**
 * One delivery, as the two managed CLI lanes need it (P2).
 *
 * The API lane hands the SDK a message object, so it never needs this shape. Both CLI
 * lanes send TEXT over a wire and then have to recognise the transport's own echo of that
 * text coming back — Codex's `userMessage` item (AMD-114-02) and Claude's
 * `--replay-user-messages` line (AMD-114-01). Matching is by exact text, because both
 * transports also echo things Batshit did not steer: Codex emits a `userMessage` item for
 * the turn's ORIGINAL prompt, and Claude replays every user line. So the ids and the exact
 * bytes travel together, and the lane confirms one against the other.
 */
export interface SteerSendPayload {
  steerIds: string[]
  text: string
}

export function buildSteerSendPayload(steers: SteerEntry[]): SteerSendPayload {
  return {
    steerIds: steers.map((steer) => steer.steerId),
    text: buildSteerInjectionText(steers)
  }
}
