/**
 * The one owner of "the user clicked Load" for outside pictures (BL-474, step 1).
 *
 * A permission is for exactly one address in one message, in this tab only: it lives in this
 * module's memory, so another tab, a spectator tab, or a reload starts with none, and nothing is
 * saved. A changed address is a different key and needs its own click. There is no switch that
 * allows every picture. `ImageRenderer` gives an outside picture an address only when
 * `isImageLoadAllowed` says so; nothing may request an outside picture before that.
 */
import { SvelteSet } from 'svelte/reactivity'

const allowed = new SvelteSet<string>()

function keyOf(messageId: string, url: string): string {
  return `${messageId}\u0000${url}`
}

/** Called by the Load action only. */
export function allowImageLoad(messageId: string, url: string): void {
  if (!url) return
  allowed.add(keyOf(messageId, url))
}

export function isImageLoadAllowed(messageId: string, url: string): boolean {
  if (!url) return false
  return allowed.has(keyOf(messageId, url))
}

/**
 * The Svelte context key under which `MessageContent` offers its message id (a getter), so a
 * picture drawn inside a tool card of that message (`ImageGenerationRenderer`,
 * `AgentBrowserScreenshotRenderer`) keys its Load click to that message too.
 */
export const IMAGE_MESSAGE_ID_CONTEXT = Symbol('batshit-image-message-id')

/** Tests only: a fresh tab. */
export function resetImageLoadConsentForTests(): void {
  allowed.clear()
}
