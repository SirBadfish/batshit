import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * A Stop (or a delete) reaches a turn that is still SETTING UP (2026-09-18).
 *
 * Nothing is registered to abort during setup, so the interrupt route and the chat delete stop
 * the TURN: each registration carries its own stop signal (`streamAbortRegistry.ts`, where that
 * rule is tested). These pins are the wiring the registry tests cannot see: the POST takes its
 * registration's signal and hands it to every run it starts, single-agent and group alike, and
 * each run forwards it, WITH its reason, into the controller the setup checkpoint reads. Measured
 * before, in a real page: Stop 150 ms after the send answered `stale_turn_cleared` and the reply
 * ran `sleep 20` to a full answer (`_local/stopfix-proof/before-page-same-150b.json`).
 */
describe('send-routed: a turn’s own stop signal reaches every run', () => {
  // The POST's body (2026-09-18: `POST` itself only decides when to answer, `respondAsyncSend.ts`).
  const post = source.indexOf('\nasync function handleSendRoutedRequest(\n')
  const postSource = source.slice(post)

  /** Each call's argument object, from its `({` to the brace that closes it. */
  function callBlocks(text: string, call: string): string[] {
    const blocks: string[] = []
    let index = text.indexOf(call)
    while (index >= 0) {
      const open = index + call.length - 1
      let depth = 0
      let end = open
      for (let i = open; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1
        else if (text[i] === '}') depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
      blocks.push(text.slice(index, end + 1))
      index = text.indexOf(call, index + call.length)
    }
    return blocks
  }

  it('the POST takes its own registration’s signal, right after keeping its id', () => {
    expect(postSource).toContain(
      '\n    const sessionTurnId = sessionTurnRegistration.entry.turnId\n    const turnStopSignal = sessionTurnRegistration.entry.stop.signal\n'
    )
  })

  it('every single-agent run and the group run get it', () => {
    const runs = callBlocks(postSource, 'await handleBatshitAgentStream({')
    expect(runs).toHaveLength(3)
    for (const run of runs) expect(run).toMatch(/\n\s+turnStopSignal,\n/)

    const group = callBlocks(postSource, 'return await handleGroupChatStream({')
    expect(group).toHaveLength(1)
    expect(group[0]).toContain('turnStopSignal,')

    // And the group handler's own single-agent fallback, for a group whose config is off.
    const groupHandler = source.slice(
      source.indexOf('\nasync function handleGroupChatStream({'),
      source.indexOf('registerGroupAbort(sessionId, groupAbortController)')
    )
    const fallback = callBlocks(groupHandler, 'await handleBatshitAgentStream({')
    expect(fallback).toHaveLength(1)
    expect(fallback[0]).toMatch(/\n\s+turnStopSignal,\n/)
  })

  it('a run forwards it into the controller the setup checkpoint reads, reason and all', () => {
    const handler = source.indexOf('\nasync function handleBatshitAgentStream({')
    const checkpoint = source.indexOf('const abortedDuringSetup = Boolean(streamAbortSignal.aborted)', handler)
    const wiring = source.indexOf(
      '\n  if (turnStopSignal) {\n    const forwardTurnStop = () => streamAbortController.abort(turnStopSignal.reason)\n    if (turnStopSignal.aborted) forwardTurnStop()\n    else turnStopSignal.addEventListener(\'abort\', forwardTurnStop, { once: true })\n  }\n',
      handler
    )
    expect(handler).toBeGreaterThan(-1)
    expect(wiring).toBeGreaterThan(handler)
    expect(checkpoint).toBeGreaterThan(wiring)
  })

  it('a stopped stream releases the wait for `onFinish`, which an aborted stream never calls', () => {
    // After its loop, the run waits up to 2 s for `onFinish` (the SDK can finish ahead of the
    // loop). An aborted stream calls `onAbort` instead, before the loop reads the abort part
    // (the SDK side is pinned in `aiSdkBaseline.contract.test.ts`), so every stopped API reply
    // waited the full 2 s: Stop to `end` measured 2.06 s on 2026-09-18.
    const onAbort = callBlocks(source, 'onAbort: ({ steps }) => {')
    expect(onAbort).toHaveLength(1)
    expect(onAbort[0]).toContain('resolveOnFinish?.()')
    expect(onAbort[0]).not.toContain('onFinishResolved = true')
    expect(source).toContain(
      '    if (!onFinishResolved) {\n      await Promise.race([\n        onFinishPromise,\n        new Promise<void>((resolve) => setTimeout(resolve, 2000)),\n      ])\n    }'
    )
  })

  it('the group run forwards it into the group’s own controller', () => {
    const group = source.indexOf('\nasync function handleGroupChatStream({')
    const register = source.indexOf('registerGroupAbort(sessionId, groupAbortController)', group)
    const wiring = source.indexOf(
      '\n  if (turnStopSignal) {\n    const forwardTurnStop = () => groupAbortController.abort(turnStopSignal.reason)\n',
      group
    )
    expect(register).toBeGreaterThan(group)
    expect(wiring).toBeGreaterThan(register)
    expect(wiring - register).toBeLessThan(600)
  })
})
