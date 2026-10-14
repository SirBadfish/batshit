import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * BL-775: a group speaker's own copy has its Goon cues, emote tags, and stage directions stripped
 * (`stripGroupChatPresentationControls`), so the rebuild the finalize saves must strip the same;
 * what the rebuild does with the flag is tested in `replyStreamRecord.test.ts`. A group turn cannot
 * run in the default lane's handler harness, so the wiring is pinned here.
 */
describe('send-routed: the rebuild of a group speaker’s reply (BL-775)', () => {
  it('hands the group flag to the rebuild', () => {
    const call = source.slice(source.indexOf('recordedReply = await rebuildRecordedReply({'))
    const args = call.slice(0, call.indexOf('})'))
    expect(args).toContain('groupChat: streamMetadata?.groupChat === true,')
  })
})
