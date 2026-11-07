import { describe, expect, it } from 'vitest'
import { DatabaseService } from './databaseRedis.server'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'

/**
 * The compile asks the universal resolver (`extractAllReferences`, `universalResolver.ts`)
 * whether an earlier message without `zipIds` carries a zip reference, for the zip state snapshot
 * (`buildZipStateSnapshot`). (SA-139 R4: the zip guidance gate, `shouldInjectZipGuidance`, left
 * with the CLI compile flavor; an API agent always gets the guidance.) The resolver's old pattern
 * cost (openers) x (text length) there: 46 s and 69 s of the one Node process for 20,000 unclosed
 * openers in 1 MB, on every compile of that chat. This is the caller, driven directly: a full compile of the same message
 * still spends seconds elsewhere (the bare hidden-control strip in `zipControl.ts`, which reads
 * the text again from every `{`), so a whole-compile bound would measure that instead.
 */
describe('the compile reads earlier messages for zip references once', () => {
  const service = new DatabaseService() as any
  const history = (content: string) => [
    { id: 'message-1', role: 'user', content: 'Earlier question', metadata: {} },
    { id: 'message-2', role: 'assistant', content, metadata: {} }
  ]

  it('finds a real reference in a message without zipIds', () => {
    const messages = history('Here it is: {{batshit-zip:cool_tool_1779416324513_abcd1:::Tool execution: read}}')
    expect(service.buildZipStateSnapshot(messages, []).hasZipHistory).toBe(true)
  })

  it('reads a reference as the trust reader reads one (BL-609)', () => {
    const ZIP = 'cool_tool_1779416324513_abcd1'
    // A reference Batshit writes with an empty description is zip history; an id with a `{`, a
    // line break, or more than 160 characters is not a reference anywhere else, so not here.
    expect(service.buildZipStateSnapshot(history(`Read: {{batshit-zip:${ZIP}:::}}`), []).hasZipHistory).toBe(true)
    for (const odd of ['{{batshit-zip:a{b:::x}}', '{{batshit-zip:a\nb}}', `{{batshit-zip:${'q'.repeat(161)}}}`]) {
      expect(service.buildZipStateSnapshot(history(`Odd: ${odd}`), []).hasZipHistory, JSON.stringify(odd)).toBe(false)
    }
  })

  it('reads 1 MB of 20,000 unclosed openers in well under 200 ms per caller', () => {
    const replies = { ...unclosedReferenceReplies('zip'), ...unclosedReferenceReplies('clip') }
    for (const [shape, content] of Object.entries(replies)) {
      const messages = history(content)

      const started = performance.now()
      expect(service.buildZipStateSnapshot(messages, []).hasZipHistory, shape).toBe(false)
      expect(performance.now() - started, `${shape} (zip state snapshot)`).toBeLessThan(200)
    }
  })
})
