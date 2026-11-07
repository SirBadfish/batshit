/** Browser broadcasts are user-message facts, never reply producer events (BL-2002). */
export type BrowserUserMessageEvent = {
  type: 'user_message'
  sessionId: string
  message: {
    id: string
    content: string
    role: 'user'
    session_id: string
    user_id: string
    status: 'complete'
    agent_id?: string
    created_at?: string
    timestamp?: string
    metadata?: Record<string, unknown>
  }
}

type Projection =
  | { ok: true; event: BrowserUserMessageEvent }
  | { ok: false; status: 400 | 403; error: string }

const EVENT_FIELDS = new Set(['type', 'sessionId', 'message'])
const MESSAGE_FIELDS = new Set([
  'id', 'content', 'role', 'session_id', 'user_id', 'status', 'agent_id',
  'created_at', 'timestamp', 'metadata'
])
// The two page producers send these user facts. Server steer/approval/reply fields are absent.
const METADATA_FIELDS = new Set([
  'client_sent', 'error_message', 'hasAttachments', 'attachmentCount', 'stt', 'tts',
  'voiceMode', 'fileReferences', 'clipIds', 'projectPath', 'subagentSnapshot',
  'skillInvocation', 'interruption', 'quickAction', 'zipIds'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key))
}

export function projectBrowserUserMessageEvent(
  input: unknown,
  owner: { sessionId: string; userId: string }
): Projection {
  if (!isRecord(input) || input.type !== 'user_message') {
    return { ok: false, status: 403, error: 'Browsers may broadcast only user_message events.' }
  }
  if (!hasOnlyFields(input, EVENT_FIELDS) || input.sessionId !== owner.sessionId || !isRecord(input.message)) {
    return { ok: false, status: 400, error: 'Invalid browser user message event.' }
  }
  const message = input.message
  if (!hasOnlyFields(message, MESSAGE_FIELDS) ||
      typeof message.id !== 'string' || !message.id.trim() ||
      typeof message.content !== 'string' ||
      (message.status !== undefined && message.status !== 'complete') ||
      ['agent_id', 'created_at', 'timestamp'].some((key) =>
        message[key] !== undefined && typeof message[key] !== 'string')) {
    return { ok: false, status: 400, error: 'Invalid browser user message.' }
  }
  if (message.role !== 'user' || message.session_id !== owner.sessionId || message.user_id !== owner.userId) {
    return { ok: false, status: 403, error: 'Browser user message identity does not match its owner.' }
  }
  let metadata: Record<string, unknown> | undefined
  if (message.metadata !== undefined) {
    if (!isRecord(message.metadata) || !hasOnlyFields(message.metadata, METADATA_FIELDS)) {
      return { ok: false, status: 400, error: 'Invalid browser user message metadata.' }
    }
    metadata = Object.fromEntries(Object.entries(message.metadata))
  }
  // No caller-controlled spread can replace envelope, role, session or user identity.
  const event: BrowserUserMessageEvent = {
    type: 'user_message',
    sessionId: owner.sessionId,
    message: {
      id: message.id,
      content: message.content,
      role: 'user',
      session_id: owner.sessionId,
      user_id: owner.userId,
      status: 'complete'
    }
  }
  if (typeof message.agent_id === 'string') event.message.agent_id = message.agent_id
  if (typeof message.created_at === 'string') event.message.created_at = message.created_at
  if (typeof message.timestamp === 'string') event.message.timestamp = message.timestamp
  if (metadata) event.message.metadata = metadata
  return { ok: true, event }
}
