import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Source with its comments stripped: the claims are about what the code DOES. */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const page = codeOnly(readFileSync('src/routes/+page.svelte', 'utf8'))

/**
 * A chat deleted in another tab leaves this one too (2026-09-18).
 *
 * Seen live: a chat deleted in one tab stayed in every other tab's sidebar, and on screen in a
 * tab showing it, until that tab reloaded. The server now announces `session_deleted` on the user
 * channel (`sessionDeleteTurnStop.ts`), and `userChannel.ts` drops the chat from the sidebar's
 * store BEFORE any listener hears the event (both pinned in their own tests). These pins are the
 * page's half, which a unit test cannot mount: it forgets the chat through the same cleanup as a
 * chat found missing, and that cleanup still resets the page's per-chat state for it (the message
 * view's active chat, the thinking indicators, the Execution Viewer snapshots) although the store
 * has already let go of it. Proven live in three real tabs (`_local/tabdelete-proof/`); the view
 * itself clears even without the second pin's clause (measured, `mutant-T7-outside.json`), so
 * that clause is pinned here and nowhere else.
 */
describe('the chat page forgets a chat deleted in another tab', () => {
  it('hands session_deleted to the missing-chat cleanup', () => {
    const listener = page.indexOf("if (event?.type === 'session_deleted') {")
    expect(listener).toBeGreaterThan(-1)
    const body = page.slice(listener, page.indexOf('return\n      }', listener))
    expect(body).toContain("clearMissingSelectedSession(deletedSessionId, 'session_deleted')")
    // Every tab, not only the one showing the chat: its messages and live connection go too.
    expect(body).not.toContain('currentSessionId')
  })

  it('counts the chat the message view still shows as on screen', () => {
    const cleanup = page.indexOf('function clearMissingSelectedSession(')
    expect(cleanup).toBeGreaterThan(-1)
    const head = page.slice(cleanup, page.indexOf('missingSessionIds.add(sessionId)', cleanup))
    expect(head).toContain('sessionStore.getCurrentSessionId() === sessionId ||')
    expect(head).toContain('messageStore.getActiveSessionId() === sessionId')
  })
})

/**
 * The page does not save a reply back into a chat that was deleted (bug sweep, 2026-09-18).
 * The server marks such a reply `chatDeleted` on its `end` and `complete` events
 * (`send-routed-session-delete-contract.test.ts`); saving it anyway was refused by the save route
 * and shown as a false "Failed to save message to database".
 */
describe('the chat page and a reply stopped because its chat was deleted', () => {
  it('skips the save at end', () => {
    const endHandler = page.indexOf("} else if (data.type === 'end') {")
    const save = page.indexOf('await saveMessageToDatabase(targetMessageId)', endHandler)
    expect(save).toBeGreaterThan(endHandler)
    expect(page.slice(save - 120, save)).toContain('if (metadata?.chatDeleted !== true) {')
  })

  it('skips the save at complete', () => {
    const completeHandler = page.indexOf("} else if (data.type === 'complete') {")
    const save = page.indexOf('await saveMessageToDatabase(targetMessageId)', completeHandler)
    expect(save).toBeGreaterThan(completeHandler)
    expect(page.slice(completeHandler, save)).toContain("data?.metadata?.chatDeleted !== true")
  })
})

describe('the chat page and a send refused because its chat was deleted', () => {
  it('says so once, ahead of the generic error toast', () => {
    const branch = page.indexOf("if (errorCode === 'session_deleted') {")
    const generic = page.indexOf("toast.error(genericMessage ? 'Failed to send message' : message || 'Failed to send message', {")
    expect(branch).toBeGreaterThan(-1)
    expect(generic).toBeGreaterThan(branch)
    const body = page.slice(branch, page.indexOf('return false', branch))
    expect(body).toContain("toast.info(message || 'This chat was deleted.')")
    expect(body).not.toContain('description')
  })
})
