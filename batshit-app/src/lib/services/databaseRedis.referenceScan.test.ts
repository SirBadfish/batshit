import { describe, expect, it } from 'vitest'
import { DatabaseService } from './databaseRedis.server'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'

/**
 * The compile asks the universal resolver (`extractAllReferences`, `universalResolver.ts`)
 * whether an earlier message without `zipIds` carries a zip reference: once for the zip
 * guidance (`shouldInjectZipGuidance`) and once for the zip state snapshot
 * (`buildZipStateSnapshot`). The resolver's old pattern cost (openers) x (text length) there:
 * 46 s and 69 s of the one Node process for 20,000 unclosed openers in 1 MB, on every compile of
 * that chat. These are the two callers, driven directly: a full compile of the same message
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
    expect(service.shouldInjectZipGuidance(messages, { id: 'agent-1' }, {}, {})).toBe(true)
  })

  it('reads 1 MB of 20,000 unclosed openers in well under 200 ms per caller', () => {
    const replies = { ...unclosedReferenceReplies('zip'), ...unclosedReferenceReplies('clip') }
    for (const [shape, content] of Object.entries(replies)) {
      const messages = history(content)

      let started = performance.now()
      expect(service.buildZipStateSnapshot(messages, []).hasZipHistory, shape).toBe(false)
      expect(performance.now() - started, `${shape} (zip state snapshot)`).toBeLessThan(200)

      started = performance.now()
      service.shouldInjectZipGuidance(messages, { id: 'agent-1' }, {}, {})
      expect(performance.now() - started, `${shape} (zip guidance)`).toBeLessThan(200)
    }
  })
})
