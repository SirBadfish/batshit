import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync('src/routes/+page.svelte', 'utf8')
const chatArea = readFileSync('src/lib/components/chat/ChatArea.svelte', 'utf8')

/**
 * BL-455 — the chat page's side of words that wait at an approval card.
 *
 * The rules live in `$lib/utils/heldForApproval.ts`, where their tests can mutate them (and, since
 * BL-713, the line's own hold at a card lives on the server, `streamAbortRegistry.ts`); `+page.svelte` is 8,000 lines, so these pins hold only that the page ASKS them, and
 * each pin starts at the line's own indentation, so a `void 0 &&` in front of a call breaks it.
 */
describe('the chat page and a message held for an approval card (BL-455)', () => {
  it('the chat draws the receipt under the held message, and Send now sends that message by its id', () => {
    expect(page).toContain(
      '\n          sessionBusy={chatWorkBusy}\n          onSendHeldMessage={sendHeldMessageNow}\n'
    )
    const sendStart = page.indexOf('function sendHeldMessageNow(messageId: string) {')
    expect(sendStart).toBeGreaterThan(-1)
    expect(page.slice(sendStart, sendStart + 700)).toContain(
      '\n    void handleSendMessage(\n      held.content,\n      { composerSessionId: sessionId },\n      { fromDroppedReceipt: true, existingUserMessageId: messageId }\n    )'
    )
    expect(chatArea).toContain(
      '\n  const heldReceipt = $derived(resolveHeldMessageReceipt({ messages, busy: sessionBusy }))\n'
    )
    // BL-905: a send the chat's line kept at the same card can stand after the held words, so the
    // receipt goes under the held message itself, not under whatever is last.
    expect(chatArea).toContain(
      '\n        {#if heldReceipt && heldReceipt.messageId === message.id}\n          <HeldMessageReceipt receipt={heldReceipt} onSendNow={onSendHeldMessage} />\n        {/if}\n      {/each}\n'
    )
    expect(chatArea).not.toContain('\n      {#if heldReceipt}\n')
  })

  it('the end-of-reply backstop arms only for what the server still has to place, never a send in the line', () => {
    expect(page).toContain(
      '\n    const awaitingServer = steerInbox.getSteersAwaitingServerForMessage(sessionId, messageId)\n    if (awaitingServer.length === 0) return\n'
    )
    expect(page).toContain('\n    for (const entry of awaitingServer) armDropBackstop(entry)\n')
  })

  it('a held message shows no busy state: its `user_message` and `steer_promoted` only settle the chat', () => {
    // A hold forwards the same two events a promotion does, and then runs no turn. A promotion's
    // busy state comes from its follow-up turn's own stream events, never from these two cases.
    const start = page.indexOf("} else if (data.type === 'user_message' && data.message) {")
    const end = page.indexOf("} else if (data.type === 'complete_message' && data.message) {", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const handlers = page.slice(start, end)
    expect(handlers).toContain("} else if (data.type === 'steer_promoted') {")
    for (const busySignal of ['chatRunRegistry.', 'isWaitingForResponse', 'createAssistantWaitingPlaceholder', 'registerActiveMessage']) {
      expect(handlers).not.toContain(busySignal)
    }
  })
})
