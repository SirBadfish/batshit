import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/services/api', () => ({
  api: { getZip: vi.fn(async () => null), getZips: vi.fn(async () => new Map()) }
}))
vi.mock('$lib/services/zipping', () => ({
  zippingService: { isUnzipped: vi.fn(() => false), isRezipped: vi.fn(() => false) }
}))

import { compileForAI } from '$lib/services/messageCompiler'
import { buildSteerPlaceholder, type DeliveredSteer } from '$lib/utils/steerControl'
import { segmentCompiledUserMessage } from '$lib/server/services/cacheForensics/compiledMessageSegments'
import { compiledConversation, compiledElement } from '$lib/utils/compiledChatTags'
import { analyzeHistoryStability } from '$lib/server/services/cacheForensics/divergence'
import {
  fingerprintSegments,
  resolveCacheForensicsKey
} from '$lib/server/services/cacheForensics/fingerprint'

/**
 * SA-114 P1 (DL-114-04) — why a steer lives INSIDE the assistant record.
 *
 * The assistant record is written once, at finalise, so a steer stored in it is part of a
 * history message that never changes again: every later send compiles the same bytes and
 * the provider's prefix cache keeps working. The second test shows the shape the story
 * rejected — a separate user record at the position the steer arrived, which lands BETWEEN
 * two messages that already exist and reads as `reordered`, not `append-only`.
 */

const steer: DeliveredSteer = {
  steerId: 'steer_abc',
  messageId: 'msg_a2',
  text: 'also run the tests',
  at: '2026-09-10T12:00:00.000Z',
  source: 'user',
  step: 1,
  lane: 'api'
}

const U1 = compiledElement('user', 'first question', [['time', 'September 10, 2026 at 9:14 AM']])
const A1 = compiledElement('assistant', 'first answer')
const U2 = compiledElement('user', 'do the thing')
const U3 = 'third question'
const A3 = compiledElement('assistant', 'third answer')

/** The assistant reply that carried the steer, exactly as it is stored. */
const A2_STORED = `Assistant: starting.\n\n${buildSteerPlaceholder('steer_abc')}\n\nDone, and the tests pass.`

async function compileA2() {
  return compileForAI(A2_STORED, 0, 1, {}, { id: 'msg_a2', metadata: { steers: [steer] } }, {})
}

/**
 * The shape the real compiler emits (SA-128): one user message, the history elements in
 * `<conversation>` in array order, then the new message. A compiled reply goes into its
 * `<assistant>` element exactly as the compiler wraps it.
 */
function compiledUserMessage(history: string[], current: string): string {
  const elements = history.map((entry) => (entry.startsWith('<') ? entry : compiledElement('assistant', entry)))
  return [compiledConversation(elements), compiledElement('user', current, [['time', '9:30 AM']])].join('\n\n')
}

function fingerprint(history: string[], current: string) {
  const key = resolveCacheForensicsKey()
  const segments = segmentCompiledUserMessage(compiledUserMessage(history, current), '#user')
  if (!segments) throw new Error('the compiled message did not split')
  return fingerprintSegments(key, segments).segments
}

describe('a steered turn keeps history append-only (DL-114-04)', () => {
  it('compiles the steered reply to the same bytes on every later send', async () => {
    const a2 = await compileA2()
    expect(a2).toContain('[The user said, mid-reply: also run the tests]')

    const turnThree = fingerprint([U1, A1, U2, a2], U3)
    const turnFour = fingerprint([U1, A1, U2, a2, compiledElement('user', U3), A3], 'fourth question')

    expect(analyzeHistoryStability(turnFour, turnThree)).toMatchObject({
      state: 'append-only',
      baselineSegments: 4,
      currentSegments: 6
    })

    // And the steered message itself is byte-identical in both runs, which is the
    // property the provider's prefix cache actually depends on.
    expect(turnFour[3].hmac).toBe(turnThree[3].hmac)
  })

  it('the rejected shape — a separate record at the steer’s position — reads as reordered', async () => {
    const a2 = await compileA2()
    const baseline = fingerprint([U1, A1, U2, a2], U3)

    // A mid-turn user record compiles BEFORE the reply it interrupted (Part 2.3), so it
    // lands between two history messages that already exist.
    const withInsertedRecord = fingerprint(
      [U1, A1, U2, compiledElement('user', 'also run the tests'), a2],
      U3
    )

    const verdict = analyzeHistoryStability(withInsertedRecord, baseline)
    expect(verdict.state).toBe('reordered')
    expect(verdict.state).not.toBe('append-only')
    expect(verdict.firstChangedIndex).toBe(3)
  })
})
