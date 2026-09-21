import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * A stopped stream goes straight to the interrupted path, and a Stop is never logged as a
 * provider error (2026-09-18). The rule is `streamStop.ts` (tested there); these pins are where
 * the stream handler asks it. Measured before: every Stop logged
 * `[Send-Routed] Batshit agent streaming error: user` (or the Codex lane's `AbortError`), and a
 * Stop that ended the SDK's stream with its `abort` part also logged
 * `Failed to parse tool approval requests user` and
 * `The model provider returned an empty response` before the catch answered 499.
 */
describe('send-routed: a stopped stream is interrupted', () => {
  const handler = source.indexOf('\nasync function handleBatshitAgentStream({')
  const handlerSource = source.slice(handler, source.indexOf('\nfunction resolveGroupSpeakerAbout(', handler))

  it('after the loop, a stopped stream is judged BEFORE the approval parse and the empty check', () => {
    const onFinishWait = handlerSource.indexOf('\n    if (!onFinishResolved) {\n      await Promise.race([\n')
    const judged = handlerSource.indexOf(
      '\n    const streamEnd = judgeStreamEnd({\n      stopped: streamAbortSignal.aborted,\n      runtimeError: streamRuntimeError,\n    })\n    if (streamEnd.kind === \'stopped\') throw new StreamStoppedError()\n    if (streamEnd.kind === \'failed\') throw streamEnd.error\n',
      onFinishWait
    )
    const approvals = handlerSource.indexOf('await extractToolApprovalRequests(result)', onFinishWait)
    const empty = handlerSource.indexOf("'PROVIDER_EMPTY_RESPONSE',", onFinishWait)
    expect(onFinishWait).toBeGreaterThan(-1)
    expect(judged).toBeGreaterThan(onFinishWait)
    expect(approvals).toBeGreaterThan(judged)
    expect(empty).toBeGreaterThan(judged)
    // The old bare throw is gone: the verdict is the only way out of the loop's tail.
    expect(handlerSource).not.toContain('\n    if (streamRuntimeError) {\n      throw streamRuntimeError\n    }\n')
  })

  it('the catch asks the rule first, and logs a provider error only when it was not a Stop', () => {
    const catchAt = handlerSource.indexOf('\n  } catch (error: any) {\n    const isAbortError = isStopError(error, [streamAbortSignal, request.signal])\n')
    expect(catchAt).toBeGreaterThan(-1)
    const catchHead = handlerSource.slice(catchAt, catchAt + 700)
    expect(catchHead).toContain(
      "\n    if (isAbortError) {\n      logger.debug('[Send-Routed] Stream stopped', {"
    )
    expect(catchHead).toContain(
      "\n    } else {\n      console.error('[Send-Routed] Batshit agent streaming error:', error)\n    }\n"
    )
    expect(handlerSource.split("console.error('[Send-Routed] Batshit agent streaming error:'").length - 1).toBe(1)
  })
})
