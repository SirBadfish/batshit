/**
 * What the chat page SHOWS when a reply ends without its `end`: the rules, pure, so the
 * ~8,000-line page only calls them (BL-361, 2026-09-27). Since BL-775 the page saves no reply:
 * the server owns every reply's record and publishes `end` with the saved bytes.
 *
 * - After a Stop the page waits 1.5 s for `end`, then draws its own streamed copy, stripped of
 *   the reply control blocks (the server strips them at its reply end; the browser copy still has
 *   them), and a late `end` the server finalized still replaces it (BL-361).
 */

import { REPLY_CONTROL_FINALIZED_FLAG, stripReplyControlBlocks } from './replyControl'

const STOPPED_REPLY_PLACEHOLDER = 'Response stopped.'

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * A streamed copy the server never finalized, as the page draws it: exactly what the server's own
 * reply end would keep of it (`stripReplyControlBlocks`, which reads the reply with the registry's
 * scanner as a finished reply, BL-442): every complete notes, memory, and zip-control block
 * removed, and a real block the Stop left OPEN hidden from its tag on (R3). A tag in code or named
 * in a sentence is text and stays, and so does a last `<` or a partial tag name that never became
 * a tag (R4: BL-577, a stopped reply ending in "a <" used to lose its `<`). `''` for anything
 * that is not text.
 */
export function stripUnfinalizedReplyControl(streamed: unknown): string {
  if (typeof streamed !== 'string') return ''
  return stripReplyControlBlocks(streamed).trim()
}

/**
 * The content the Stop fallback draws: the streamed text without its reply control blocks,
 * closed or not (`stripUnfinalizedReplyControl`), or the placeholder when nothing else streamed.
 */
export function buildStopFallbackContent(streamed: unknown): string {
  return stripUnfinalizedReplyControl(streamed) || STOPPED_REPLY_PLACEHOLDER
}

/**
 * A late `end` is taken, instead of being ignored like every other late event for a finalized
 * message, only when THIS tab's Stop fallback drew that message, the message is STILL finalized
 * (an approval resume reopens it, and its real `end` is then an ordinary one), and the server
 * says it finalized the reply's control blocks. Its content and metadata then replace the
 * fallback copy.
 */
export function shouldAcceptLateEndAfterStopFallback(args: {
  savedByStopFallback: boolean
  isFinalized: boolean
  endMetadata: unknown
}): boolean {
  if (!args.savedByStopFallback || !args.isFinalized) return false
  return isPlainObject(args.endMetadata) && args.endMetadata[REPLY_CONTROL_FINALIZED_FLAG] === true
}
