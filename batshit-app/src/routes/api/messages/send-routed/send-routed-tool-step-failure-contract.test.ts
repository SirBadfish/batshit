import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * send-routed keeps its own copy of every tool step: the one the Execution Viewer stores, the
 * saved message's `intermediateSteps`, and the `end` event's. Each copy once read its `error` and
 * `success` from the raw result's own flag, so an API search that matched nothing was a failed
 * row (fp65g), and a failed Codex command (an exit code with no `success: false`) or a failed
 * Claude command (its lane's error, overwritten by that flag) was a Success row (fp65h). The
 * decision lives in `toolStepFailureMessage` (`toolResultProcessor.ts`, beside `normalizeToolStep`,
 * and tested there); these pins hold the WIRING: every copy reads its failure through it, from the
 * step's own name, arguments, and parsed result, and a lane's own error wins.
 */
describe('send-routed step copies read their failure the way the stored step does', () => {
  it('imports the shared rule and keeps no local copy of it', () => {
    expect(source).toContain("\nimport { toolStepFailureMessage } from '$lib/utils/toolResultProcessor'\n")
    for (const retired of ['toolResultIndicatesFailure', 'extractToolResultErrorMessage', 'inferToolStepSuccess']) {
      expect(source).not.toContain(retired)
    }
  })

  it('reads each copy\'s failure from that copy\'s own name, arguments, and parsed result', () => {
    // A precompiled step, a step built from the SDK's finish steps, and the streamed step.
    expect(source).toContain(
      '\n    step.error ?? toolStepFailureMessage(toolName, normalizedInput, parseJsonLike(normalizedResult))\n'
    )
    expect(source).toContain(
      '\n    const error = toolStepFailureMessage(mappedToolName, mappedInput, parseJsonLike(mappedResult))\n'
    )
    expect(source).toContain(
      '\n              toolStepFailureMessage(emittedToolName, emittedArgs, parseJsonLike(sanitizedResultPayload))\n'
    )
    expect(source.split('toolStepFailureMessage(').length - 1).toBe(3)
  })

  it('lets the lane\'s own error win in the streamed copy, where the spreads above it once lost it', () => {
    expect(source).toContain(
      '\n            const laneError = [toolResult.metadata?.error, toolResultEvent.metadata?.error].find(\n'
    )
    expect(source).toContain('\n            const stepError =\n              laneError ??\n')
    // The explicit key comes after the metadata spreads, so it must carry the lane's error.
    expect(source).toContain(
      '\n              ...(toolResult.metadata ?? {}),\n' +
        '              error: stepError,\n' +
        '              success: stepError ? false : sanitizedResultPayload !== undefined,\n'
    )
  })

  it('never calls a copy with an error a success', () => {
    expect(source).toContain(
      '\n    success: error\n' +
        '      ? false\n' +
        "      : typeof step.success === 'boolean'\n" +
        '        ? step.success\n' +
        '        : normalizedResult !== undefined && normalizedResult !== null,\n'
    )
    expect(source).toContain('\n      success: error ? false : mappedResult !== undefined,\n')
  })
})
