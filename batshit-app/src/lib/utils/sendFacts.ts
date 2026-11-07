/**
 * BL-455 review (D1) — the facts of the send a turn belongs to, which a later run of its words must
 * run with. Client-safe: the server's follow-up turns and the page's Send now of a kept send read
 * the same list (BL-903 a).
 *
 * A follow-up in the request of an approval CLICK cannot take them from the request: a click posts
 * the paused REPLY's metadata (the card's message), which has no project, no voice mode, and no
 * tool choice. So every user message the server writes (a promoted or a held one) carries them at
 * the top of its metadata, as the page's own messages carry `projectPath`, `stt` and `tts`, and a
 * click recovers them from the user message of the turn that raised the card (`findPausedApprovalTurn`,
 * as the resume itself does for its project). A NEW send fact that a follow-up must keep is added
 * here; anything not named here does not follow the words.
 */
export const SEND_FACT_KEYS = [
  'projectPath',
  'projectRules',
  // Not `stt`: that says THIS message was spoken, and the words that wait were typed.
  'tts',
  'voiceMode',
  'realtime',
  'goonsEnabled',
  'goonPresentationMode',
  'selectedTools',
  'selectedGateways',
  'selectedMCPs',
  'mcpToolSelections',
  'toolApprovalMode',
  'claudePermissionMode',
] as const

export function pickSendFacts(metadata: unknown): Record<string, unknown> {
  const source = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {}
  const facts: Record<string, unknown> = {}
  for (const key of SEND_FACT_KEYS) {
    if (source[key] !== undefined && source[key] !== null) facts[key] = source[key]
  }
  // The page stores `voiceMode` on its own user message as a boolean (`tts || false`); a send and a
  // run read it as 'voice' or 'text'.
  if ('voiceMode' in facts && typeof facts.voiceMode !== 'string') {
    facts.voiceMode = facts.voiceMode === true || facts.tts === true ? 'voice' : 'text'
  }
  return facts
}

/**
 * What describes one message itself, which a Send now of that same message sends again with the
 * send facts: it was spoken, its Clips, its `@file` references, its skill. The page saves these on
 * its own message.
 */
export const MESSAGE_FACT_KEYS = ['stt', 'clipIds', 'fileReferences', 'skillInvocation'] as const
