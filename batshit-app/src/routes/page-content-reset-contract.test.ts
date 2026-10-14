import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync('src/routes/+page.svelte', 'utf8')

/**
 * BL-759 — the chat page's side of a retried answer. A managed lane (Codex's app-server lane) lost
 * its connection mid-answer and started the answer again; `/api/sse` took the unfinished first try
 * out of the reply's record and sends `content_reset` with the reply's text as it now reads.
 *
 * The rules live where their tests can mutate them: `resetToolStreamStateFromContent`
 * (`$lib/utils/toolStreamState.ts`: the text, and the tool cards kept in place) and
 * `RealtimeSpeechCoordinator.discardUnspoken` (Voice Mode drops the words not spoken yet).
 * `+page.svelte` is 8,000 lines, so these pins hold only that the page ASKS them, in its
 * `content_reset` branch, after its late-event guard. Each pin starts at the line's own
 * indentation, so a `void 0 &&` in front of a call breaks it.
 */
describe('the chat page and a retried answer (BL-759)', () => {
  const start = page.indexOf("\n    } else if (data.type === 'content_reset') {\n")
  const end = page.indexOf("\n    } else if (data.type === 'finish') {\n", start)
  const branch = page.slice(start, end)

  it('has one content_reset branch, before the finish branch', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(page.split("data.type === 'content_reset'").length - 1).toBe(1)
  })

  it('ignores a reset for a reply that already ended', () => {
    const guard = branch.indexOf('\n      if (ignoreLateEventForFinalizedMessage(targetMessageId, data.type)) {\n        return\n      }\n')
    expect(guard).toBeGreaterThan(-1)
    expect(branch).toContain(
      "\n      if (!currentMessage || currentMessage.status === 'complete' || currentMessage.status === 'error') {\n        return\n      }\n"
    )
    expect(branch.indexOf('resetToolStreamStateFromContent(')).toBeGreaterThan(guard)
  })

  it('rebuilds the live text through the rule, keeping the tool cards, and drops the chunks buffered for a tool', () => {
    expect(branch).toContain('\n      if (processingState) processingState.pendingChunks = []\n')
    expect(branch).toContain(
      '\n        const resetToolState = resetToolStreamStateFromContent(\n          previousToolState,\n          data.content,\n          () => toolInsertionSequence++\n        )\n        toolStreamStates.set(targetMessageId, resetToolState)\n        resetContent = composeToolStreamContent(resetToolState)\n'
    )
    expect(branch).toContain('\n      messageStore.updateMessage(targetMessageId, {\n        content: resetContent,\n')
  })

  it('drops the words Voice Mode has not spoken yet', () => {
    // With the words taken back (`metadata.removedText`), so a finished message's last words that
    // still wait before them are spoken.
    expect(
      branch.endsWith(
        "\n      realtimeSpeechCoordinator.discardUnspoken(\n        targetMessageId,\n        data.content,\n        typeof data.metadata?.removedText === 'string' ? data.metadata.removedText : null\n      )"
      )
    ).toBe(true)
  })
})
