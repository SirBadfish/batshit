import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * BL-245 — a reply that fails (or is stopped) mid-stream keeps its model calls and tool steps in
 * its Execution Viewer snapshot, and the chat shows the provider's own words for an error it sent
 * as a stream chunk.
 *
 * The rules are in `streamFailureEvidence.ts` and its tests (the recorder, and the provider's
 * words read out of the chunk the real DashScope provider could not parse). These pins are the
 * wiring those tests cannot see, pinned from the line start so a disabling prefix breaks them.
 * Measured live beside the old code with a stub model that makes one tool call and then sends
 * DashScope's error chunk: `_local/bug-batch-2026-09-25/send/live/`.
 */
describe('send-routed: the evidence of a reply that failed mid-stream (BL-245)', () => {
  it('shows the recorder every part the loop reads, before the loop acts on it', () => {
    const loop = source.indexOf('\n    for await (const chunk of result.stream) {\n')
    const switchAt = source.indexOf('\n      switch (chunk.type) {\n', loop)
    expect(loop).toBeGreaterThan(-1)
    expect(source.slice(loop, switchAt + 1)).toContain('\n      streamStepRecorder.observe(chunk)\n')
  })

  it('writes the calls on the way out of a failed or stopped API run, unless the finish callback claimed them', () => {
    const catchAt = source.indexOf('\n  } catch (error: any) {\n    const isAbortError = isStopError(')
    const firstSnapshot = source.indexOf("persistRuntimeSnapshot('failed'", catchAt)
    const block = source.slice(catchAt, firstSnapshot)
    expect(block).toContain('\n    if (!isCliProvider) {\n')
    expect(block).toContain(
      "\n      const recordedSteps = streamStepRecorder.steps(isAbortError ? 'interrupted' : 'error')\n      if (recordedSteps.length > 0 && llmCaptureClaim.claim('failure')) {\n"
    )
    // No run total: a call that never finished makes the total unknown, never a partial sum.
    expect(block).toContain('\n            totalUsage: null,\n')
    expect(block).toContain('\n            llmCalls: capture.llmCalls,\n')
  })

  it('the finish callback claims the calls before it awaits anything, and writes them only if it owns them (review finding 1)', () => {
    // It can still be busy when the loop's 2 s wait for it ends and a failure path runs; the
    // snapshot merge keeps both writers' rows, so two writers showed the calls twice.
    const branch = source.indexOf(
      "\n        } else {\n          // Claimed before anything here awaits: a failure path that runs while this callback\n"
    )
    expect(branch).toBeGreaterThan(-1)
    const body = source.slice(branch, source.indexOf('\n          // SA-093 P4 (`API` lane)', branch))
    const claim = body.indexOf("\n          const ownsLlmCapture = llmCaptureClaim.claim('finish')\n")
    expect(claim).toBeGreaterThan(-1)
    expect(body.slice(0, claim)).not.toContain('await ')
    expect(body).toContain('\n            ...(ownsLlmCapture\n              ? {\n                  llmSummary: capture.llmSummary,\n                  llmCalls: capture.llmCalls,\n')
    expect(source.split('llmCaptureClaim.claim(').length - 1).toBe(2)
  })

  it('a provider error chunk’s own code reaches the context check (review finding 3)', () => {
    expect(source).toContain('\n    const contextExhausted = isContextExhaustedStreamFailure(error)\n')
    expect(source).not.toContain('isContextExhaustionError(normalizedErrorMessage)')
  })

  it('reads the provider’s own words out of an error chunk before anything else', () => {
    const errorCase = source.indexOf("\n        case 'error': {\n          await flushRawReasoningFallback()\n")
    const body = source.slice(errorCase, source.indexOf("\n        case 'steer': {\n", errorCase))
    expect(body).toContain('\n          const providerError = providerStreamErrorFrom(rawError)\n')
    expect(body).toContain(
      '\n          if (providerError) {\n            normalizedError = providerError\n          } else if (rawError instanceof Error) {\n'
    )
  })
})
