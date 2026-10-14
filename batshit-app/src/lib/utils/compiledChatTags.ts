/**
 * SA-128: the tag grammar of Batshit's one compiled user message.
 *
 * The compiler (`databaseRedis.server.ts`) sends the whole chat as ONE user message, so these
 * tags are the only thing that tells the model where a message starts and ends and who wrote
 * it. Every message sits in its own element:
 *
 * - `<user>`: the human.
 * - `<assistant>`: the agent this compile is FOR (its own earlier replies).
 * - `<agent name="…">`: any other agent, by its current display name.
 * - `<note>`: Batshit's own entry (a Compact summary, a woken turn's DM, a group follow-up).
 *
 * History sits inside `<conversation>`, the new message follows it, and the other sections of
 * the message (`<dynamic_info>`, `<zip_index>`, `<awareness_media>`, `<clipped_items>`,
 * `<remembered_media>`) are one element each.
 *
 * DL-05: content never carries a live tag of this grammar. `disarmCompiledTags` rewrites the
 * `<` of any of these tag names inside content to `&lt;`, the same way every time, so a pasted
 * page or a model's reply cannot fake a turn. Nothing else in the content changes. Because of
 * that, a reader can split the compiled text on these tags exactly (cache forensics does).
 */

export const COMPILED_TAG = {
  conversation: 'conversation',
  user: 'user',
  assistant: 'assistant',
  agent: 'agent',
  note: 'note',
  dynamicInfo: 'dynamic_info',
  zipIndex: 'zip_index',
  awarenessMedia: 'awareness_media',
  clippedItems: 'clipped_items',
  rememberedMedia: 'remembered_media'
} as const

export type CompiledTagName = (typeof COMPILED_TAG)[keyof typeof COMPILED_TAG]

/** The four elements a message can be. */
export type CompiledMessageTag = 'user' | 'assistant' | 'agent' | 'note'

export const COMPILED_TAG_NAMES: readonly CompiledTagName[] = Object.values(COMPILED_TAG)

export const COMPILED_MESSAGE_TAGS: readonly CompiledMessageTag[] = [
  COMPILED_TAG.user,
  COMPILED_TAG.assistant,
  COMPILED_TAG.agent,
  COMPILED_TAG.note
]

/**
 * SA-128 (DL-02): who a compiled history is FOR, and the current display name of every other
 * agent in it. That agent's own replies are `<assistant>`; any other agent's are
 * `<agent name="…">`. The compiler builds one per compile (`buildSpeakerView`); a Compact or
 * graduation transcript gets one from `resolveCompiledSpeakerView` (BL-224). A `null` self names
 * every agent that has an id: a group chat's shared summary is for no one agent.
 */
export interface CompiledSpeakerView {
  selfAgentId: string | null
  agentNames: ReadonlyMap<string, string>
}

/** The agent a stored reply came from, as the compiler reads it: `agent_id`, `agentId`, or `metadata.agentId`. */
export function resolveCompiledMessageAgentId(message: unknown): string | null {
  const record = (message ?? {}) as Record<string, any>
  const candidate = record.agent_id || record.agentId || record.metadata?.agentId
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
}

/**
 * SA-128 (DL-01, DL-02, DP-1, DP-4): the element a history message is. `<user>` is only the human
 * (a user-role message Batshit wrote is a `<note>`, like every system entry); a reply is
 * `<assistant>` when it is the view's own agent or carries no agent id, else `<agent name>`.
 * The same rule as the compiler's `resolveMessageElement`, pinned equal by
 * `compiledSpeakerView.test.ts`.
 */
export function resolveCompiledMessageElement(
  message: { role?: unknown; metadata?: unknown },
  speakers: CompiledSpeakerView
): { tag: CompiledMessageTag; name: string | null } {
  if (message.role === 'user') {
    return { tag: isBatshitWrittenUserMessage(message.metadata) ? COMPILED_TAG.note : COMPILED_TAG.user, name: null }
  }
  if (message.role === 'assistant') {
    const agentId = resolveCompiledMessageAgentId(message)
    if (!agentId || agentId === speakers.selfAgentId) return { tag: COMPILED_TAG.assistant, name: null }
    return { tag: COMPILED_TAG.agent, name: speakers.agentNames.get(agentId) ?? agentId }
  }
  return { tag: COMPILED_TAG.note, name: null }
}

/** Who wrote the current message: the human, or Batshit (a woken turn, a group follow-up, …). */
export type CurrentMessageFrom = 'user' | 'batshit'

/**
 * DP-1: a stored user-role message Batshit wrote for someone else: a woken turn (an agent's DM,
 * a webhook, a schedule; the wake primitive stamps `metadata.wake` on the message it stores)
 * or an artifact share an agent or artifact started. It compiles as a `<note>`, never as the user.
 */
export function isBatshitWrittenUserMessage(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false
  const record = metadata as Record<string, unknown>
  return Boolean(record.wake) || (record.source === 'artifact_share' &&
    (record.shareInitiator === 'agent' || record.shareInitiator === 'artifact'))
}

// A fresh expression per call: a shared `/g` instance carries `lastIndex` between calls.
function grammarTagPattern(): RegExp {
  return new RegExp(`<(?=/?(?:${COMPILED_TAG_NAMES.join('|')})(?=[\\s/>]|$))`, 'gi')
}

/** Rewrites the `<` of every tag of this grammar inside `text` to `&lt;`. */
export function disarmCompiledTags(text: string): string {
  return text.replace(grammarTagPattern(), '&lt;')
}

/** An attribute value on one line, with the characters that could end or reopen a tag escaped. */
export function escapeCompiledTagAttribute(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** The opening tag, attributes in the order given; empty values are left out. */
export function compiledOpenTag(tag: CompiledTagName, attributes: Array<[string, string | null | undefined]> = []): string {
  const rendered = attributes
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(([name, value]) => ` ${name}="${escapeCompiledTagAttribute(value)}"`)
    .join('')
  return `<${tag}${rendered}>`
}

/**
 * One element: the opening tag on its own line, the disarmed body, the closing tag on its own
 * line. The body is otherwise verbatim (no trimming), so a message's bytes never depend on
 * anything but its own content and attributes.
 */
export function compiledElement(
  tag: CompiledTagName,
  body: string,
  attributes: Array<[string, string | null | undefined]> = []
): string {
  return `${compiledOpenTag(tag, attributes)}\n${disarmCompiledTags(body)}\n</${tag}>`
}

/**
 * The history section: formatted message elements, one blank line apart, inside
 * `<conversation>`. No messages, no section.
 */
export function compiledConversation(formattedMessages: string[]): string {
  if (formattedMessages.length === 0) return ''
  return `<${COMPILED_TAG.conversation}>\n${formattedMessages.join('\n\n')}\n</${COMPILED_TAG.conversation}>`
}
