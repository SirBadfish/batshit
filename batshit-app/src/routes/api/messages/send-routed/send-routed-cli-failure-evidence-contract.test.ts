import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * The managed CLI lanes' failure evidence, plan timing, and the helper's Batshit runs.
 *
 * The rules are tested where they live: the usage label in `executionViewerLlmCapture.test.ts`
 * (`reportedUsageConfidence`), the helper's accounting-only list and a failed result's finish
 * callback in `claudeEventAdapter.test.ts`. These pins are the send-routed wiring those tests
 * cannot see, pinned from the line start so a disabling prefix breaks them.
 */
describe('send-routed: a CLI run that failed keeps its evidence with only the usage its CLI reported (BL-503, BL-1361)', () => {
  it('labels the CLI finish write by what the CLI reported, never exact by default', () => {
    const cliWrite = source.indexOf("\n          const responseUsageSource = isCodexProvider ? 'codex' : 'claude'\n")
    expect(cliWrite).toBeGreaterThan(-1)
    const block = source.slice(cliWrite, source.indexOf('\n          // SA-093 P4 (managed CLI lanes)', cliWrite))
    expect(block).toContain(
      '\n              usage: buildTokenUsage(\n                resolvedUsage ?? null,\n                reportedUsageConfidence(resolvedUsage ?? null),\n                responseUsageSource,\n              ),\n'
    )
    expect(block).not.toMatch(/resolvedUsage \?\? null,\n\s+'exact',/)
  })

  it('adds no second writer: the failure path still writes calls for the API lane only', () => {
    expect(source).toContain('\n    if (!isCliProvider) {\n      const recordedSteps = streamStepRecorder.steps(')
    expect(source.split('llmCaptureClaim.claim(').length - 1).toBe(2)
  })
})

describe('send-routed: a Codex plan update is output, not a tool window (BL-1358)', () => {
  it('marks a plan call as first output only, and every other call as a tool window', () => {
    expect(source).toContain(
      "\n        case 'tool-call': {\n          await flushRawReasoningFallback()\n"
    )
    const callCase = source.indexOf("\n        case 'tool-call': {\n          await flushRawReasoningFallback()\n")
    const head = source.slice(callCase, source.indexOf('\n          if (controlsMode ===', callCase))
    // The slice ends before the next line's own line break.
    expect(head.endsWith(
      '\n          if (isPlanUpdateTool((chunk as any).toolName)) markMeasuredFirstOutput()\n          else markMeasuredToolCallStart()'
    )).toBe(true)
  })

  it('closes no window for a plan result, and still closes one for every other result', () => {
    const resultCase = source.indexOf("\n        case 'tool-error':\n        case 'tool-result': {\n")
    expect(resultCase).toBeGreaterThan(-1)
    const head = source.slice(resultCase, source.indexOf('\n          if (controlsMode ===', resultCase))
    expect(head.endsWith('\n          if (!isPlanUpdateTool((chunk as any).toolName)) markMeasuredToolCallEnd()')).toBe(true)
    // Before the `dynamic` skip, so a dynamic call still closes the window it opened.
    expect(source.indexOf('markMeasuredToolCallEnd()', resultCase)).toBeLessThan(
      source.indexOf('if (toolResult?.dynamic) {', resultCase)
    )
  })
})

describe("send-routed: the helper's Batshit runs count in the reply's spend only (BL-1362)", () => {
  it('reads the accounting-only list beside the raw events', () => {
    expect(source).toContain(
      '\n    if (Array.isArray((result as any).__helperDelegatedSteps)) {\n      helperDelegatedSteps = (result as any).__helperDelegatedSteps\n    }\n'
    )
  })

  it('feeds it to the delegated summary at the finish and failure sites, and nowhere else', () => {
    expect(source).toContain(
      '\n      const delegated = buildDelegatedExecutionSummary([\n        ...(Array.isArray(filteredSteps) ? filteredSteps : []),\n        ...helperDelegatedSteps,\n      ])\n'
    )
    expect(source).toContain(
      '\n      : buildDelegatedExecutionSummary([...streamedToolSteps, ...helperDelegatedSteps])\n'
    )
    // Declared once, assigned once from the bridge's `__helperDelegatedSteps` (named twice there),
    // and read only by those two summaries.
    expect(source.split('helperDelegatedSteps').length - 1).toBe(6)
    expect(source.split('...helperDelegatedSteps').length - 1).toBe(2)
  })
})
