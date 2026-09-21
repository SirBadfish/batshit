/**
 * SA-120 P1 — per-agent Jev Juice switches (DL-120-01, LS-049), plus the one global
 * switch P5 adds for smart zip (LS-054) and the one instance switch P7 adds for the
 * incoming-text screen (LS-057).
 *
 * Every Jev Juice feature switch defaults OFF and is resolved ONLY through the
 * function here, from the freshly read owning record (the agent, the user's global zip
 * settings, or the instance Jev Juice config), so the send path, Settings, and the Execution Viewer all read the same
 * rule. Absent means OFF.
 *
 * Browser-safe: no server imports (Agent Settings reads it too).
 */

export const AGENT_JEV_SKILL_TOOL_HINTS_FIELD = 'jev_juice_skill_tool_hints' as const
/** SA-120 P2: the per-agent switch for the `sys.judge.ask` tool. */
export const AGENT_JEV_JUDGE_TOOL_FIELD = 'jev_juice_judge_tool' as const
/** SA-120 P4a: the per-agent switch for the Jev relevance term in `sys.memory.search` (LS-052). */
export const AGENT_JEV_MEMORY_RERANK_FIELD = 'jev_juice_memory_rerank' as const
/** SA-120 P4b: the per-agent switch for recall by meaning in the DCM `Memory context:` section (LS-053). */
export const AGENT_JEV_MEMORY_RECALL_FIELD = 'jev_juice_memory_recall' as const
/** SA-120 P6: the per-agent switch for the after-reply check of what a reply claims (LS-055). */
export const AGENT_JEV_REPLY_CHECK_FIELD = 'jev_juice_reply_check' as const
/** SA-120 P6: the per-agent switch for the after-reply style coach (LS-056). */
export const AGENT_JEV_STYLE_COACH_FIELD = 'jev_juice_style_coach' as const

/** Every per-agent Jev Juice switch, with the wording the write-side error uses. */
export const AGENT_JEV_JUICE_FIELDS = Object.freeze({
  [AGENT_JEV_SKILL_TOOL_HINTS_FIELD]: 'Jev Juice: Suggest Skills and Tools',
  [AGENT_JEV_JUDGE_TOOL_FIELD]: 'Jev Juice: Judgment Tool',
  [AGENT_JEV_MEMORY_RERANK_FIELD]: 'Jev Juice: Rerank Memory Search',
  [AGENT_JEV_MEMORY_RECALL_FIELD]: 'Jev Juice: Recall by Meaning',
  [AGENT_JEV_REPLY_CHECK_FIELD]: 'Jev Juice: Check Replies',
  [AGENT_JEV_STYLE_COACH_FIELD]: 'Jev Juice: Style Coach'
})

function readSwitch(agent: unknown, field: string): boolean {
  if (!agent || typeof agent !== 'object') return false
  return (agent as Record<string, unknown>)[field] === true
}

/** THE rule for "may this agent's sends ask Jev for skill and tool hints?" */
export function resolveAgentJevSkillToolHintsEnabled(agent: unknown): boolean {
  return readSwitch(agent, AGENT_JEV_SKILL_TOOL_HINTS_FIELD)
}

/** THE rule for "does this agent hold the `sys.judge.ask` tool?" (PRIMARY actors only; callers pass explicit false for delegated runs). */
export function resolveAgentJevJudgeToolEnabled(agent: unknown): boolean {
  return readSwitch(agent, AGENT_JEV_JUDGE_TOOL_FIELD)
}

/**
 * THE rule for "may this agent's memory searches ask Jev how relevant each hit is?"
 * Memory itself is gated separately (`resolveAgentMemoryEnabled`); with memory off the
 * search tool does not exist, so this switch alone never sends anything.
 */
export function resolveAgentJevMemoryRerankEnabled(agent: unknown): boolean {
  return readSwitch(agent, AGENT_JEV_MEMORY_RERANK_FIELD)
}

/**
 * THE rule for "may this agent's sends ask Jev which long-term memories bear on the
 * message?" Rides Agent Memory the same way: memory off means no recall lanes at all.
 */
export function resolveAgentJevMemoryRecallEnabled(agent: unknown): boolean {
  return readSwitch(agent, AGENT_JEV_MEMORY_RECALL_FIELD)
}

/**
 * THE rule for "may Batshit ask Jev, after this agent's reply, whether the reply claims
 * something the turn did not do?" (SA-120 P6). Nothing is ever changed in the reply.
 */
export function resolveAgentJevReplyCheckEnabled(agent: unknown): boolean {
  return readSwitch(agent, AGENT_JEV_REPLY_CHECK_FIELD)
}

/** THE rule for "may Batshit count and judge this agent's repeated wording after a reply?" (SA-120 P6). */
export function resolveAgentJevStyleCoachEnabled(agent: unknown): boolean {
  return readSwitch(agent, AGENT_JEV_STYLE_COACH_FIELD)
}

/**
 * SA-120 P5: the ONE global switch for smart zip (LS-054). It lives on the user's
 * `global_zip_settings` beside the other global zip defaults, because zips are a global
 * posture with per-agent overrides and Josh wants exactly one switch for this.
 */
export const GLOBAL_JEV_SMART_ZIP_FIELD = 'jev_juice_smart_zip' as const
export const GLOBAL_JEV_SMART_ZIP_LABEL = 'Jev Juice: Smart Zip'

/** THE rule for "may Batshit ask Jev which zipped results a message needs?" Absent means OFF. */
export function resolveJevSmartZipEnabled(globalZipSettings: unknown): boolean {
  return readSwitch(globalZipSettings, GLOBAL_JEV_SMART_ZIP_FIELD)
}

/**
 * Write-side validation for `POST /api/user/settings`: a present value must be a boolean.
 * `global_zip_settings` is saved as a whole object, so this is the only gate a typo meets.
 */
export function validateJevJuiceGlobalZipFields(globalZipSettings: unknown): string | null {
  if (!globalZipSettings || typeof globalZipSettings !== 'object' || Array.isArray(globalZipSettings)) return null
  if (!Object.prototype.hasOwnProperty.call(globalZipSettings, GLOBAL_JEV_SMART_ZIP_FIELD)) return null
  const value = (globalZipSettings as Record<string, unknown>)[GLOBAL_JEV_SMART_ZIP_FIELD]
  return typeof value === 'boolean' ? null : `"${GLOBAL_JEV_SMART_ZIP_LABEL}" must be true or false.`
}

/**
 * SA-120 P7: the ONE switch for the incoming-text screen (LS-057). It is a field of the
 * instance record `batshit:typesafe_config`, beside the master switch, because the lane spans
 * agent DMs, wake-up webhooks, and skill imports and no agent, group, or user settings block
 * owns all three. Absent (every record written before P7) means OFF.
 */
export const JEV_INCOMING_TEXT_SCREEN_FIELD = 'screenIncomingText' as const
/** On the Jev Juice card itself, so no "Jev Juice:" prefix (Josh, 2026-09-17): the card is the feature's name. */
export const JEV_INCOMING_TEXT_SCREEN_LABEL = 'Screen Incoming Text'

/** THE rule for "may Batshit show Jev the text of a DM, a webhook message, or an imported skill?" */
export function resolveJevIncomingTextScreenEnabled(typesafeConfig: unknown): boolean {
  return readSwitch(typesafeConfig, JEV_INCOMING_TEXT_SCREEN_FIELD)
}

/**
 * SA-120 P8: the In-Chat Wait Limit (LS-059, DL-120-16), the one Jev Juice setting that is a
 * number the user tunes rather than a switch. A field of `batshit:typesafe_config` beside
 * Per-Attempt Timeout. Default and bounds live with the transport constants
 * (`typesafe.constants.ts`); the server reads it per call (`runTypesafeJudgment`, `lane: 'in_chat'`).
 */
export const JEV_IN_CHAT_WAIT_FIELD = 'inChatWaitMs' as const
export const JEV_IN_CHAT_WAIT_LABEL = 'In-Chat Wait Limit'

/**
 * Write-side validation for the agent create/update routes: a present value must be a
 * boolean or null. The read side treats anything but `true` as OFF, so a bad stored
 * value could never widen anything, but a typo should still be refused loudly.
 */
export function validateJevJuiceAgentFields(input: Record<string, unknown>): string | null {
  for (const [field, label] of Object.entries(AGENT_JEV_JUICE_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue
    const value = input[field]
    if (value === null || typeof value === 'boolean') continue
    return `"${label}" must be true or false.`
  }
  return null
}
