import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  holdAutoCompactAfterStop,
  isAutoCompactHeldAfterStop,
  releaseAutoCompactHoldOnReplyEnd,
  isStoppedCompactAnswer,
  resolveStopTarget
} from '../compactStopTarget'

/** BL-622 (C7), BL-653: the chat's Stop during a Compact ends the Compact. */
describe('what the chat\'s Stop stops', () => {
  it('a Compact alone: the Compact; a reply (with or without a Compact): the reply', () => {
    expect(resolveStopTarget({ compactBusy: true, replyBusy: false })).toBe('compact')
    expect(resolveStopTarget({ compactBusy: false, replyBusy: true })).toBe('reply')
    expect(resolveStopTarget({ compactBusy: true, replyBusy: true })).toBe('reply')
    expect(resolveStopTarget({ compactBusy: false, replyBusy: false })).toBe('reply')
  })

  it('a stopped Compact\'s answer is recognized, and nothing else is', () => {
    expect(isStoppedCompactAnswer(409, { code: 'ended_early', reason: 'stopped' })).toBe(true)
    expect(isStoppedCompactAnswer(409, { code: 'ended_early', reason: 'session_deleted' })).toBe(true)
    expect(isStoppedCompactAnswer(409, { code: 'ended_early', reason: 'compaction_changed' })).toBe(false)
    expect(isStoppedCompactAnswer(500, { code: 'ended_early', reason: 'stopped' })).toBe(false)
    expect(isStoppedCompactAnswer(409, null)).toBe(false)
  })

  describe('a stopped Auto Compact waits for the next reply (BL-653)', () => {
    it('holds only after an Auto Compact, per chat, until a reply of that chat ends', () => {
      let holds = holdAutoCompactAfterStop({}, 'chat-a', 'manual')
      expect(isAutoCompactHeldAfterStop(holds, 'chat-a')).toBe(false)
      holds = holdAutoCompactAfterStop(holds, 'chat-a', 'auto')
      expect(isAutoCompactHeldAfterStop(holds, 'chat-a')).toBe(true)
      expect(isAutoCompactHeldAfterStop(holds, 'chat-b')).toBe(false)
      holds = releaseAutoCompactHoldOnReplyEnd(holds, 'chat-b')
      expect(isAutoCompactHeldAfterStop(holds, 'chat-a')).toBe(true)
      holds = releaseAutoCompactHoldOnReplyEnd(holds, 'chat-a')
      expect(isAutoCompactHeldAfterStop(holds, 'chat-a')).toBe(false)
    })
  })

  describe('the chat page wires it (source pins, from the line start)', () => {
    const page = readFileSync(path.resolve('src/routes/+page.svelte'), 'utf8')

    it('the composer\'s Stop goes through handleStopWork', () => {
      expect(page).toContain('\n            onStopWork={handleStopWork}\n')
      expect(page).not.toContain('onStopWork={handleStopStream}')
    })

    it('handleStopWork asks the rule and calls the Compact\'s Stop route for a Compact', () => {
      expect(page).toContain(
        "\n    if (resolveStopTarget({ compactBusy, replyBusy: chatWorkBusy }) === 'compact') {\n      void stopRunningCompact()\n"
      )
      expect(page).toContain("\n      const response = await fetch('/api/messages/compact/stop', {\n")
    })

    // BL-781: the Stop shows only for the chat on screen's own Compact, so it ends that one.
    it('the Stop ends the Compact of the chat on screen, and only while one of its requests runs', () => {
      const stop = page.slice(page.indexOf('\n  async function stopRunningCompact() {'))
      const body = stop.slice(0, stop.indexOf('\n  }\n'))
      expect(body).toContain(
        '\n    const sessionId = currentSessionId\n    const compactId = sessionId ? compactRuns.compactIdOf(sessionId) : null\n    if (!sessionId || !compactId || !compactRuns.requestStop(sessionId)) return\n'
      )
      // BL-795: the Stop names the Compact it was pressed for.
      expect(body).toContain('body: JSON.stringify({ sessionId, compactId })')
    })

    it('the composer and the Token Panel read the chat on screen\'s Compact (BL-781)', () => {
      expect(page).toContain('\n  const compactBusy = $derived(compactRuns.isBusy(currentSessionId))\n')
      expect(page).toContain('\n  const compactStatus = $derived(compactRuns.statusOf(currentSessionId))\n')
      expect(page).not.toMatch(/\n\s*compactBusy = (true|false)\n/)
    })

    it('a Compact holds its chat from start to end, the confirm dialog included (BL-781)', () => {
      const compact = page.slice(page.indexOf('\n  async function handleCompact('))
      const body = compact.slice(0, compact.indexOf('\n  }\n'))
      expect(body).toContain(
        '\n    const compactId = compactRuns.begin(sessionId)\n    if (!compactId) return\n    try {\n      await runCompact(sessionId, compactId, currentAgent, options.mode ?? \'manual\', options.confirmFirst ?? true)\n    } finally {\n      compactRuns.end(sessionId)\n    }'
      )
    })

    it('both requests make their own chat busy and leave it in their finally', () => {
      const compact = page.slice(page.indexOf('\n  async function runCompact('))
      const body = compact.slice(0, compact.indexOf('\n  }\n'))
      expect(body.split('\n    compactRuns.enterPhase(sessionId, ')).toHaveLength(3)
      expect(body.split('\n      compactRuns.leavePhase(sessionId)\n')).toHaveLength(3)
      // BL-795: both requests carry the Compact's id, so a Stop pressed for it before it
      // registered waits for it alone.
      expect(body.split('\n          sessionId,\n          compactId,\n')).toHaveLength(3)
    })

    it('the Compact reads its chat by id, never the chat on screen after it started (BL-781)', () => {
      const compact = page.slice(page.indexOf('\n  async function runCompact('))
      const body = compact.slice(0, compact.indexOf('\n  }\n'))
      expect(body).toContain('const currentMessages = messageStore.getMessages(sessionId)')
      expect(body).not.toContain('currentTrimmedMessageIds,')
      expect(body).not.toContain('sessionStore.getCurrentSession()')
      expect(body).not.toContain('setTrimmedIdsForCurrentSession(')
      expect(body).toContain('setTrimmedIdsForSession(sessionId, nextTrimmedIds)')
    })

    it('a Stop during the plan ends the Compact before the summary request starts', () => {
      const compact = page.slice(page.indexOf('\n  async function runCompact('))
      const stopCheck = compact.indexOf(
        '\n      if (compactRuns.stopRequested(sessionId)) {\n        autoCompactStopHolds = holdAutoCompactAfterStop(autoCompactStopHolds, sessionId, mode)\n        toast.info(STOPPED_COMPACT_MESSAGE)\n        return\n      }\n'
      )
      const secondRequest = compact.indexOf("compactRuns.enterPhase(sessionId, 'Generating compact summary...')")
      expect(stopCheck).toBeGreaterThan(-1)
      expect(stopCheck).toBeLessThan(secondRequest)
    })

    it('the Auto Compact trigger reads the hold before its key; both stop paths set it', () => {
      const trigger = page.slice(page.indexOf('\n    const promptKey = [') - 1500, page.indexOf('\n    const promptKey = ['))
      expect(trigger).toContain('\n    if (isAutoCompactHeldAfterStop(autoCompactStopHolds, sessionId)) return\n')
      const compact = page.slice(page.indexOf('\n  async function runCompact('))
      const body = compact.slice(0, compact.indexOf('\n  }\n'))
      expect(body.split('autoCompactStopHolds = holdAutoCompactAfterStop(autoCompactStopHolds, sessionId, mode)')).toHaveLength(3)
    })

    it('a reply\'s end releases the hold of its chat (and the reconnect catch-up, which stands in for one)', () => {
      const end = page.slice(page.indexOf("\n    } else if (data.type === 'end') {"))
      const endBody = end.slice(0, end.indexOf('\n      clearThinkingIndicator(targetMessageId)'))
      expect(endBody).toContain(
        '\n      autoCompactStopHolds = releaseAutoCompactHoldOnReplyEnd(autoCompactStopHolds, currentMessage.session_id)\n'
      )
      // The only other release is the reconnect catch-up, which stands in for an `end` the tab
      // never heard (BL-382); a token update never releases it.
      expect(page.split('releaseAutoCompactHoldOnReplyEnd(')).toHaveLength(3)
      const catchUp = page.slice(page.indexOf('\n  async function catchUpAfterReconnect('))
      expect(catchUp.slice(0, catchUp.indexOf('\n  }\n'))).toContain('releaseAutoCompactHoldOnReplyEnd(')
    })

    it('the Compact request shows a stopped Compact as information', () => {
      expect(page).toContain(
        '\n        if (isStoppedCompactAnswer(response.status, payload)) {\n          autoCompactStopHolds = holdAutoCompactAfterStop(autoCompactStopHolds, sessionId, mode)\n          toast.info('
      )
    })
  })
})
