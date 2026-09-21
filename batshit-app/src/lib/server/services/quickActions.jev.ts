/**
 * SA-120 P9 (design record F2, DL-120-15) — quick actions from speech.
 *
 * THE constants module for this feature (DL-120-03): the questions, the floors, and the
 * decision. ONE Jev request per spoken turn: a Noul per catalog action ("does the user ask
 * Batshit to <action>, right now?"), a Noul "is that the whole turn?", and the Settings tab
 * Choice. Code decides: the top action at or over the floor, with no second action over it,
 * fires; `only_the_request` at or over its floor means nothing is sent to the agent.
 *
 * Wording and floors were chosen by probe (`_local/typesafe/probes/p9/`, rounds 1-3, 75
 * spoken turns): with the floor at 0.8, none of 27 non-requests fired (the closest,
 * "don't open the dock", scored 0.51 for closing it) and none of 5 bare words ("quiet",
 * "settings") fired (0.68-0.74), while 34 of 36 plain requests fired (the closest, "Stop.",
 * 0.85) and the two misses ("open up the agent settings" 0.72, "show me the goon's
 * settings" 0.59) simply went to the agent. `only_the_request` separated pure requests
 * (0.84-0.98) from mixed ones (0.03-0.29). A miss is the safe direction: the turn goes to
 * the agent exactly as it does with the switch off.
 *
 * The lane is `in_chat` (P8): the user's In-Chat Wait Limit is the budget, because the send
 * waits on this answer. The call runs from `POST /api/jev-juice/quick-action` before the
 * browser decides whether to send at all, so the route records the Execution Viewer entry
 * itself (`qa_…`): a call with no turn still has a row (DL-120-07).
 */

import type { TypesafeCallRecord } from '$lib/types/typesafe'
import {
  QUICK_ACTION_FEATURE_ID,
  QUICK_ACTION_SETTINGS_TABS,
  QUICK_ACTIONS,
  isQuickActionSettingsTab,
  type QuickActionId,
  type QuickActionSettingsTab
} from '$lib/utils/jevJuiceQuickActions'
import { runTypesafeJudgment } from './typesafe/typesafeAvailability'
import type { JevChoiceQuestion, JevNoulQuestion, JevQuestions, TypesafeClient } from './typesafe/typesafeClient'

export { QUICK_ACTION_FEATURE_ID }

export const QUICK_ACTION_LIMITS = Object.freeze({
  /** A spoken turn longer than this is not a quick action; the request is clipped and Jev sees the start. */
  maxSaidChars: 600,
  /** The top action must reach this, and no other action may (a tie is no action). Probe: closest non-request 0.51, closest bare word 0.74, closest request 0.85. */
  actionFloor: 0.8,
  /** "The request was the whole turn" must reach this to swallow the turn. Probe: pure 0.84-0.98, mixed 0.03-0.29. A miss sends the turn on, the mild direction. */
  onlyFloor: 0.8,
  /** The Settings tab is a soft hint: under this, Settings opens on its usual tab. */
  tabFloor: 0.6
})

export const QUICK_ACTION_QUESTIONS = Object.freeze({
  context:
    'The user is talking out loud to their AI assistant inside Batshit, a desktop chat app. `said` is exactly what the speech-to-text heard for this one turn. ' +
    'Batshit itself (not the assistant) can carry out a few small app actions the moment the user asks for one. ' +
    'In Batshit, "the dock" or "the Goon Dock" is the panel that shows the assistant\'s 3D character, called its Goon; "hang up" ends the voice conversation; "the execution viewer" shows what the assistant did behind a reply.',
  wants: {
    instructions: (ask: string) => `In \`said\`, does the user ask Batshit to ${ask}, right now?`,
    criteria: (words: string) => ({
      true: `Yes: a present request or command for exactly this, however casually or politely it is put (people say ${words}).`,
      false:
        'No: the user asks for something else, talks about this instead of asking for it (wondering, describing, explaining, quoting, telling a story, asking what it does, saying not to, or meaning later), or the words are unrelated.'
    })
  },
  onlyTheRequest: {
    instructions: 'Is `said` nothing but the request for the app action?',
    criteria: {
      true: 'Yes: only the request, possibly with filler, repetition, emphasis, or feeling ("okay okay stop", "that\'s enough, be quiet", "please stop", "hush", "show me the goon", "hang up").',
      false: 'No: the turn also carries a question for the assistant to answer, a fact for it to take in, or a task for it to do.'
    }
  },
  settingsTab: {
    instructions: 'If `said` asks to open settings, which settings tab does it name?',
    unspecified: 'No particular tab was named.'
  }
})

function noul(instructions: string, criteria: JevNoulQuestion['criteria']): JevNoulQuestion {
  return { type: 'noul', instructions, criteria }
}
function choice(instructions: string, criteria: Record<string, unknown>): JevChoiceQuestion {
  return { type: 'choice', instructions, criteria }
}

export function clipQuickActionSaid(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.slice(0, QUICK_ACTION_LIMITS.maxSaidChars)
}

export interface QuickActionRequest {
  state: { context: string; said: string }
  questions: JevQuestions
}

/** ONE request: `{ context, said }` and the fixed question set. `null` for an empty turn. */
export function buildQuickActionRequest(said: string): QuickActionRequest | null {
  const text = clipQuickActionSaid(said)
  if (!text) return null
  const questions: JevQuestions = {}
  for (const action of QUICK_ACTIONS) {
    questions[`wants_${action.id}`] = noul(
      QUICK_ACTION_QUESTIONS.wants.instructions(action.ask),
      QUICK_ACTION_QUESTIONS.wants.criteria(action.words)
    )
  }
  questions.only_the_request = noul(QUICK_ACTION_QUESTIONS.onlyTheRequest.instructions, QUICK_ACTION_QUESTIONS.onlyTheRequest.criteria)
  questions.settings_tab = choice(QUICK_ACTION_QUESTIONS.settingsTab.instructions, {
    ...QUICK_ACTION_SETTINGS_TABS,
    unspecified: QUICK_ACTION_QUESTIONS.settingsTab.unspecified
  })
  return { state: { context: QUICK_ACTION_QUESTIONS.context, said: text }, questions }
}

export interface QuickActionDecision {
  /** The action to run, or `null`: nothing fired and the turn goes to the agent untouched. */
  action: QuickActionId | null
  /** Only with `open_settings`; `null` when no tab reached the tab floor. */
  tab: QuickActionSettingsTab | null
  /** The top action's probability, whether or not it fired. */
  confidence: number
  /** The runner-up's probability (a tie at or over the floor is no action). */
  second: number
  /** True: the request was the whole turn; nothing is sent to the agent. Only meaningful with an action. */
  onlyThis: boolean
  /** The Execution Viewer's decision text. */
  summary: string
}

function readNoul(answers: Record<string, unknown>, key: string): number {
  const answer = answers[key] as { noul?: unknown } | undefined
  const value = typeof answer?.noul === 'number' ? answer.noul : Number.NaN
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

/** Pure. The floors are pinned at their boundaries by `quickActions.jev.test.ts`. */
export function decideQuickAction(answers: Record<string, unknown>): QuickActionDecision {
  const scored = QUICK_ACTIONS.map((action) => ({ id: action.id, value: readNoul(answers, `wants_${action.id}`) })).sort(
    (a, b) => b.value - a.value
  )
  const top = scored[0]
  const second = scored[1]?.value ?? 0
  const fires = top.value >= QUICK_ACTION_LIMITS.actionFloor && second < QUICK_ACTION_LIMITS.actionFloor
  const only = readNoul(answers, 'only_the_request')
  const onlyThis = fires && only >= QUICK_ACTION_LIMITS.onlyFloor

  let tab: QuickActionSettingsTab | null = null
  if (fires && top.id === 'open_settings') {
    const answer = answers.settings_tab as { choice?: unknown; probabilities?: Record<string, unknown> } | undefined
    const picked = answer?.choice
    const probability = typeof answer?.probabilities?.[String(picked)] === 'number' ? (answer!.probabilities![String(picked)] as number) : 0
    if (isQuickActionSettingsTab(picked) && probability >= QUICK_ACTION_LIMITS.tabFloor) tab = picked
  }

  const percent = (value: number) => value.toFixed(2)
  const summary = fires
    ? `${top.id} ${percent(top.value)} (next ${percent(second)}); only the request ${percent(only)} → ${onlyThis ? 'nothing sent to the agent' : 'the rest sent to the agent'}${tab ? `; tab ${tab}` : ''}`
    : top.value >= QUICK_ACTION_LIMITS.actionFloor
      ? `${top.id} ${percent(top.value)} tied with ${scored[1]?.id ?? 'none'} ${percent(second)} → no action`
      : `top ${top.id} ${percent(top.value)} (needed ${QUICK_ACTION_LIMITS.actionFloor}) → no action`

  return { action: fires ? top.id : null, tab, confidence: top.value, second, onlyThis, summary }
}

export interface ComputeQuickActionInput {
  userId: string
  said: string
  /** The switch, resolved by the route from the user's voice settings. */
  featureEnabled: boolean
  /** Test seam. */
  client?: TypesafeClient
}

export interface QuickActionOutcome {
  /** `null` when nothing fired, whether Jev said so or never answered. */
  decision: QuickActionDecision | null
  record: TypesafeCallRecord | null
}

/** One spoken turn's worth of judgment. Never throws; a miss means "no quick action this turn". */
export async function computeQuickAction(input: ComputeQuickActionInput): Promise<QuickActionOutcome> {
  const request = buildQuickActionRequest(input.said)
  if (!request) return { decision: null, record: null }
  const result = await runTypesafeJudgment({
    userId: input.userId,
    featureId: QUICK_ACTION_FEATURE_ID,
    featureEnabled: input.featureEnabled,
    state: request.state,
    questions: request.questions,
    // The send waits on this answer, so the user's In-Chat Wait Limit is the budget (P8, LS-059).
    lane: 'in_chat',
    client: input.client
  })
  const record = result.record
  if (!result.response) return { decision: null, record }
  const decision = decideQuickAction(result.response.answers as Record<string, unknown>)
  record.decision = decision.summary
  return { decision: decision.action ? decision : null, record }
}
