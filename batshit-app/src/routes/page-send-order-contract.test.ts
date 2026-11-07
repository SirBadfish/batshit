import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * BL-922: the chat page holds each send of a chat until the chat's earlier sends have their first
 * answers (`sendOrderGate.ts`, whose own test fires two sends 10 ms apart). These pin where the
 * page takes its place, waits, and lets the next send go.
 */
describe('the chat page sends a chat\'s messages in order (BL-922, source pins)', () => {
  const page = readFileSync(path.resolve('src/routes/+page.svelte'), 'utf8')
  const start = page.indexOf('\n\t\t  async function handleSendMessage(')
  const body = page.slice(start, page.indexOf('\n  // Stop the current stream', start))

  it('a send takes its place in its chat before anything it awaits', () => {
    expect(start).toBeGreaterThan(-1)
    const enter = body.indexOf('\n\t    const sendOrder = sendOrderGate.enter(sendSessionId)\n')
    expect(enter).toBeGreaterThan(-1)
    expect(enter).toBeLessThan(body.indexOf('await '))
  })

  it('it waits for its turn before it decides steer, line or new turn, and before it saves or posts', () => {
    const wait = body.indexOf('\n\t    const sendTurn = await sendOrder.turn\n')
    expect(wait).toBeGreaterThan(-1)
    for (const later of [
      'const hasActiveStream = chatRunRegistry.isSessionBusy(currentSessionId)',
      'const outcome = await postSteer({',
      'await dbService.saveMessage(userMessage, currentAgentForSend)',
      'const routedSend = await postSendRoutedWithInterruptRetry({'
    ]) {
      expect(body.indexOf(later)).toBeGreaterThan(wait)
    }
  })

  it('a send still waiting when the user pressed Stop is not sent', () => {
    expect(body).toContain(
      "\n\t    if (sendTurn.waited && (lastManualInterruptAtBySession.get(currentSessionId) ?? 0) >= sendMadeAt) {\n\t      toast.info('Not sent: you stopped the reply.')\n\t      return false\n\t    }\n"
    )
  })

  it('a send gives the gate its message id before it posts, and a send that waited out names them', () => {
    const named = body.indexOf('\n\t    sendOrder.setMessageId(userId)\n')
    expect(named).toBeGreaterThan(-1)
    expect(named).toBeLessThan(body.indexOf('const routedSend = await postSendRoutedWithInterruptRetry({'))
    expect(body).toContain('\n\t        earlierSendIds: sendTurn.gaveUpOn ?? []\n')
  })

  it('the 202 lets the next send go, and so does every way out', () => {
    expect(body).toContain('\n\t            onAccepted: () => {\n\t              sendOrder.settle()\n')
    expect(body).toContain('\n\t    } finally {\n\t      sendOrder.settle()\n')
  })
})
