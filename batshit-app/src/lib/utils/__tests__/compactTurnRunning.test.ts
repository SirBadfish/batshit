import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPACT_TURN_RUNNING_RETRY_MS, resolveCompactTurnRunning } from '../compactTurnRunning'

/**
 * BL-622 (C3) review: Auto Compact met the server's `turn_running` refusal at a reply's end (the
 * page counts the chat idle at `end`; the server holds it for the after-reply work), showed it as
 * an error, and never ran again until the token count changed.
 */
describe('the page\'s answer to a turn_running refusal', () => {
  const refusal = { error: 'A reply is running in this chat. Compact runs after it.', code: 'turn_running' }

  it('Auto Compact retries quietly; a pressed Compact tells the user', () => {
    expect(resolveCompactTurnRunning('auto', 409, refusal)).toBe('retry_quietly')
    expect(resolveCompactTurnRunning('manual', 409, refusal)).toBe('tell_user')
  })

  it('a server-only waiting approval also defers Auto Compact and tells a manual caller (BL-711)', () => {
    const waiting = { code: 'approval_pending' }
    expect(resolveCompactTurnRunning('auto', 409, waiting)).toBe('retry_quietly')
    expect(resolveCompactTurnRunning('manual', 409, waiting)).toBe('tell_user')
    expect(resolveCompactTurnRunning('auto', 500, waiting)).toBeNull()
  })

  it('any other answer is not this refusal', () => {
    expect(resolveCompactTurnRunning('auto', 409, { code: 'ended_early' })).toBeNull()
    expect(resolveCompactTurnRunning('auto', 500, refusal)).toBeNull()
    expect(resolveCompactTurnRunning('auto', 409, null)).toBeNull()
  })

  it('the retry waits, rather than asking the server again at once', () => {
    expect(COMPACT_TURN_RUNNING_RETRY_MS).toBeGreaterThanOrEqual(1_000)
  })

  describe('the chat page wires it (source pins, from the line start)', () => {
    const page = readFileSync(path.resolve('src/routes/+page.svelte'), 'utf8')

    it('Auto Compact waits while this tab\'s send is still open (its abort controller lives until turn_over)', () => {
      expect(page).toContain(
        '\n    const busy = Boolean(chatWorkBusy || isWaitingForResponse || isWaitingForToolCall || activeStreamCount > 0 || compactBusy)\n'
      )
    })

    it('both Compact requests route the refusal to the quiet retry or the user', () => {
      const calls = page.split('\n        const turnRunning = resolveCompactTurnRunning(mode, response.status,').length - 1
      expect(calls).toBe(2)
      expect(page).toContain('\n        if (turnRunning) {\n          handleCompactTurnRunning(sessionId, turnRunning, ')
    })

    it('known waiting cards disable manual Compact and stop the idle auto trigger before it records a prompt key', () => {
      const availability = page.slice(page.indexOf('const compactAvailable ='), page.indexOf('const runningCost ='))
      expect(availability).toContain('if (!compactGroupRunnerSession && hasPendingCompactApproval(messages, currentCompactionEvents)) return false')
      expect(availability).toContain('if (!compactGroupRunnerSession && hasPendingCompactApproval(messages, currentCompactionEvents)) return COMPACT_PENDING_APPROVAL_MESSAGE')
      const trigger = page.slice(page.indexOf('const triggerTokens = autoCompactTriggerTokens'), page.indexOf('// SA-104 P6: on opening'))
      expect(trigger.indexOf('if (!compactGroupRunnerSession && hasPendingCompactApproval(messages, currentCompactionEvents)) return')).toBeGreaterThan(0)
      expect(trigger.indexOf('if (!compactGroupRunnerSession && hasPendingCompactApproval(messages, currentCompactionEvents)) return')).toBeLessThan(trigger.indexOf('autoCompactLastPromptKeyBySession ='))
      expect(page).toContain('if (!compactGroupRunnerSession && hasPendingCompactApproval(currentMessages, currentCompactionEvents)) {')
    })

    it('pins all four page guards and the normalized group-runner threshold (source only)', () => {
      expect(page).toContain('const agentIds = Array.isArray(activeGroup?.agent_ids)')
      expect(page).toContain(".map((id) => (typeof id === 'string' ? id.trim() : ''))")
      expect(page).toContain('.filter(Boolean)')
      expect(page).toContain('return new Set(agentIds).size >= 2')
      expect(page.match(/if \(!compactGroupRunnerSession && hasPendingCompactApproval\(/g)).toHaveLength(4)
    })
  })
})
