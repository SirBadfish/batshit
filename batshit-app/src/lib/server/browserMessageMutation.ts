/** Internal write policy, supplied by the authenticated message routes, never request data. */
export type BrowserMessageMutationPolicy = {
  sessionId: string
  messageId: string
  userId: string
  expectedExists: boolean
}

export class BrowserMessageMutationError extends Error {
  get status(): number {
    return this.code === 'FORBIDDEN' ? 403 : this.code === 'CHANGED_MESSAGE' ? 409 : 404
  }
  constructor(public readonly code: 'MISSING_SESSION' | 'MISSING_MESSAGE' | 'CHANGED_MESSAGE' | 'FORBIDDEN') {
    super(code === 'FORBIDDEN' ? 'Unauthorized: Message ownership changed' :
      code === 'CHANGED_MESSAGE' ? 'Message changed while saving; reload before trying again' :
      code === 'MISSING_SESSION' ? 'Session not found' : 'Message not found')
  }
}

/** BL-1302: preserve only the three server-owned fields, never arbitrary stored metadata. */
export function preserveServerSteerMetadata(incoming: unknown, stored: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = incoming && typeof incoming === 'object' && !Array.isArray(incoming)
    ? { ...incoming } : {}
  const prior = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : {}
  for (const key of ['steerPromoted', 'waitsForApproval', 'approvalCardExpired']) {
    delete result[key]
    if (Object.prototype.hasOwnProperty.call(prior, key)) result[key] = prior[key]
  }
  return result
}

/** The fake lane's twin of the Lua identity gate; actual Redis atomicity has separate proof. */
export function assertBrowserMessageMutation(
  policy: BrowserMessageMutationPolicy,
  session: any,
  current: any,
  incoming: any
): void {
  if (!session) throw new BrowserMessageMutationError('MISSING_SESSION')
  if (session.user_id !== policy.userId) throw new BrowserMessageMutationError('FORBIDDEN')
  if (Boolean(current) !== policy.expectedExists) {
    throw new BrowserMessageMutationError(current ? 'CHANGED_MESSAGE' : 'MISSING_MESSAGE')
  }
  const owned = (record: any) => record && record.id === policy.messageId &&
    record.session_id === policy.sessionId && record.user_id === policy.userId && record.role === 'user'
  if (!owned(incoming) || (current && !owned(current))) throw new BrowserMessageMutationError('FORBIDDEN')
}
