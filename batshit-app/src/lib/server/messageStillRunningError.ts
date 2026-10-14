/**
 * BL-381: a reply its request is still writing cannot be deleted. `DELETE
 * /api/messages/[sessionId]/[messageId]` answers this with 409 `message_still_running`, both from
 * its own check and from `redis.deleteMessage`'s second check inside the chat's zip state lock.
 * A leaf module, so `redis.ts` and the route can share it.
 */
export const MESSAGE_STILL_RUNNING_CODE = 'message_still_running'
export const MESSAGE_STILL_RUNNING_TEXT =
  'This reply is still running, so it was not deleted. Stop it or wait until it ends, then delete it.'

export class MessageStillRunningError extends Error {
  readonly code = MESSAGE_STILL_RUNNING_CODE
  constructor() {
    super(MESSAGE_STILL_RUNNING_TEXT)
    this.name = 'MessageStillRunningError'
  }
}
