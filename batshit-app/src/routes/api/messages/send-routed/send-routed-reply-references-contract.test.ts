import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')
const page = readFileSync('src/routes/+page.svelte', 'utf8')
const compiler = readFileSync('src/lib/services/databaseRedis.server.ts', 'utf8')

/**
 * BL-490: `emitTextChunk` neutralizes zip syntax one chunk at a time, so a reference the model
 * echoed across two chunks survived it; only the normal finish re-checked the whole reply, and a
 * Stop or a failed stream saved it raw. The rule is `neutralizeFinishedReplyReferences`
 * (`zipReferenceSafety.ts`, tested there); these pins hold the WIRING: it runs once, inside
 * `finalizeAssistantMessage`, which every ending goes through; the chat page reads references
 * with the same shared reader (`scanZipReferences`); and the compile reads no zip of another chat.
 */
describe('a finished reply is neutralized once, for every way it ends', () => {
  const finalizeStart = source.indexOf('\n  const finalizeAssistantMessage = async (\n')
  const finalizeBody = source.slice(finalizeStart, source.indexOf('\n      await streamAdapter.emitEnd({\n', finalizeStart))

  it('runs the whole-reply pass inside finalizeAssistantMessage, against the reply\'s own zips', () => {
    expect(finalizeStart).toBeGreaterThan(0)
    expect(finalizeBody).toContain(
      '\n        const sanitizedEndContent = neutralizeFinishedReplyReferences(\n' +
        '          stripAttachmentReferences(endContent),\n' +
        '          finishSummary.zipReferences\n'
    )
    // Before the reply-end control step, so it reads the same words it always did.
    expect(finalizeBody.indexOf('neutralizeFinishedReplyReferences(')).toBeLessThan(
      finalizeBody.indexOf('replyControl = await finalizeReplyControl({')
    )
  })

  it('keeps no second, finish-only pass', () => {
    expect(source.split('neutralizeFinishedReplyReferences(').length - 1).toBe(1)
    expect(source).not.toContain('neutralizeUntrustedZipReferenceSyntax(')
  })

  it('every ending finalizes through it: the finish, a Stop, and a failed stream', () => {
    expect(source).toContain("\n      await finalizeAssistantMessage('postStream')\n")
    // A failed stream calls it directly; every Stop (setup, early resume, mid-reply) goes through
    // `finalizeStoppedReply`, which calls it (BL-775).
    expect(source.split("await finalizeAssistantMessage('error')").length - 1).toBeGreaterThanOrEqual(2)
    expect(source.split('await finalizeStoppedReply(').length - 1).toBe(3)
  })

  it('the reply end reads content references with the shared reader (moved from the page, BL-775)', () => {
    const replyEnd = readFileSync('src/lib/utils/replyEndContent.ts', 'utf8')
    expect(replyEnd).toContain('\n  for (const reference of scanZipReferences(content)) {\n')
    expect(page).not.toContain('\n    const regex = /\\{\\{batshit-zip:([^:}]+)(?::::[^}]*)?\\}\\}/g\n')
    expect(page).not.toContain('BATSHIT_ZIP_REFERENCE_REGEX')
  })

  it('the compile reads a zip of another chat as missing', () => {
    expect(compiler).toContain(
      "\n            .then((zip: any) => (zipBelongsToAnotherChat(zip, zipOwner) ? null : zip))\n"
    )
    expect(compiler.split('zipOwner: { sessionId, userId: userId ?? null },').length - 1).toBe(2)
  })
})
