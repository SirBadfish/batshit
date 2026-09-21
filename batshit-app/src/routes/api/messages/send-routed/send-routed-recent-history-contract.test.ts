import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * send-routed reads the RECENT end of a chat (bug sweep, 2026-09-18).
 *
 * `redis.getMessages(id, n)` is `lRange(key, 0, n - 1)`: the FIRST n messages of a chat
 * (`redisMessageWindows.test.ts` pins both windows against real Redis). send-routed read three
 * 300-message windows with it, and every one meant the newest messages: on a chat longer than
 * 300 messages an approval card was never checked for its three minutes, an approval's saved
 * context was never found, and a context-exhaustion auto-continue compiled its history from the
 * START of the chat instead of the reply that had just run out of room. SA-113 P3 (F-P2-1) fixed
 * the same mistake in four other callers; these pins keep this file off it.
 */
describe('send-routed: every history window is the newest messages', () => {
  it('never reads the start of a chat', () => {
    expect(source).not.toContain('redis.getMessages(')
  })

  it('an approval’s saved context is looked up among the newest messages', () => {
    const start = source.indexOf('async function loadProviderMessagesForApprovalsFromRedis(')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n}\n', start))
    expect(body).toContain('await redis.getRecentMessages(sessionId, 300)')
  })

  it('the three-minute card check reads the newest messages', () => {
    const start = source.indexOf('persistedMessages = await redis.getRecentMessages(sessionId, 300)')
    const analyze = source.indexOf('const approvalState = analyzeApprovalState(approvalHistoryMessages)')
    expect(start).toBeGreaterThan(-1)
    expect(analyze).toBeGreaterThan(start)
  })

  it('a context-exhaustion auto-continue compiles the newest messages', () => {
    const reload = source.indexOf('persistedHistory = await redis.getRecentMessages(sessionId, 300)')
    expect(reload).toBeGreaterThan(-1)
    const rerun = source.indexOf('messages: persistedHistory,', reload)
    expect(rerun).toBeGreaterThan(reload)
  })
})
