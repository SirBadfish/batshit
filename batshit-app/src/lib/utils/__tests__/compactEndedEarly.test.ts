import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCompactEndedEarly } from '../compactEndedEarly'

/**
 * BL-622 (C5): a Compact that ended early after its summary call (409 `ended_early`) wrote nothing.
 * A pressed Compact tells the user why in one sentence; an Auto Compact says nothing and runs again.
 *
 * BL-755/BL-756 review: `compaction_changed` needs a metadata refresh before its retry (this tab's
 * copy of the chat's record is now behind the Compact that won). A Compact the chat's Stop ended
 * (`stopped`) is not this module's: the page reads it first (`compactStopTarget.ts`).
 */
describe('the page\'s answer to a Compact that ended early', () => {
  const endedEarly = (reason: string) => ({ error: 'server words', code: 'ended_early', reason })

  it('a pressed Compact that met a new reply says exactly what to do', () => {
    expect(resolveCompactEndedEarly('manual', 409, endedEarly('turn_started'))).toEqual({
      kind: 'tell_user',
      reason: 'turn_started',
      message: 'Compact stopped: you sent a message. Press Compact again after the reply.'
    })
  })

  it('the other early ends get a short true sentence in the same style', () => {
    expect(resolveCompactEndedEarly('manual', 409, endedEarly('compaction_changed'))).toMatchObject({
      kind: 'tell_user',
      message: 'Compact stopped: another Compact finished in this chat first.'
    })
    expect(resolveCompactEndedEarly('manual', 409, endedEarly('message_protected'))).toMatchObject({
      kind: 'tell_user',
      message: 'Compact stopped: a message it summarized is now protected. Press Compact again to leave it out.'
    })
  })

  it('an Auto Compact says nothing and retries, for the ends that can run again', () => {
    for (const reason of ['turn_started', 'message_protected']) {
      expect(resolveCompactEndedEarly('auto', 409, endedEarly(reason))).toEqual({
        kind: 'retry_quietly',
        reason,
        refreshMetadata: false
      })
    }
  })

  it('BL-755: an Auto Compact retry after compaction_changed asks for a metadata refresh first', () => {
    expect(resolveCompactEndedEarly('auto', 409, endedEarly('compaction_changed'))).toEqual({
      kind: 'retry_quietly',
      reason: 'compaction_changed',
      refreshMetadata: true
    })
  })

  it('a Compact the Stop ended is not this module\'s (the page reads it first)', () => {
    expect(resolveCompactEndedEarly('manual', 409, endedEarly('stopped'))).toBeNull()
    expect(resolveCompactEndedEarly('auto', 409, endedEarly('stopped'))).toBeNull()
  })

  it('a start refusal and other answers are not this', () => {
    expect(resolveCompactEndedEarly('manual', 409, { code: 'turn_running' })).toBeNull()
    expect(resolveCompactEndedEarly('manual', 500, endedEarly('turn_started'))).toBeNull()
    expect(resolveCompactEndedEarly('manual', 409, null)).toBeNull()
  })

  describe('the chat page wires it (source pins, from the line start)', () => {
    const page = readFileSync(path.resolve('src/routes/+page.svelte'), 'utf8')

    it('the Compact request routes an early end to the user, a refreshed retry, or nothing', () => {
      expect(page).toContain(
        '\n        const endedEarly = resolveCompactEndedEarly(mode, response.status, payload)\n' +
          '        if (endedEarly) {\n' +
          "          if (endedEarly.kind === 'tell_user') toast.info(endedEarly.message)\n" +
          "          else if (endedEarly.kind === 'retry_quietly') {\n" +
          '            if (endedEarly.refreshMetadata) void refreshSessionMetadataAfterCompactionChanged(sessionId)\n' +
          "            handleCompactTurnRunning(sessionId, 'retry_quietly', payload)\n" +
          '          }\n' +
          '          return\n' +
          '        }\n'
      )
    })
  })
})
