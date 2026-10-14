// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'
import {
  CONCRETE_ZIP_ID,
  REFERENCE_SCAN_HAND_CASES,
  generateReferenceScanTexts
} from '$lib/test-utils/referenceScanTexts'
import { CONTROL_TAGS, findControlBlocks, removeControlBlocks } from '$lib/utils/controlTags'
import { stripZipControlBlocks } from '$lib/utils/zipControl'
import { POST_TURN_CHECK_LIMITS } from '../../postTurnCheck.jev'
import { collectEarlierToolLabels, replyProseForJudgment } from '../jevJuiceTurn'

/**
 * BL-707: Judge Juice reads a finished reply as prose (each zip reference becomes the tool result
 * it stands for) and reads the tool labels of earlier replies from their zip references. Both ran
 * a whole-text pattern whose description part searched to the first `}` again from every opener:
 * seconds of the one Node process after a reply of openers that never close. Each is one scan
 * now, with its own rules.
 */

/** The two readers as they were, with their literal patterns, kept here only as oracles. */
const RENDER_HIDDEN_TAG_IDS = new Set(CONTROL_TAGS.filter((spec) => spec.hideFromRender).map((spec) => spec.id))
function oldReplyProseForJudgment(raw: string): string {
  const stripped = stripZipControlBlocks(typeof raw === 'string' ? raw : '')
  const hidden = findControlBlocks(stripped, { final: true }).filter((block) => RENDER_HIDDEN_TAG_IDS.has(block.id))
  return removeControlBlocks(stripped, hidden)
    .replace(/\{\{batshit-zip:[^:}]+(?::::([^}]*))?\}\}/g, (_match, description: string | undefined) =>
      description && description.trim() ? `[tool result: ${description.trim()}]` : '[tool result]'
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const OLD_ZIP_REFERENCE_DESCRIPTION = /\{\{batshit-zip:[^:}]+:::([^}]*)\}\}/g
function oldCollectEarlierToolLabels(history: Array<{ role: string; content: unknown }>): string[] {
  const labels: string[] = []
  for (const message of history) {
    if (message.role !== 'assistant') continue
    const text = typeof message.content === 'string' ? message.content : ''
    for (const match of text.matchAll(OLD_ZIP_REFERENCE_DESCRIPTION)) {
      const label = (match[1] ?? '').trim()
      if (label && !labels.includes(label)) labels.push(label)
    }
  }
  return labels.slice(-POST_TURN_CHECK_LIMITS.maxEarlierToolLabels)
}

const assistant = (content: string) => ({ role: 'assistant' as const, content })

describe('Judge Juice reads zip references once (BL-707)', () => {
  const texts = [...REFERENCE_SCAN_HAND_CASES, ...generateReferenceScanTexts(5_000, 2_707)]

  it('reads a reply as the same prose the old pattern made', () => {
    let changed = 0
    for (const text of texts) {
      const prose = oldReplyProseForJudgment(text)
      expect(replyProseForJudgment(text), JSON.stringify(text)).toBe(prose)
      if (prose.includes('[tool result')) changed++
    }
    expect(changed).toBeGreaterThan(1_000)
  })

  it('reads the same earlier tool labels, one reply at a time and across a history', () => {
    let labelled = 0
    for (const text of texts) {
      const labels = oldCollectEarlierToolLabels([assistant(text)])
      expect(collectEarlierToolLabels([assistant(text)] as any), JSON.stringify(text)).toEqual(labels)
      if (labels.length > 0) labelled++
    }
    expect(labelled).toBeGreaterThan(500)
    for (let from = 0; from < texts.length; from += 50) {
      const history = texts.slice(from, from + 50).map((content, index) =>
        index % 7 === 3 ? { role: 'user', content } : assistant(content)
      )
      expect(collectEarlierToolLabels(history as any)).toEqual(oldCollectEarlierToolLabels(history))
    }
  })

  it('reads a 1 MB reply of 20,000 unclosed openers in well under 200 ms', () => {
    for (const [shape, reply] of Object.entries(unclosedReferenceReplies('zip'))) {
      let started = performance.now()
      expect(replyProseForJudgment(reply), shape).toBe(reply.trim())
      expect(performance.now() - started, `prose, ${shape}`).toBeLessThan(200)
      started = performance.now()
      expect(collectEarlierToolLabels([assistant(reply)] as any), shape).toEqual([])
      expect(performance.now() - started, `labels, ${shape}`).toBeLessThan(200)
    }
  })

  it('still turns a reference into its tool result and reads its label', () => {
    const reply = `Done.\n{{batshit-zip:${CONCRETE_ZIP_ID}:::Tool execution: read}}\n{{batshit-zip:${CONCRETE_ZIP_ID}}}`
    expect(replyProseForJudgment(reply)).toBe('Done.\n[tool result: Tool execution: read]\n[tool result]')
    expect(collectEarlierToolLabels([assistant(reply)] as any)).toEqual(['Tool execution: read'])
  })
})
