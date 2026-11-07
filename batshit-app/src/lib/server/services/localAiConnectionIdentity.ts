import { createHmac, randomBytes } from 'node:crypto'

// Existing process-local management identity, shared with request-local reasoning validation.
// Never persist/return this secret or offer an offline verifier for the saved credential.
const connectionIdentitySecret = randomBytes(32)
export function localAiConnectionKey(userId: string, programId: string, ctx: { baseUrl: string; apiKey: string | null }): string {
  return createHmac('sha256', connectionIdentitySecret)
    .update(JSON.stringify([userId, programId, ctx.baseUrl, ctx.apiKey])).digest('hex')
}
