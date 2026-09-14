/**
 * SA-114 — steer: THE shared rules for a message sent while the agent is still replying.
 *
 * Two verbs, one channel. **Steer** hands the text to the server, which holds it until the
 * agent's next tool call finishes and then places it inside the same reply. **Queue**
 * (SA-119) hands it to the same channel marked `deliver: 'end'`, so it waits out the reply
 * and becomes the next turn's message. `interrupt` was the second verb until SA-119
 * retired it: Stop followed by Enter is that job. This module is
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
 * DL-119-01 — what a send does while the agent is still replying.
 *
 * `steer` is the default: the words wait for the agent's next tool call and land inside the
 * same reply. `queue` is the other one: the words are held and sent the moment the reply
 * ends. SA-114 called the second mode `interrupt` — stop the reply, start a new turn — and
 * SA-119 retires it, because Stop followed by Enter is that job and a hidden third state on
 * the send button was how "Send after reply" came to live behind a hover nobody used.
 *
 * Queue is not a new mechanism. It is the promotion SA-114 already built (DL-119-05, a
 * server-held steer) for a text-only message, and the browser wait DL-114-10 already had
 * (DL-119-06) for a message carrying files: one word for the user, two mechanisms
 * underneath, each already tested.
 *
 * A record written before this story still says `interrupt`. `resolveBusySendMode` reads it
 * as the default; nothing is written back until the user saves the panel themselves.
 */
export type BusySendMode = 'steer' | 'queue'

/**
 * DL-119-05, DL-119-06 — the promise a queued message makes, in one place.
 *
 * Queue has two mechanisms under it and the user is told the same thing by both. A
 * text-only message on a steerable turn is held by the SERVER (`deliver: 'end'`) and becomes
 * the next turn's user message; anything carrying files is held by the BROWSER and sent as
 * an ordinary message the moment the reply ends. The bubble, the badge and the toast all
 * read these constants, because SA-118's F-25 was exactly what happens when one behaviour
 * gets two wordings in two components.
 *
 * These replace `WAIT_SEND_SENTENCE` ("With files: waits for the reply to finish"), which
 * described the waiting rather than the sending and belonged to the retired third send
 * state.
 */
export const QUEUED_AFTER_REPLY_SENTENCE = 'Queued — sends after this reply'
export const QUEUED_WITH_FILES_SENTENCE = 'Queued — sends after this reply (with files)'

/**
 * DL-119-06 — the honest refusal when a second message tries to queue in the browser.
 *
 * One client-held message per chat at a time: a second would race the first for the same
 * "the reply just ended" moment, and the loser sends into a live turn. The words stay in
 * the composer, which is the whole point of saying it out loud rather than dropping one.
 *
 * The files sentence is DL-119-06's own. The second exists because the same browser hold
 * also carries a TEXT-only message whenever the turn cannot take a steer (a group chat, an
 * unmanaged profile, a Codex exec lane) — telling that user "with files" would be a
 * sentence about a message they did not send (F-P2-2).
 */
export const QUEUE_ONE_AT_A_TIME_SENTENCE =
  'One queued message with files at a time — send it after this one'
export const QUEUE_ONE_AT_A_TIME_TEXT_SENTENCE =
  'One queued message at a time — send it after this one'

/** Josh's call (2026-09-07, carried into DL-119-01): steer is the default; Queue is the other badge. */
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
  // DL-119-01: `interrupt` is a record this app can no longer honour — the mode it names
  // was retired with the branch behind it — so it reads as the default rather than as a
  // third value every caller would then have to have an answer for. It is a READ, not a
  // migration: nothing is written until the user saves the panel themselves.
  if (raw === 'steer' || raw === 'queue') return raw
  return DEFAULT_BUSY_SEND_MODE
}

/**
 * What the settings route stores (DL-114-01).
 *
 * The sibling global blocks are passed through unvalidated, and this one is not, because a
 * mode is one of exactly two words: storing anything else would leave a record that reads
 * back as the default forever with no way to tell it from a real choice. Unknown keys are
 * dropped for the same reason. DL-119-01: a stored `interrupt` lands here as `steer` on the
 * next save, because `resolveBusySendMode` is what this delegates to.
 */
export function normalizeGlobalChatSettings(value: unknown): GlobalChatSettings {
  return { busy_send_mode: resolveBusySendMode({ global_chat_settings: value }) }
}

/**
 * The mode Cmd/Ctrl+Enter sends with for ONE message (DL-114-01, DL-119-02).
 *
 * The shortcut is "the other way", not one named mode: with the setting on `queue`, the
 * one-off has to be able to steer, or the shortcut would be dead for exactly the people who
 * changed the default. `resolveBusySendActions` calls this for its `other`, so the badge
 * pair and the keyboard cannot come to disagree about which one is the other one.
 */
export function otherBusySendMode(mode: BusySendMode): BusySendMode {
  return mode === 'steer' ? 'queue' : 'steer'
}

/** What a badge says, and what the send icon says it will do (DL-119-01, DL-119-03). */
export function busySendModeLabel(mode: BusySendMode): string {
  return mode === 'steer' ? 'Steer' : 'Queue'
}

/**
 * The note beside a Steer badge that cannot be pressed, when the server sent no reason.
 *
 * Deliberately short and deliberately not one of the `NOT_STEERABLE_*` sentences below:
 * those three end "Your message interrupts instead", which stopped being true when
 * DL-119-07 retired interrupt-and-send. They are the server's own refusal text on a path
 * P1 does not own; F-P1-2 records them for P2, which owns the words the user reads.
 */
const STEER_DISABLED_FALLBACK_NOTE = 'This reply can’t take a steer.'

/** Why Steer is greyed out, in the user's words (DL-119-02). */
const STEER_CLIPS_NOTE = 'Won’t include the file — it stays here.'
const STEER_MENTIONS_NOTE = 'Mentions can’t steer.'

/** What one of the two badges beside Stop can do right now (DL-119-02). */
export interface BusySendBadgeState {
  enabled: boolean
  /** Shown as plain text beside a disabled badge, or as Steer's warning when it is on. */
  note: string | null
}

/** Everything the busy composer needs to draw itself and answer both keys (DL-119-02). */
export interface BusySendActions {
  /** What plain Enter does. */
  enter: BusySendMode
  /** What Cmd/Ctrl+Enter does. */
  other: BusySendMode
  steer: BusySendBadgeState
  queue: BusySendBadgeState
}

/**
 * DL-119-02 — THE rule for the busy composer: one function, four inputs, every answer.
 *
 * SA-118's F-25 put a third send state behind a hover tooltip, and Josh's finding (2026-09-13)
 * was that people press Enter and nobody hovers. So the choice is two visible badges, and
 * this decides which one is filled, what each key does, whether Steer is clickable at all,
 * and the sentence shown beside it when it is not. All of it in one place, because the
 * moment the badge's label and the key's behaviour are computed separately is the moment a
 * button starts promising something the keyboard does not do — the exact failure SA-114
 * built `resolveEffectiveBusySendMode` to remove and this replaces it to keep removing.
 *
 * The order of the three things that can disable Steer is load-bearing:
 *
 * 1. **The server said this reply cannot be steered.** There is no inside to land in, so
 *    nothing the composer holds can change the answer. This is the order `+page.svelte`
 *    takes too, and the note is the server's own reason.
 * 2. **An `@file` mention.** It travels as `metadata.fileReferences`, which the steer route
 *    cannot carry (PR #106 review F-23), and unlike a clip it cannot "stay in the box" —
 *    the path is inline in the text the user is sending. So it can only queue.
 * 3. **A clip.** Steer stays available and sends the words now; DL-119-04 keeps the clip in
 *    the composer rather than throwing it away, which is what the note says.
 *
 * `steerable` is the server's verdict for the reply in flight (`resolveSteerability`, read
 * off the run). `null` means "not told yet", and it counts as steerable on purpose: the
 * alternative is greying out Steer for the fraction of a second before a reply's `start`
 * event lands, and the route's 409 is already the backstop.
 *
 * **Enter queues whenever the box carries a file** (Josh's design), whatever the default —
 * a clip is the case where "send it now" silently means "send it without the thing I
 * attached", so the safe key is the one that keeps everything together.
 *
 * Queue is enabled always. That is DL-119-05 and DL-119-06 together: a text-only message is
 * held by the server, anything else waits in the browser, and between them every message
 * has a way to be sent. "Nothing you typed is lost" rests on that being unconditional.
 */
export function resolveBusySendActions(input: {
  mode: BusySendMode
  /** The server's verdict for the reply in flight. `null`/omitted means "not told yet". */
  steerable?: boolean | null
  /** The server's plain-English "why not", shown as Steer's note when it refused. */
  steerReason?: string | null
  /** Clips attached in the composer. They stay there when Steer sends (DL-119-04). */
  hasClips: boolean
  /** `@file` mentions in the text. They cannot steer at all (DL-119-02). */
  hasMentions: boolean
}): BusySendActions {
  const refusedByServer = input.steerable === false
  const steerEnabled = !refusedByServer && !input.hasMentions

  const note = refusedByServer
    ? (input.steerReason ?? '').trim() || STEER_DISABLED_FALLBACK_NOTE
    : input.hasMentions
      ? STEER_MENTIONS_NOTE
      : input.hasClips
        ? STEER_CLIPS_NOTE
        : null

  // With Steer unavailable both keys queue: offering "the other mode" would be offering a
  // key that does nothing, which is what the tooltip on a group chat used to do.
  if (!steerEnabled) {
    return {
      enter: 'queue',
      other: 'queue',
      steer: { enabled: false, note },
      queue: { enabled: true, note: null }
    }
  }

  // A file in the box makes Enter queue whatever the default is; the other key is then
  // Steer, which is the only way to send the words now AND keep the file.
  const enter: BusySendMode = input.hasClips ? 'queue' : input.mode
  return {
    enter,
    other: otherBusySendMode(enter),
    steer: { enabled: true, note },
    queue: { enabled: true, note: null }
  }
}

/** Where a steer came from. A DM steer is labelled as not from the user (DL-114-13, P4). */
export type SteerSource = 'user' | 'dm'

/** Which transport delivered a steer. Only `api` can deliver in P1. */
export type SteerLane = 'api' | 'codex' | 'claude'

/**
 * DL-119-05 — WHEN a held message is meant to reach the model.
 *
 * `now` is a steer: hand it over at the running reply's next tool boundary. `end` is Queue:
 * hold it, skip every boundary, and let the end of the turn promote it into the user's next
 * message. One field rather than a second inbox, because everything else about the two is
 * identical — the cap, the ownership of the text, the Stop drop, the promotion that joins
 * several into one message, the bubble's lifetime.
 *
 * The DM door (`deliverBySteer`) never sets it: an agent DM always delivers now.
 */
export type SteerDeliver = 'now' | 'end'

/**
 * The ONE validator for `deliver`, shared by the route and its tests (DL-119-05).
 *
 * The route refuses an unknown value rather than coercing it to the default. A steer stored
 * with a timing nobody chose either lands mid-reply when the user asked it to wait, or waits
 * when they asked it to land — and both read as Batshit ignoring the badge they pressed.
 */
export function isSteerDeliver(value: unknown): value is SteerDeliver {
  return value === 'now' || value === 'end'
}

export interface SteerEntry {
  steerId: string
  /** The ASSISTANT message id this steer belongs inside. The route pins it to the live turn. */
  messageId: string
  text: string
  /** ISO timestamp of acceptance, not delivery. */
  at: string
  source: SteerSource
  /**
   * DL-119-05 — `end` means Queue: never handed to a transport at a tool boundary, promoted
   * with everything else when the reply ends. Absent means `now`, which is what every entry
   * written before SA-119 and every DM steer is.
   */
  deliver?: SteerDeliver
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
 * The AI view of one steer (DL-114-04, DL-118-07). A user steer reads as the user's own
 * words so the agent honours it; a DM steer is explicitly marked as NOT from the user,
 * because an agent's text must never be mistaken for an instruction from Josh.
 *
 * **This is the only wrapper.** Until SA-118 there were two: this spelling for the history
 * replay, and `[Steer — from the user, mid-reply]\n…` for the live delivery on all three
 * lanes. The guidance taught only this one — so at the single moment "outranks what you
 * were told earlier" is meant to apply, the model was reading a label it had never been
 * taught, and met the taught one a turn later in the replay (PR #106 review F-15). This
 * spelling won because it is the one on three surfaces and in every stored turn.
 *
 * The guidance is not a copy of this text: `toolPromptInjection.ts` builds its sentence
 * from `STEER_WRAPPER_GUIDANCE_EXAMPLES`, which this function produces. The two packaged
 * `docs/batshit_System_Prompts/batshit_tool_prompt_zip_control_*.md` files are the same
 * words by hand, and `toolPromptInjection.test.ts` fails if any surface drifts.
 */
export function formatSteerForModel(steer: SteerEntry): string {
  const text = steer.text.trim()
  if (steer.source === 'dm') {
    const from = (steer.label ?? '').trim() || 'another agent'
    return `[Agent DM — from ${from}, not from the user, delivered mid-reply: ${text}]`
  }
  return `[The user said, mid-reply: ${text}]`
}

/**
 * The two wrappers, with `...` where the words go — what every surface that teaches the
 * model about a mid-reply line must quote (DL-118-07).
 *
 * Derived from `formatSteerForModel` rather than written out, so the guidance cannot say
 * one thing while the delivery does another. `<name>` stands in for the sender because the
 * guidance is describing a shape, not one DM.
 */
export const STEER_WRAPPER_GUIDANCE_EXAMPLES = {
  user: formatSteerForModel({
    steerId: 'example',
    messageId: 'example',
    at: '',
    source: 'user',
    text: '...'
  }),
  dm: formatSteerForModel({
    steerId: 'example',
    messageId: 'example',
    at: '',
    source: 'dm',
    label: '<name>',
    text: '...'
  })
} as const

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

/**
 * Why this reply cannot take a steer, in the user's words (F-P1-2, DL-119-07).
 *
 * Every one of these used to end "Your message interrupts instead", which was true until
 * DL-119-07 retired interrupt-and-send and false the moment it landed: nothing stops the
 * reply any more, and the message queues. A sentence that names a branch the app no longer
 * has is worse than none, because these are exactly what DL-119-03 prints as plain text
 * beside a Steer badge the user cannot press — the one moment they decide what to do next.
 *
 * They are EXPORTED because `+page.svelte` had hand-copied two of them (F-P1-2), and two
 * copies of one sentence is how they come to disagree.
 */
export const STEER_REFUSED_GROUP_SENTENCE =
  'Group chats cannot be steered — each agent speaks in turn, so your message queues and sends when the reply ends.'
export const STEER_REFUSED_UNKNOWN_SENTENCE =
  'This agent cannot be steered mid-reply, so your message queues and sends when the reply ends.'
export const STEER_REFUSED_CODEX_EXEC_SENTENCE =
  'This Codex agent runs on the one-shot exec transport, which closes its input as soon as the prompt is sent, so your message queues and sends when the reply ends.'
export const STEER_REFUSED_UNMANAGED_SENTENCE =
  'This agent runs from your own CLI profile, which Batshit does not drive, so it cannot be steered mid-reply; your message queues and sends when the reply ends.'

const NOT_STEERABLE_GROUP = STEER_REFUSED_GROUP_SENTENCE
const NOT_STEERABLE_UNKNOWN = STEER_REFUSED_UNKNOWN_SENTENCE
const NOT_STEERABLE_CODEX_EXEC = STEER_REFUSED_CODEX_EXEC_SENTENCE
const NOT_STEERABLE_UNMANAGED = STEER_REFUSED_UNMANAGED_SENTENCE

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
 * The text a lane hands to the model for one delivery (DL-114-05, DL-118-07).
 *
 * All three transports send the same wrapper so an agent sees one shape whatever it is
 * running on: the API lane injects it as a user message, Codex sends it as a `turn/steer`
 * text item (P2), and Claude writes it as a second stream-json user line (P2). Since
 * SA-118 that wrapper is also the one the history replay uses and the one the guidance
 * teaches — `formatSteerForModel`, and nothing else.
 *
 * Several steers that arrive before the same boundary are joined into ONE message, in
 * acceptance order, because they are one interruption from the user's point of view.
 */
export function buildSteerInjectionText(steers: SteerEntry[]): string {
  return steers.map(formatSteerForModel).join('\n\n')
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

/* ------------------------------------------------------------------ *
 * PR #106 review F-4 — what the client does with a refused steer.
 * ------------------------------------------------------------------ */

export type SteerRefusalKind = 'already_finished' | 'queue' | 'refused'

/**
 * Only two refusals may escalate. `reply_finished` means there is nothing to steer into
 * any more, so the words go out as an ordinary message. `not_steerable` means this agent
 * cannot be steered at all — and since DL-119-07 that answer is **queue**, not interrupt:
 * the words wait in the browser and go the moment the reply ends (DL-119-06), which is what
 * the user asked for rather than the stop they did not. EVERYTHING else — the cap
 * (`steer_inbox_full`), a waiting DM (`steer_dm_pending`), a bad request, a lost server — is
 * `refused`: the client shows the reason and stops. The reply keeps running, and the steers
 * it already accepted stay where they are. Collapsing those into "interrupt instead" is how
 * five accepted messages were thrown away and the bubbles blamed the user for a Stop nobody
 * pressed.
 *
 * The TAG wins over the sentence, always: `refusal: 'reply_finished'` is a contract and the
 * reason beside it is for people, so a tagged refusal is "too late" whatever words came
 * with it (F-P3-5).
 */
export function classifySteerRefusal(
  status: number | null | undefined,
  payload: Record<string, unknown> | null | undefined
): SteerRefusalKind {
  const reason = typeof payload?.reason === 'string' ? payload.reason : ''
  if (payload?.refusal === 'reply_finished' || reason.startsWith('That reply already finished')) {
    return 'already_finished'
  }
  if (status === 409 && payload?.code === 'not_steerable') return 'queue'
  return 'refused'
}

/* ------------------------------------------------------------------ *
 * SA-119 P2b (F-P2-7) — the interruption note after Stop, then Enter.
 * ------------------------------------------------------------------ */

/** What Stop leaves behind for the next send: which reply it cut, and when. */
export interface StopInterruptionRecord {
  messageId: string
  interruptedAt: string
}

/**
 * What `send-routed` turns into the model's `==== INTERRUPTION NOTE ====`, travelling as
 * `metadata.interruption` on the user message and on the request body.
 */
export interface InterruptionStamp {
  previousMessageId: string
  interruptedAt: string
  reason: 'user'
}

/**
 * Does the send that follows a Stop tell the model the previous reply was cut short?
 *
 * DL-119-07 retired interrupt-and-send, and the branch it deleted was the only writer of
 * `metadata.interruption` — so after SA-119 P2 the model was no longer told, even though
 * `buildInterruptionAddendum` was still waiting to be given something. Stop, then Enter, is
 * now the whole gesture, so Stop's record is the only source (F-P2-7).
 *
 * Three things say no:
 *
 * - **No record.** Nothing was stopped, so there is nothing to say.
 * - **The browser was holding this message.** A steer and a server-held queue return long
 *   before the ordinary send path, but a BROWSER-held queue falls through into it — and
 *   what it waits for, "the reply ends", is exactly what a Stop makes happen. Stamping it
 *   would tell the model the user cut short a reply the user had chosen to wait behind.
 * - **The stopped reply is no longer the agent's last word.** A turn has landed since, so
 *   the note would name the wrong message.
 *
 * A record missing either field is not completed from a default: a fabricated timestamp is
 * a worse answer than no note, and the one writer always sets both.
 */
export function resolveStopInterruptionStamp(input: {
  record: StopInterruptionRecord | null | undefined
  browserQueued: boolean
  latestAssistantMessageId: string | null | undefined
}): InterruptionStamp | null {
  const messageId =
    typeof input.record?.messageId === 'string' ? input.record.messageId.trim() : ''
  const interruptedAt =
    typeof input.record?.interruptedAt === 'string' ? input.record.interruptedAt.trim() : ''
  if (!messageId || !interruptedAt) return null

  if (input.browserQueued) return null

  const latest =
    typeof input.latestAssistantMessageId === 'string'
      ? input.latestAssistantMessageId.trim()
      : ''
  if (!latest || latest !== messageId) return null

  return { previousMessageId: messageId, interruptedAt, reason: 'user' }
}
