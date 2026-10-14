// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'
import {
  CONCRETE_ZIP_ID,
  REFERENCE_SCAN_HAND_CASES,
  generateReferenceScanTexts
} from '$lib/test-utils/referenceScanTexts'

/**
 * BL-707: the reply-end step (`finalizeReplyControl`) hands the parked zip actions the reply's
 * current tool zips: its own zip ids plus every `cool_tool_` id its words reference. That read
 * ran `/\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/g` over the whole reply, whose description part
 * searched to the first `}` again from every opener: seconds of the one Node process at the reply
 * end for a reply of openers that never close. It is one scan now, with the same rules.
 */

const seen = vi.hoisted(() => ({ currentToolZipIds: [] as string[][] }))
vi.mock('$lib/server/services/zipHolds', () => ({
  applyAgentHoldChanges: vi.fn(async () => ({ held: [], released: [], moved: [], errors: [] })),
  applyLegacyAgentZipActions: vi.fn(async (input: { currentToolZipIds: string[] }) => {
    seen.currentToolZipIds.push(input.currentToolZipIds)
    return { unzipped: [], zipped: [], errors: [] }
  }),
  advanceZipCountdowns: vi.fn(async () => ({ counted: [], ended: [] }))
}))
vi.mock('$lib/server/services/memory/memoryTools', () => ({
  processInlineMemorySaves: vi.fn(async () => [])
}))

import { finalizeReplyControl } from '../replyControlFinalize'

/** The reader as it was, with its literal pattern, kept here only as the oracle. */
const OLD_ZIP_REFERENCE_PATTERN = /\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/g
function oldCurrentToolZipIds(replyZipIds: string[], content: string): string[] {
  const ids: string[] = []
  const add = (value: string | undefined) => {
    const id = typeof value === 'string' ? value.trim() : ''
    if (id && id.toLowerCase().startsWith('cool_tool_') && !ids.includes(id)) ids.push(id)
  }
  replyZipIds.forEach(add)
  for (const match of content.matchAll(OLD_ZIP_REFERENCE_PATTERN)) add(match[1])
  return ids
}

const ZIP_CONTROL_BLOCK = '\n<batshit-zip-control>{"unzip":["tool_result_1"]}</batshit-zip-control>'
const REPLY_ZIP_IDS = ['cool_tool_1779416324513_repl1', ' zip_1 ', 'COOL_TOOL_1779416324513_UPPER']

function finalize(content: string) {
  return finalizeReplyControl({
    userId: 'user-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    // The parked zip actions run only with the permission on: that is when this reader runs.
    agent: { id: 'agent-1', zip_agent_control_experiment: true },
    globalZipSettings: {},
    content,
    replyZipIds: REPLY_ZIP_IDS,
    projectPath: '/work',
    countsAsMessage: false
  })
}

beforeEach(() => {
  seen.currentToolZipIds.length = 0
})

describe("the reply end's current tool zips (BL-707)", () => {
  it('hands the zip actions exactly the ids the old pattern read', async () => {
    const texts = [...REFERENCE_SCAN_HAND_CASES, ...generateReferenceScanTexts(4_000, 1_707)]
    let fromWords = 0
    for (const text of texts) {
      const content = text + ZIP_CONTROL_BLOCK
      seen.currentToolZipIds.length = 0
      await finalize(content)
      const expected = oldCurrentToolZipIds(REPLY_ZIP_IDS, content)
      expect(seen.currentToolZipIds, JSON.stringify(text)).toEqual([expected])
      if (expected.length > 2) fromWords++
    }
    // The comparison covers replies whose words name tool zips, not only the reply's own ids.
    expect(fromWords).toBeGreaterThan(500)
  })

  it('reads a 1 MB reply of 20,000 unclosed openers in well under 200 ms', async () => {
    for (const [shape, reply] of Object.entries(unclosedReferenceReplies('zip'))) {
      seen.currentToolZipIds.length = 0
      const started = performance.now()
      await finalize(reply + ZIP_CONTROL_BLOCK)
      expect(performance.now() - started, shape).toBeLessThan(200)
      // The reader ran (the zip actions got its ids) and found no reference in the words.
      expect(seen.currentToolZipIds, shape).toEqual([
        ['cool_tool_1779416324513_repl1', 'COOL_TOOL_1779416324513_UPPER']
      ])
    }
  })

  it('still reads a tool zip the words reference', async () => {
    await finalize(`Read it.\n{{batshit-zip:${CONCRETE_ZIP_ID}:::Tool execution: read}}${ZIP_CONTROL_BLOCK}`)
    expect(seen.currentToolZipIds[0]).toContain(CONCRETE_ZIP_ID)
  })
})
