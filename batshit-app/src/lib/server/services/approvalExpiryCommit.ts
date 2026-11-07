import { redis } from '$lib/server/redis'
import type { ApprovalStateSnapshot } from './toolApprovalState'
import { SERVER_REPLAY_FIELDS } from '$lib/utils/serverReplayFields'

export type ApprovalExpiryCommit = {
  userId: string
  sessionId: string
  messageId: string
  expectedRaw: string
  changes: ApprovalStateSnapshot['updates'][number]['changes']
  /**
   * SA-137 (D7): the paused call's live-file-read snapshot to retire with its card, by the `pauseId`
   * read from `expectedRaw`. Set only when the changes leave no approval pending. The field is set to
   * null only while it still names this pause; an absent field stays absent.
   */
  retireLiveReplayPauseId?: string | null
  /** The closed historical card's exact server-derived steer ids, never request data. */
  retiredCard?: { steerIds: string[] }
  onIssue?: () => void
  signal?: AbortSignal | null
}

/** Read ownership and the exact source again in the same Redis operation as the leaf writes.
 * Never re-encode the record/summary: tool inputs and every sibling retain their raw values.
 * All paths/types are checked before the first write; Lua does not roll back earlier writes.
 */
export const APPROVAL_EXPIRY_COMMIT_SCRIPT = `
local sessionRaw = redis.call('JSON.GET', KEYS[1], '$')
if not sessionRaw then return 'MISSING_SESSION' end
local session = cjson.decode(sessionRaw)[1]
if type(session) ~= 'table' or session.user_id ~= ARGV[1] then return 'FORBIDDEN' end
local current = redis.call('JSON.GET', KEYS[2], '$')
if not current then return 'MISSING_MESSAGE' end
if current ~= ARGV[4] then return 'CHANGED' end
local message = cjson.decode(current)[1]
if type(message) ~= 'table' or message.id ~= ARGV[3] or message.session_id ~= ARGV[2]
  or message.user_id ~= ARGV[1] or message.role ~= 'assistant' then return 'FORBIDDEN' end
local changes = cjson.decode(ARGV[5])
local fields = {status = 'string', submitted = 'boolean', requestedAt = 'string', expiresAt = 'string', expiredAt = 'string', expiryReason = 'string'}
local writes = {}
for _, change in ipairs(changes) do
  if type(change.index) ~= 'number' or change.index < 0 or change.index ~= math.floor(change.index) then
    return redis.error_reply('Invalid approval entry index')
  end
  local base = '$.metadata.toolApprovals.approvals[' .. change.index .. ']'
  if redis.call('JSON.TYPE', KEYS[2], base)[1] ~= 'object' then
    return redis.error_reply('Approval entry no longer exists')
  end
  for field, value in pairs(change.fields) do
    if fields[field] ~= type(value) then return redis.error_reply('Invalid approval state field') end
    table.insert(writes, {path = base .. '.' .. field, value = cjson.encode(value)})
  end
end
if ARGV[6] ~= '' then
  local pause = redis.call('JSON.GET', KEYS[2], '$.metadata.liveFileReadSnapshot.pauseId')
  if pause and cjson.decode(pause)[1] == ARGV[6] then
    table.insert(writes, {path = '$.metadata.liveFileReadSnapshot', value = 'null'})
  end
end
if ARGV[7] ~= '' then
  local retired = cjson.decode(ARGV[7])
  if type(retired) ~= 'table' or type(retired.steerIds) ~= 'table' then return redis.error_reply('Invalid retired card disposition') end
  for _, id in ipairs(retired.steerIds) do if type(id) ~= 'string' then return redis.error_reply('Invalid retired steer id') end end
  if redis.call('JSON.TYPE', KEYS[2], '$.metadata')[1] ~= 'object' then return redis.error_reply('Invalid approval metadata') end
  local marker = redis.call('JSON.TYPE', KEYS[2], '$.metadata.retiredApprovalSettled')[1]
  if marker and marker ~= 'null' and marker ~= 'boolean' then return redis.error_reply('Invalid retirement marker') end
  -- If a later path write fails, a fully expired card must still yield a held-message receipt.
  -- While any entry is pending the receipt reader keeps the ordinary waiting state.
  table.insert(writes, 1, {path = '$.metadata.retiredApprovalSettled', value = 'true'})
  for _, name in ipairs(cjson.decode('${JSON.stringify(SERVER_REPLAY_FIELDS)}')) do
    local path = '$.metadata.' .. name
    if redis.call('JSON.TYPE', KEYS[2], path)[1] then table.insert(writes, {path = path, value = 'null'}) end
  end
  if #retired.steerIds > 0 then
    local parent = redis.call('JSON.TYPE', KEYS[2], '$.metadata.steerPromoted')[1]
    if parent and parent ~= 'object' and parent ~= 'null' then return redis.error_reply('Invalid retired steer disposition') end
    if not parent or parent == 'null' then table.insert(writes, {path = '$.metadata.steerPromoted', value = '{}' }) end
    table.insert(writes, {path = '$.metadata.steerPromoted.steerIds', value = cjson.encode(retired.steerIds)})
    table.insert(writes, {path = '$.metadata.steerPromoted.disposition', value = '"unanswered"'})
    table.insert(writes, {path = '$.metadata.steerPromoted.reason', value = '"approval_expired"'})
  end
end
for _, write in ipairs(writes) do
  local result = redis.call('JSON.SET', KEYS[2], write.path, write.value)
  if type(result) ~= 'table' or result.ok ~= 'OK' then return redis.error_reply('Approval state write unconfirmed') end
end
return 'OK'
`

export async function commitApprovalExpiry(input: ApprovalExpiryCommit): Promise<string> {
  const result = await redis.execute(client => {
    // execute may await a connection. Fence Stop at physical issuance after that await,
    // without cancelling or retrying an EVAL that has already been issued.
    input.signal?.throwIfAborted()
    input.onIssue?.()
    return client.eval(APPROVAL_EXPIRY_COMMIT_SCRIPT, {
      keys: [`session:${input.sessionId}`, `message:${input.sessionId}:${input.messageId}`],
      arguments: [input.userId, input.sessionId, input.messageId, input.expectedRaw, JSON.stringify(input.changes),
        input.retireLiveReplayPauseId ?? '', input.retiredCard ? JSON.stringify(input.retiredCard) : '']
    })
  })
  if (typeof result !== 'string') throw new Error('Approval expiry write returned an unknown outcome.')
  return result
}
