// Direct Redis service for SvelteKit server-side operations
// Replaces batshit-server proxy with direct Redis 8 JSON support

import { logger } from '$lib/utils/logger'
import { escapeRedisGlob } from '$lib/utils/redisGlob'
import { replaceBracedTokens } from '$lib/utils/braceScan'
import {
  firstJsonPathMatch,
  unclaimedZipsMadeByMessage,
  zipClaimsOfMessage,
  zipsOwnedOnlyByMessage
} from '$lib/utils/messageDeletionZips'
import { MessageStillRunningError } from '$lib/server/messageStillRunningError'
import { BrowserMessageMutationError, type BrowserMessageMutationPolicy } from '$lib/server/browserMessageMutation'
import { withZipStateLock } from '$lib/server/services/zipStateLock'
import {
  FOLDER_CHANGED_CODE,
  FOLDER_CHANGED_MESSAGE,
  sameFolderChatIds,
  selectFolderChats
} from '$lib/server/services/folderChatsForDelete'
import type { FixedSessionMetadata } from '$lib/utils/fixedSession'
import { createClient, type RedisClientType } from 'redis'
import type { 
  ChatSessionRow, 
  ChatMemoryRow, 
  AgentRow, 
  GroupChatGroupRow,
  UserSettingsRow, 
  ProjectRow,
  ProjectPreferences,
  SubagentRow,
  ChatFolderRow 
} from '$lib/types/database'
import type { VoiceSettings, VoiceProfileRecord } from '$lib/types/voice'
import type { GoonsSettings } from '$lib/types/goons'
import type { Message } from '$lib/stores/messages.svelte'
import {
  normalizeGroupMaxAgents,
  normalizeGroupMaxFollowupsTotal
} from '$lib/types/groupChat'
import {
  canonicalizePrimaryAgentRecord,
  hasLegacyPrimaryAgentFields,
  normalizePrimaryAgentType,
  shouldShowReasoningByDefaultForPrimaryAgent
} from '$lib/utils/primaryAgentType'
import {
  AGENT_MEMORY_SOURCE_PATHS,
  AGENT_TYPE_SOURCE_PATHS,
  AgentMemorySettingsConflictError,
  AgentUpdateConflictError,
  agentMemoryBaseMatches,
  agentMemoryFieldsFromAnswers,
  agentUpdateScriptArguments,
  planAgentRecordUpdate,
  serializeAgentRecordPlan,
  type AgentUpdateOptions
} from '$lib/server/agentRecordUpdate'
import { planSubagentRecordUpdate } from '$lib/server/subagentRecordUpdate'
import {
  collectTrustedClipIdsFromMetadata,
  scanDeletionSweepZipReferences,
  neutralizeAllZipReferenceSyntax,
  neutralizeUntrustedClipReferenceSyntax
} from '$lib/utils/zipReferenceSafety'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'
import { resolveRedisConnectionUrl } from '$lib/server/redisConnection'
import {
  JSON_COMPARE_AND_WRITE_SCRIPT,
  jsonTextOf,
  readJsonCompareAndWriteAnswer
} from '$lib/server/redisJsonCompareAndWrite'
import {
  DELETE_N8N_TOKEN_SCRIPT,
  MOVE_LEGACY_N8N_TOKEN_SCRIPT,
  readLegacyN8nTokenMoveAnswer,
  readN8nTokenDeleteAnswer,
  type LegacyN8nTokenMoveAnswer,
  type N8nTokenDeleteAnswer
} from '$lib/server/n8nCredentialScripts'
import {
  normalizeUploadUrlsForStorageInPayload,
  resolveUploadUrlsForBrowserInPayload
} from '$lib/server/services/batshitServerUrls'
import { keepAnsweredApprovals } from '$lib/server/services/toolApprovalState'
// BL-4: a leaf with no imports of its own, so the approval gates' import walk through this
// facade gains that one file and nothing behind it (`jevNeverApproves.pinning.test.ts`).
import { filterQueuedSendMessageIds } from '$lib/server/services/queuedSendHiddenIds'
import {
  collectGoonGuardedReferences,
  CUSTOM_GOON_UPLOAD_GUARD_LUA
} from '$lib/server/services/goonCustomAssetOwnership.server'

const STORE_SETTINGS_WITH_CUSTOM_GOON_REFS_SCRIPT = `${CUSTOM_GOON_UPLOAD_GUARD_LUA}
if not customGoonUploadsAvailable(ARGV[2]) then
  return 'ASSET_UNAVAILABLE'
end
redis.call('JSON.SET', KEYS[1], '$', ARGV[1])
return 'STORED'
`

/**
 * BL-195: `saveMessage`'s write. The save reads the stored record first (to keep what the
 * server already wrote), then writes the whole record; a move that lands between the two
 * (`MOVE_MESSAGE_TO_END_SCRIPT`) dated the message now, and the save's write put the old date
 * back. This keeps the date stored at the moment of the write, so a message keeps its first
 * `created_at` unless a move changes it. KEYS: the message record. ARGV: the record as JSON,
 * then the `created_at` the save read.
 */
const SAVE_MESSAGE_KEEPING_CREATED_AT_SCRIPT = `
-- BL-1302: only the authenticated browser routes supply ARGV[3]/KEYS[2]. Internal
-- promotion, approval, reply and restore writers retain their normal trusted semantics.
local browser = ARGV[3] and ARGV[3] ~= ''
local protectedKeys = {steerPromoted = true, waitsForApproval = true, approvalCardExpired = true}
local preservedMetadata = {}
-- RedisJSON quoted names escape ONLY quotes/backslashes (agentRecordOpPath's
-- measured contract). cjson.encode adds invalid slash/control-character escapes.
local function quotedPathName(name)
  local escaped = string.gsub(name, string.char(92), string.char(92, 92))
  escaped = string.gsub(escaped, string.char(34), string.char(92, 34))
  return '["' .. escaped .. '"]'
end
if browser then
  local policy = cjson.decode(ARGV[3])
  if redis.call('EXISTS', KEYS[2]) == 0 then return 'MISSING_SESSION' end
  if redis.call('JSON.TYPE', KEYS[2], '$')[1] ~= 'object' then return 'FORBIDDEN' end
  local session = cjson.decode(redis.call('JSON.GET', KEYS[2]))
  if session.user_id ~= policy.userId then return 'FORBIDDEN' end
  local exists = redis.call('EXISTS', KEYS[1]) == 1
  if exists ~= policy.expectedExists then
    if exists then return 'CHANGED_MESSAGE' else return 'MISSING_MESSAGE' end
  end
  local incoming = cjson.decode(ARGV[1])
  local function owned(record)
    return record.id == policy.messageId and record.session_id == policy.sessionId
      and record.user_id == policy.userId and record.role == 'user'
  end
  if not owned(incoming) then return 'FORBIDDEN' end
  if exists then
    if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return 'FORBIDDEN' end
    local current = cjson.decode(redis.call('JSON.GET', KEYS[1]))
    if not owned(current) then return 'FORBIDDEN' end
    -- JSONPath returns [] for absent markers. Legacy JSON.GET paths throw when absent.
    -- POST merges CURRENT unprovided siblings; PUT replaces ordinary metadata. In both,
    -- the protected three always belong to the stored record, never the browser payload.
    if redis.call('JSON.TYPE', KEYS[1], '$.metadata')[1] == 'object' then
      local incomingKeys = {}
      if policy.mergeMetadataKeys then
        for _, key in ipairs(policy.mergeMetadataKeys) do incomingKeys[key] = true end
      end
      for key, _ in pairs(current.metadata) do
        if protectedKeys[key] or (policy.mergeMetadataKeys and not incomingKeys[key]) then
          local path = '$["metadata"]' .. quotedPathName(key)
          local raw = redis.call('JSON.GET', KEYS[1], path)
          preservedMetadata[path] = string.sub(raw, 2, -2)
        end
      end
    end
  end
end
local stored = nil
if redis.call('EXISTS', KEYS[1]) == 1 then
  stored = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.created_at'))[1]
end
redis.call('JSON.SET', KEYS[1], '$', ARGV[1])
if browser then
  if redis.call('JSON.TYPE', KEYS[1], '$.metadata')[1] ~= 'object' then
    redis.call('JSON.SET', KEYS[1], '$.metadata', '{}')
  end
  for key, _ in pairs(protectedKeys) do
    redis.call('JSON.DEL', KEYS[1], '$.metadata.' .. key)
  end
  for path, raw in pairs(preservedMetadata) do
    redis.call('JSON.SET', KEYS[1], path, raw)
  end
end
if type(stored) == 'string' and stored ~= '' and stored ~= ARGV[2] then
  redis.call('JSON.SET', KEYS[1], '$.created_at', cjson.encode(stored))
end
return 'OK'
`

/**
 * BL-195: `moveMessageToEnd` in one step on the server, so nothing lands between its check and
 * its write. A message or chat that is gone answers nil and nothing changes; before this, a
 * message deleted between the read and the MULTI left its id on the list with no record. The
 * date is written first, so a record of the wrong type fails before the list is touched.
 * KEYS: the session, the message record, the chat's message list. ARGV: the message id, then
 * the new `created_at` as JSON. Answers the moved record as JSON.
 */
const MOVE_MESSAGE_TO_END_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then
  return false
end
redis.call('JSON.SET', KEYS[2], '$.created_at', ARGV[2])
redis.call('LREM', KEYS[3], 0, ARGV[1])
redis.call('RPUSH', KEYS[3], ARGV[1])
return redis.call('JSON.GET', KEYS[2])
`

/**
 * BL-622 (C1, C2): a Compact adds its one event to the chat's record at its own path, only while
 * the chat's last event is still the one the Compact read before its summary call. The block a
 * Compact read is never written back: that erased whatever another writer put into the chat's
 * metadata during the summary call. KEYS: the chat record. ARGV: the event as JSON, the last
 * event id the Compact read (`''` for none), a new `contextCompaction` block holding only this
 * event as JSON, and `last_modified_at` as JSON. The last event is the last one the readers count
 * (`getContextCompactionState`: an object with a string `id`, `createdAt` and `summary`, and a
 * `sourceMessageIds` list, asked of JSON.TYPE because Lua reads a JSON list and a JSON object as
 * the same table). Answers `MISSING`, `CHANGED:<last id>`, or the stored block as JSON.
 */
const APPEND_CONTEXT_COMPACTION_EVENT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
local eventsType = redis.call('JSON.TYPE', KEYS[1], '$.metadata.contextCompaction.events')[1]
local lastId = ''
if eventsType == 'array' then
  local events = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.metadata.contextCompaction.events'))[1]
  for index = #events, 1, -1 do
    local event = events[index]
    if type(event) == 'table' and type(event.id) == 'string' and type(event.createdAt) == 'string'
      and type(event.summary) == 'string'
      and redis.call('JSON.TYPE', KEYS[1], '$.metadata.contextCompaction.events[' .. (index - 1) .. '].sourceMessageIds')[1] == 'array' then
      lastId = event.id
      break
    end
  end
end
if lastId ~= ARGV[2] then
  return 'CHANGED:' .. lastId
end
if eventsType == 'array' then
  redis.call('JSON.ARRAPPEND', KEYS[1], '$.metadata.contextCompaction.events', ARGV[1])
else
  if redis.call('JSON.TYPE', KEYS[1], '$.metadata')[1] ~= 'object' then
    redis.call('JSON.SET', KEYS[1], '$.metadata', '{}')
  end
  redis.call('JSON.SET', KEYS[1], '$.metadata.contextCompaction', ARGV[3])
end
redis.call('JSON.SET', KEYS[1], '$.last_modified_at', ARGV[4])
return redis.call('JSON.GET', KEYS[1], '$.metadata.contextCompaction')
`

/**
 * BL-690: the generic update of a chat writes only the fields a browser may change, each by path,
 * in one step inside Redis. KEYS: the chat record. ARGV[1]: `last_modified_at` as JSON. ARGV[2]:
 * `keep`, `remove`, or the chat's new `metadata.group_chat` as JSON. ARGV[3..]: pairs of a
 * top-level field name (the route's allow list) and its value as JSON. Answers `MISSING` or `OK`.
 * `updateSession` runs it too, with `keep` and its caller's fields (BL-734).
 */
const UPDATE_SESSION_FIELDS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
for index = 3, #ARGV, 2 do
  redis.call('JSON.SET', KEYS[1], '$.' .. ARGV[index], ARGV[index + 1])
end
if ARGV[2] ~= 'keep' then
  if redis.call('JSON.TYPE', KEYS[1], '$.metadata')[1] ~= 'object' then
    redis.call('JSON.SET', KEYS[1], '$.metadata', '{}')
  end
  if ARGV[2] == 'remove' then
    redis.call('JSON.DEL', KEYS[1], '$.metadata.group_chat')
  else
    redis.call('JSON.SET', KEYS[1], '$.metadata.group_chat', ARGV[2])
  end
end
redis.call('JSON.SET', KEYS[1], '$.last_modified_at', ARGV[1])
return 'OK'
`

/**
 * The ops loop `UPDATE_AGENT_FIELDS_SCRIPT` and `UPDATE_SUBAGENT_FIELDS_SCRIPT` share (BL-914):
 * ARGV[1] is the plan's ops as JSON, entries `['ensure', path]` (make the path an object when it is
 * not one), `['set', path, valueAsJson]`, `['del', path]`, and `['delnull', path]` (remove the
 * path only while it holds null), run in order. The default lane's twin is `applyRecordOpsTwin`
 * (`test-utils/agentUpdateScriptTwin.ts`).
 */
const APPLY_RECORD_OPS_LUA = `for _, entry in ipairs(cjson.decode(ARGV[1])) do
  local kind = entry[1]
  local path = entry[2]
  if kind == 'ensure' then
    if redis.call('JSON.TYPE', KEYS[1], path)[1] ~= 'object' then
      redis.call('JSON.SET', KEYS[1], path, '{}')
    end
  elseif kind == 'set' then
    redis.call('JSON.SET', KEYS[1], path, entry[3])
  elseif kind == 'del' then
    redis.call('JSON.DEL', KEYS[1], path)
  elseif kind == 'delnull' then
    if redis.call('JSON.TYPE', KEYS[1], path)[1] == 'null' then
      redis.call('JSON.DEL', KEYS[1], path)
    end
  end
end`

/**
 * BL-768: an agent update's by-path writes, in one step inside Redis. KEYS: the agent record.
 * ARGV (`agentUpdateScriptArguments` in `agentRecordUpdate.ts`): [1] the ops as JSON, entries
 * `['ensure', path]` (make the path an object when it is not one), `['set', path, valueAsJson]`,
 * `['del', path]`, and `['delnull', path]` (remove the path only while it holds null); [2] the
 * `agentType` rule, `set`, `auto` or `derive`; [3] the type to write, as JSON; [4] the caller's read
 * of the type fields: each path's own `JSON.GET` answer, joined by line breaks (one `JSON.GET` of
 * many paths answers them in a random order, measured on Redis 8.10.1); [5] the memory guard, `''`
 * or JSON `{ paths, snapshot }` (BL-1294); [6..] the type paths.
 *
 * The memory guard is checked first: a save of the memory settings writes only while each memory
 * path still answers what the caller read when it compared the save's base (`expectedMemory`),
 * else it answers `MEMORY_CHANGED`. `agentType` (review of wave 2, item 1) is decided HERE, from the
 * record as it is now: `set` writes it; `auto` leaves a canonical stored type alone (a type worked
 * out from an earlier read wrote an old type back over a change made since); a legacy or
 * non-canonical stored type, and `derive`, write the worked-out type only while the type fields
 * still read as ARGV[4], else answer `TYPE_CHANGED`. Every read comes before the first write, so
 * `MISSING`, `MEMORY_CHANGED` and `TYPE_CHANGED` write nothing, and a key that is not JSON fails on
 * its first command. Answers `MISSING`, `MEMORY_CHANGED`, `TYPE_CHANGED` or `OK`.
 */
const UPDATE_AGENT_FIELDS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
if ARGV[5] ~= '' then
  local guard = cjson.decode(ARGV[5])
  local memory = {}
  for _, path in ipairs(guard.paths) do
    memory[#memory + 1] = redis.call('JSON.GET', KEYS[1], path)
  end
  if table.concat(memory, string.char(10)) ~= guard.snapshot then
    return 'MEMORY_CHANGED'
  end
end
local writeType = ARGV[2] == 'set'
if not writeType then
  local stored = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.agentType'))[1]
  if ARGV[2] == 'derive' or not (stored == 'api' or stored == 'cli' or stored == 'n8n') then
    local fields = {}
    for index = 6, #ARGV do
      fields[#fields + 1] = redis.call('JSON.GET', KEYS[1], ARGV[index])
    end
    if table.concat(fields, string.char(10)) ~= ARGV[4] then
      return 'TYPE_CHANGED'
    end
    writeType = true
  end
end
if writeType then
  redis.call('JSON.SET', KEYS[1], '$.agentType', ARGV[3])
end
${APPLY_RECORD_OPS_LUA}
return 'OK'
`

/** How many times `updateAgent` works a changing type out again before it gives up (writing nothing). */
const AGENT_UPDATE_TYPE_TRIES = 3

/**
 * BL-914: a Subagent update's by-path writes, in one step inside Redis. KEYS: the Subagent record.
 * ARGV[1]: the plan's ops as JSON (`planSubagentRecordUpdate`, `serializeAgentRecordPlan`), run by
 * `APPLY_RECORD_OPS_LUA`. There is no type rule: the type fields are written only as ops, when the
 * request names them. The existence check comes before the first write, so `MISSING` writes
 * nothing and a Subagent deleted meanwhile is not made again; a key that is not JSON fails on its
 * first command. Answers `MISSING` or `OK`.
 */
const UPDATE_SUBAGENT_FIELDS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
${APPLY_RECORD_OPS_LUA}
return 'OK'
`

/**
 * BL-770 (`GET /api/agents/[id]/fix`): an agent record stored as a JSON STRING becomes a RedisJSON
 * record, only while it is still the same string. A string key cannot take a JSON write, so the
 * key is removed and written again, in one step inside Redis. KEYS: the agent record. ARGV[1]: the
 * string the route read. ARGV[2]: the record as JSON. Answers `CHANGED` (nothing written) or `OK`.
 */
const REPLACE_STRING_AGENT_RECORD_SCRIPT = `
if redis.call('TYPE', KEYS[1])['ok'] ~= 'string' or redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 'CHANGED'
end
redis.call('DEL', KEYS[1])
redis.call('JSON.SET', KEYS[1], '$', ARGV[2])
return 'OK'
`

/**
 * BL-723: a regular chat's graduation mark (`metadata.memoryGraduation`) is written at its own
 * path, in one step inside Redis. The graduation used to read the chat and write that copy's
 * whole metadata back, erasing a Compact event or any other block written in between. The new
 * segment id is added to the list as stored now (the last 100 kept), never to a list read
 * earlier. BL-737: the write is a COMPARE-AND-SET on `lastGraduatedMessageId`, the id this
 * graduation read at its OWN start (`tailStart` above is really keyed on that id's position in
 * the message list, never on any message's timestamp) — ARGV[5], empty when the graduation read
 * no mark at all. It writes only while the stored `lastGraduatedMessageId` still equals ARGV[5];
 * anything else (another graduation's write landed first, or a mark now exists that didn't before)
 * answers `SUPERSEDED` and changes nothing. This settles two graduations racing each other (an
 * idle timer and a session-close, say): both read the same old id, the first write's CAS matches
 * and wins, the second's CAS no longer matches and it answers `SUPERSEDED` — and never gets stuck
 * the way a "moves forward only" ordering check did (BL-737's own bug): a graduation that reads a
 * mark whose message was since deleted just reads the CURRENT stored id and its CAS matches. KEYS:
 * the chat record. ARGV[1]: `last_modified_at` as JSON. ARGV[2]: the last graduated message id as
 * JSON. ARGV[3]: the graduation time as JSON. ARGV[4]: the segment id as JSON. ARGV[5]: the id
 * this graduation read as its starting mark, a bare string (empty string means "no mark read").
 * A STORED `lastGraduatedMessageId` that is itself an empty string reads as "no mark" too — the
 * same sentinel, not a real id to CAS against — so a mark that was ever written with one never
 * gets stuck permanently answering `SUPERSEDED` against every future "no mark read" caller.
 * ARGV[6]: a whole new mark holding only this segment as JSON (for a chat with no mark object
 * yet). Answers `MISSING` (chat gone), `SUPERSEDED`, `SUPERSEDED_LINKED`, or `OK`. BL-737 review:
 * a CAS loser whose own segment (ARGV[4]) is ALREADY in the stored, winning mark's `segmentIds` —
 * the winner reused it — answers `SUPERSEDED_LINKED` instead of plain `SUPERSEDED`, so the caller
 * knows not to delete a segment the winner just linked in.
 */
const WRITE_REGULAR_GRADUATION_MARK_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
if redis.call('JSON.TYPE', KEYS[1], '$.metadata')[1] ~= 'object' then
  redis.call('JSON.SET', KEYS[1], '$.metadata', '{}')
end
local hasMark = redis.call('JSON.TYPE', KEYS[1], '$.metadata.memoryGraduation')[1] == 'object'
local storedId = false
if hasMark and redis.call('JSON.TYPE', KEYS[1], '$.metadata.memoryGraduation.lastGraduatedMessageId')[1] == 'string' then
  local decodedStoredId = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.metadata.memoryGraduation.lastGraduatedMessageId'))[1]
  if decodedStoredId ~= '' then
    storedId = decodedStoredId
  end
end
local function supersededAnswer()
  if hasMark and redis.call('JSON.TYPE', KEYS[1], '$.metadata.memoryGraduation.segmentIds')[1] == 'array' then
    local storedSegmentIds = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.metadata.memoryGraduation.segmentIds'))[1]
    local thisSegmentId = cjson.decode(ARGV[4])
    for _, storedSegmentId in ipairs(storedSegmentIds) do
      if storedSegmentId == thisSegmentId then
        return 'SUPERSEDED_LINKED'
      end
    end
  end
  return 'SUPERSEDED'
end
local expected = ARGV[5]
if expected == '' then
  if storedId ~= false then
    return supersededAnswer()
  end
elseif storedId ~= expected then
  return supersededAnswer()
end
if not hasMark then
  redis.call('JSON.SET', KEYS[1], '$.metadata.memoryGraduation', ARGV[6])
  redis.call('JSON.SET', KEYS[1], '$.last_modified_at', ARGV[1])
  return 'OK'
end
redis.call('JSON.SET', KEYS[1], '$.metadata.memoryGraduation.version', '1')
redis.call('JSON.SET', KEYS[1], '$.metadata.memoryGraduation.lastGraduatedMessageId', ARGV[2])
redis.call('JSON.SET', KEYS[1], '$.metadata.memoryGraduation.lastGraduatedAt', ARGV[3])
if redis.call('JSON.TYPE', KEYS[1], '$.metadata.memoryGraduation.segmentIds')[1] == 'array' then
  local length = redis.call('JSON.ARRAPPEND', KEYS[1], '$.metadata.memoryGraduation.segmentIds', ARGV[4])[1]
  if length > 100 then
    redis.call('JSON.ARRTRIM', KEYS[1], '$.metadata.memoryGraduation.segmentIds', length - 100, length - 1)
  end
else
  redis.call('JSON.SET', KEYS[1], '$.metadata.memoryGraduation.segmentIds', '[' .. ARGV[4] .. ']')
end
redis.call('JSON.SET', KEYS[1], '$.last_modified_at', ARGV[1])
return 'OK'
`

/**
 * BL-736: a Group delete removes a chat's `metadata.group_chat` only while it still names the
 * Group being deleted — checked and written in one step inside Redis, closing the gap between
 * the delete route's read of every chat and this per-chat write, in which the chat can be moved to
 * a DIFFERENT Group. The unconditional `remove` path of `updateSessionFields` stays as it is for
 * the user's own "take this chat out of its Group" action, where there is no such gap to close.
 * KEYS: the chat record. ARGV[1]: `last_modified_at` as JSON. ARGV[2]: the Group id being deleted,
 * a bare string (a `$.`-prefixed JSON.GET always answers a JSON ARRAY, `["id"]`, never a bare
 * quoted scalar, so the stored value is decoded with cjson before comparing). Answers `MISSING`
 * (chat gone), `CHANGED` (the chat no longer names this Group — nothing written), or `OK`.
 */
const CLEAR_GROUP_CHAT_IF_MATCHES_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
if redis.call('JSON.TYPE', KEYS[1], '$.metadata.group_chat.group_id')[1] ~= 'string' then
  return 'CHANGED'
end
local stored = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.metadata.group_chat.group_id'))[1]
if stored ~= ARGV[2] then
  return 'CHANGED'
end
redis.call('JSON.DEL', KEYS[1], '$.metadata.group_chat')
redis.call('JSON.SET', KEYS[1], '$.last_modified_at', ARGV[1])
return 'OK'
`

/**
 * BL-474 step 2: one write of a reply's stored image-origin record (`imageAddressOrigins.ts`), in one
 * step inside Redis. It checks the chat and its owner, and for a decided record the reply itself (an
 * assistant message of this chat and user), so a write after a delete never brings a key back. It
 * writes only when the stored record is not newer: an older end never writes over a newer one, and a
 * pending write never replaces a decided record of the same version. KEYS: the chat, the reply, the
 * chat's index set, the record. ARGV: user id, chat id, reply id, version, state, record JSON.
 * Answers `OK`, `MISSING_CHAT`, `NOT_OWNER`, `MISSING_REPLY`, `NOT_REPLY`, `OLDER`, or `KEPT`.
 */
const WRITE_IMAGE_ORIGIN_SCRIPT = `
-- BATSHIT_IMAGE_ORIGIN_WRITE_V1
-- Validate the serialized body against the separately passed identity before touching Redis.
local record = cjson.decode(ARGV[6])
if type(record) ~= 'table' or record.messageId ~= ARGV[3] or record.state ~= ARGV[5]
  or type(record.version) ~= 'number' or record.version ~= tonumber(ARGV[4]) then
  return redis.error_reply('Image origin record does not match write arguments')
end
local indexType = redis.call('TYPE', KEYS[3]).ok
if indexType ~= 'none' and indexType ~= 'set' then
  return redis.error_reply('Image origin index has the wrong type')
end
local itemType = redis.call('TYPE', KEYS[4]).ok
if itemType ~= 'none' and itemType ~= 'ReJSON-RL' then
  return redis.error_reply('Image origin record has the wrong type')
end
local function field(key, path)
  local raw = redis.call('JSON.GET', key, path)
  if not raw then return nil end
  local values = cjson.decode(raw)
  return values[1]
end
if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING_CHAT' end
if field(KEYS[1], '$.user_id') ~= ARGV[1] then return 'NOT_OWNER' end
if ARGV[5] == 'decided' then
  if redis.call('EXISTS', KEYS[2]) == 0 then return 'MISSING_REPLY' end
  if field(KEYS[2], '$.role') ~= 'assistant' or field(KEYS[2], '$.session_id') ~= ARGV[2]
    or field(KEYS[2], '$.id') ~= ARGV[3] or field(KEYS[2], '$.user_id') ~= ARGV[1] then
    return 'NOT_REPLY'
  end
end
if itemType == 'ReJSON-RL' then
  local previous = field(KEYS[4], '$.version')
  local version = tonumber(ARGV[4])
  if type(previous) == 'number' then
    if previous > version then return 'OLDER' end
    if previous == version and ARGV[5] == 'pending' and field(KEYS[4], '$.state') == 'decided' then
      return 'KEPT'
    end
  end
end
redis.call('JSON.SET', KEYS[4], '$', ARGV[6])
redis.call('SADD', KEYS[3], ARGV[3])
return 'OK'
`

export type ImageOriginWriteAnswer =
  | 'ok'
  | 'missing_chat'
  | 'not_owner'
  | 'missing_reply'
  | 'not_reply'
  | 'older'
  | 'kept'

/**
 * BL-735: the Infinite Session transition writes its two owned fields at their own path, in one
 * step inside Redis: `metadata.fixedSession` and the top-level `locked` auto-lock. The route used
 * to read the chat and write that copy's whole metadata back, erasing a Compact event or any other
 * block written while the route's own reads (the ownership check, the message-history look) were
 * in flight. Every other stored field and metadata block stays. KEYS: the chat record. ARGV[1]:
 * `last_modified_at` as JSON. ARGV[2]: the `fixedSession` block as JSON. Answers `MISSING` or `OK`.
 */
const WRITE_FIXED_SESSION_MARK_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
if redis.call('JSON.TYPE', KEYS[1], '$.metadata')[1] ~= 'object' then
  redis.call('JSON.SET', KEYS[1], '$.metadata', '{}')
end
redis.call('JSON.SET', KEYS[1], '$.metadata.fixedSession', ARGV[2])
redis.call('JSON.SET', KEYS[1], '$.locked', 'true')
redis.call('JSON.SET', KEYS[1], '$.last_modified_at', ARGV[1])
return 'OK'
`

/**
 * BL-549 (N4): a nap or dreaming adds one graduation event to an Infinite Session's window
 * (`metadata.fixedSession.graduation.events`) at its own path, in one step inside Redis. The
 * writer used to read the chat and write that copy's whole metadata back, erasing a Compact
 * event, another graduation event, or any other block written in between. JSON.ARRAPPEND adds to
 * the list as stored now, so two appends at once both stay. KEYS: the chat record. ARGV: the
 * event as JSON, a whole `graduation` block holding only this event as JSON (for a chat with no
 * event list yet), and `last_modified_at` as JSON. Answers `MISSING`, `NOT_FIXED` (not an
 * Infinite Session: `metadata.fixedSession.enabled` is not true), or `OK`.
 */
const APPEND_FIXED_SESSION_GRADUATION_EVENT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
if redis.call('JSON.TYPE', KEYS[1], '$.metadata.fixedSession.enabled')[1] ~= 'boolean'
  or redis.call('JSON.GET', KEYS[1], '$.metadata.fixedSession.enabled') ~= '[true]' then
  return 'NOT_FIXED'
end
if redis.call('JSON.TYPE', KEYS[1], '$.metadata.fixedSession.graduation.events')[1] == 'array' then
  redis.call('JSON.ARRAPPEND', KEYS[1], '$.metadata.fixedSession.graduation.events', ARGV[1])
else
  redis.call('JSON.SET', KEYS[1], '$.metadata.fixedSession.graduation', ARGV[2])
end
redis.call('JSON.SET', KEYS[1], '$.last_modified_at', ARGV[3])
return 'OK'
`

/**
 * BL-549 (N4): dreaming's era swap replaces some graduation events with one era event, at the
 * event list's own path, in one step inside Redis, and only while every event it replaces is
 * still in the list (the condition on what it read: the era summary was made from exactly those
 * events). Events another writer added meanwhile, and every other metadata block, stay. The list
 * is never re-encoded from Lua (cjson turns an empty list into an object): each replaced event is
 * deleted by its index, last first, and the era event (encoded once, by the caller) is inserted
 * where the first replaced one was. KEYS: the chat record. ARGV[1]: the era event as JSON.
 * ARGV[2]: `last_modified_at` as JSON. ARGV[3..]: the ids of the events to replace. Answers
 * `MISSING`, `NOT_FIXED`, `CHANGED:<missing ids, comma-separated>`, or `OK`.
 */
const SWAP_FIXED_SESSION_GRADUATION_EVENTS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
if redis.call('JSON.TYPE', KEYS[1], '$.metadata.fixedSession.enabled')[1] ~= 'boolean'
  or redis.call('JSON.GET', KEYS[1], '$.metadata.fixedSession.enabled') ~= '[true]' then
  return 'NOT_FIXED'
end
local path = '$.metadata.fixedSession.graduation.events'
local events = {}
if redis.call('JSON.TYPE', KEYS[1], path)[1] == 'array' then
  events = cjson.decode(redis.call('JSON.GET', KEYS[1], path))[1]
end
local wanted = {}
for index = 3, #ARGV do
  wanted[ARGV[index]] = true
end
local found = {}
local indexes = {}
for index = 1, #events do
  local event = events[index]
  if type(event) == 'table' and type(event.id) == 'string' and wanted[event.id] then
    found[event.id] = true
    indexes[#indexes + 1] = index - 1
  end
end
local missing = {}
for index = 3, #ARGV do
  if not found[ARGV[index]] then
    missing[#missing + 1] = ARGV[index]
  end
end
if #missing > 0 then
  return 'CHANGED:' .. table.concat(missing, ',')
end
for position = #indexes, 1, -1 do
  redis.call('JSON.DEL', KEYS[1], path .. '[' .. indexes[position] .. ']')
end
redis.call('JSON.ARRINSERT', KEYS[1], path, indexes[1], ARGV[1])
redis.call('JSON.SET', KEYS[1], '$.last_modified_at', ARGV[2])
return 'OK'
`

/**
 * BL-549 (N4): a nap adds its record to the chat's nap history (`metadata.fixedSession.naps`,
 * the last `limit` kept) at its own path, in one step inside Redis, instead of writing back a
 * copy of the whole metadata. KEYS: the chat record. ARGV: the record as JSON, the list limit,
 * and `last_modified_at` as JSON. A missing `metadata` or `fixedSession` object is created (the
 * old writer did the same). Answers `MISSING`, or the stored `metadata` as JSON.
 */
const APPEND_FIXED_SESSION_NAP_RECORD_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
if redis.call('JSON.TYPE', KEYS[1], '$.metadata')[1] ~= 'object' then
  redis.call('JSON.SET', KEYS[1], '$.metadata', '{}')
end
if redis.call('JSON.TYPE', KEYS[1], '$.metadata.fixedSession')[1] ~= 'object' then
  redis.call('JSON.SET', KEYS[1], '$.metadata.fixedSession', '{}')
end
local limit = tonumber(ARGV[2])
if redis.call('JSON.TYPE', KEYS[1], '$.metadata.fixedSession.naps')[1] == 'array' then
  local length = redis.call('JSON.ARRAPPEND', KEYS[1], '$.metadata.fixedSession.naps', ARGV[1])[1]
  if length > limit then
    redis.call('JSON.ARRTRIM', KEYS[1], '$.metadata.fixedSession.naps', length - limit, length - 1)
  end
else
  redis.call('JSON.SET', KEYS[1], '$.metadata.fixedSession.naps', '[' .. ARGV[1] .. ']')
end
redis.call('JSON.SET', KEYS[1], '$.last_modified_at', ARGV[3])
return redis.call('JSON.GET', KEYS[1], '$.metadata')
`

/** What `appendContextCompactionEvent` answers. */
export type ContextCompactionEventWrite =
  | { ok: true; contextCompaction: { version: 1; events: unknown[] } & Record<string, unknown> }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'changed'; lastEventId: string | null }

async function storeUserSettingsForClient(
  client: RedisClientType,
  userId: string,
  settings: UserSettingsRow
) {
  const settingsKey = `user:${userId}:settings`
  // A legacy Goons settings object can carry custom upload refs at any depth.
  // Check their metadata and deletion/restore claims in the same EVAL that
  // publishes the final settings value, so a reservation cannot slip between
  // a preflight check and this whole-record write.
  const customUploadKeys = await collectGoonGuardedReferences(settings.goons_settings, userId)
  if (customUploadKeys.length === 0) {
    await client.json.set(settingsKey, '$', settings as any)
    return
  }
  const result = await client.eval(STORE_SETTINGS_WITH_CUSTOM_GOON_REFS_SCRIPT, {
    keys: [settingsKey],
    arguments: [JSON.stringify(settings), JSON.stringify(customUploadKeys)]
  })
  if (result === 'ASSET_UNAVAILABLE') {
    throw Object.assign(new Error('Custom Goon asset is unavailable'), {
      code: 'ASSET_UNAVAILABLE', status: 409
    })
  }
  if (result !== 'STORED') throw new Error(`Settings write failed: ${String(result)}`)
}

async function resolveRuntimeRedisUrl(): Promise<string> {
  return resolveRedisConnectionUrl({
    REDIS_URL: await getRuntimeEnv('REDIS_URL'),
    REDIS_HOST: await getRuntimeEnv('REDIS_HOST'),
    REDIS_PORT: await getRuntimeEnv('REDIS_PORT'),
    REDIS_DB: await getRuntimeEnv('REDIS_DB')
  })
}

// Every port a real Batshit Redis can listen on across install types (developer
// default, Mac app, Pinokio, and isolated smoke/first-run test instances). The
// memory-search test escape below must never match them.
const BATSHIT_KNOWN_RUNTIME_REDIS_PORTS = new Set(['6379', '5639', '5659', '6380', '5649'])

function isDesignatedMemorySearchTestUrl(redisUrl: string): boolean {
  if (process.env.VITEST_MEMORY_SEARCH !== 'true') return false
  const designated = process.env.MEMORY_TEST_REDIS_URL?.trim()
  if (!designated || redisUrl !== designated) return false
  try {
    const port = new URL(redisUrl).port || '6379'
    return !BATSHIT_KNOWN_RUNTIME_REDIS_PORTS.has(port)
  } catch {
    return false
  }
}

function isProjectPreferences(value: unknown): value is ProjectPreferences {
  if (!value || typeof value !== 'object') return false
  const prefs = value as Partial<ProjectPreferences>
  return (
    typeof prefs.user_id === 'string' &&
    typeof prefs.created_at === 'string' &&
    typeof prefs.updated_at === 'string'
  )
}

/**
 * The fields a zip claim can live in (`zipClaimsOfMessage`), read for each message id with
 * `JSON.MGET` in batches of 200, never the whole record. JSON.MGET answers null for a missing key
 * AND for a key that is not JSON: a missing message claims nothing; one that exists but cannot be
 * read might claim a zip, so the caller stops with `unreadable` and writes nothing (BL-390).
 */
async function readZipClaimFieldsOfMessages(
  client: RedisClientType,
  sessionId: string,
  ids: string[],
  unreadable: string
): Promise<unknown[]> {
  const messages: unknown[] = []
  for (let index = 0; index < ids.length; index += 200) {
    const batch = ids.slice(index, index + 200)
    const keys = batch.map((id) => `message:${sessionId}:${id}`)
    const contents = await client.json.mGet(keys, '$.content')
    const zipIds = await client.json.mGet(keys, '$.metadata.zipIds')
    const zipIdsSnake = await client.json.mGet(keys, '$.metadata.zip_ids')
    const zipReferences = await client.json.mGet(keys, '$.metadata.zipReferences')
    for (let offset = 0; offset < batch.length; offset += 1) {
      if (contents[offset] == null) {
        if ((await client.exists(keys[offset])) > 0) throw new Error(unreadable)
        messages.push(null)
        continue
      }
      messages.push({
        content: firstJsonPathMatch(contents[offset]),
        metadata: {
          zipIds: firstJsonPathMatch(zipIds[offset]),
          zip_ids: firstJsonPathMatch(zipIdsSnake[offset]),
          zipReferences: firstJsonPathMatch(zipReferences[offset])
        }
      })
    }
  }
  return messages
}

/** One zip and its zip state, queued on a MULTI (BL-390, BL-537: a lost connection applies none). */
function queueZipRemoval(multi: ReturnType<RedisClientType['multi']>, sessionId: string, zipId: string) {
  multi.del(`zip:${zipId}`)
  multi.sRem(`session:${sessionId}:zips`, zipId)
  multi.del(`unzipped_item:${sessionId}:${zipId}`)
  multi.sRem(`unzipped:${sessionId}`, zipId)
  multi.del(`rezipped_item:${sessionId}:${zipId}`)
  multi.sRem(`rezipped:${sessionId}`, zipId)
}

export class RedisService {
  private static instances = new Set<RedisService>()
  private client: RedisClientType | null = null
  private connecting = false

  private parseTimestampMs(value?: string | null): number {
    if (!value) return 0
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : 0
  }

  private newestTimestamp(...values: Array<string | null | undefined>): string | undefined {
    let newest: string | undefined
    let newestMs = 0

    for (const value of values) {
      const time = this.parseTimestampMs(value)
      if (time > newestMs) {
        newest = value || undefined
        newestMs = time
      }
    }

    return newest
  }

  private sortFoldersForDisplay(folders: ChatFolderRow[]): ChatFolderRow[] {
    return folders.sort((a, b) => {
      if (a.is_default !== b.is_default) {
        return a.is_default ? -1 : 1
      }

      const activityDelta =
        Math.max(this.parseTimestampMs(b.last_used_at), this.parseTimestampMs(b.created_at)) -
        Math.max(this.parseTimestampMs(a.last_used_at), this.parseTimestampMs(a.created_at))
      if (activityDelta !== 0) return activityDelta

      const createdDelta = this.parseTimestampMs(b.created_at) - this.parseTimestampMs(a.created_at)
      if (createdDelta !== 0) return createdDelta

      const sortDelta = a.sort_order - b.sort_order
      if (sortDelta !== 0) return sortDelta

      return a.name.localeCompare(b.name)
    })
  }

  private async touchFolderLastUsed(
    client: any,
    userId: string | undefined,
    folderId: string | undefined,
    at: string = new Date().toISOString()
  ): Promise<void> {
    if (!userId || !folderId) return
    const folder = await client.json.get(`folder:${userId}:${folderId}`)
    if (!folder) return

    const folderData = folder as unknown as ChatFolderRow
    folderData.last_used_at = this.newestTimestamp(folderData.last_used_at, at) ?? at
    await client.json.set(`folder:${userId}:${folderId}`, '$', folderData as any)
  }

  constructor() {
    // Initialize connection on first use, then close it from the app runtime
    // shutdown hook so packaged Mac stops do not need SIGKILL escalation.
    RedisService.instances.add(this)
  }

  static async disconnectAll(): Promise<void> {
    await Promise.all(
      Array.from(RedisService.instances, (service) =>
        service.disconnect().catch((error) => {
          console.error('[Redis] Failed to disconnect Redis client during shutdown:', error)
        })
      )
    )
  }

  // Get or create Redis connection
  private async getClient(): Promise<RedisClientType> {
    if (this.client && this.client.isOpen) {
      return this.client
    }

    if (this.connecting) {
      // Wait for existing connection attempt
      while (this.connecting) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      if (this.client && this.client.isOpen) {
        return this.client
      }
    }

    this.connecting = true
    try {
      let redisUrl = await resolveRuntimeRedisUrl()

      // Test-safety: never allow Vitest to hit DB0. If no DB is specified,
      // or it points at /0, force it to DB15 so we don't wipe dev/prod data.
      //
      // Single narrow exception (SA-104, testing-architecture.md §3): the memory-search
      // test lane runs against a DEDICATED DISPOSABLE Redis whose db 0 it owns, because
      // FT.CREATE only works on db 0. The escape applies only when the lane env is on,
      // the URL is exactly the harness-designated MEMORY_TEST_REDIS_URL, and the port is
      // not one of Batshit's known runtime ports — real instances can never qualify.
      if (process.env.VITEST === 'true' && !isDesignatedMemorySearchTestUrl(redisUrl)) {
        const hasDb = /\/\d+$/.test(redisUrl)
        if (!hasDb) {
          redisUrl = `${redisUrl}/15`
        } else if (redisUrl.endsWith('/0')) {
          redisUrl = redisUrl.replace(/\/0$/, '/15')
        }

        // Keep the env mock in sync for any code that reads $env directly.
        process.env.REDIS_URL = redisUrl
        try {
          const envModule = await import('$env/dynamic/private')
          if (envModule?.env) {
            envModule.env.REDIS_URL = redisUrl
          }
        } catch {
          // ignore if env module not available yet
        }
      }

      const urlObj = new URL(redisUrl)
      const dbFromUrl = urlObj.pathname && urlObj.pathname !== '/' ? Number(urlObj.pathname.slice(1)) : undefined
      const database = Number.isInteger(dbFromUrl) ? dbFromUrl : undefined

      this.client = createClient({
        url: redisUrl,
        database,
        socket: {
          reconnectStrategy: (retries) => Math.min(retries * 50, 1000)
        }
      })

      this.client.on('error', (err) => {
        console.error('Redis client error:', err)
      })

      this.client.on('connect', () => {
        logger.debug('Redis client connected')
      })

      this.client.on('ready', () => {
        logger.debug('Redis client ready')
      })

      await this.client.connect()
      return this.client
    } finally {
      this.connecting = false
    }
  }

  // Helper to safely execute Redis commands
  async execute<T>(operation: (client: RedisClientType) => Promise<T>): Promise<T> {
    const client = await this.getClient()
    if (!client.isOpen) {
      console.error('[Redis.execute] Client is not connected!')
    }
    return operation(client)
  }

  // Helper to safely parse JSON - intelligently handles both JSON and plain strings
  // Note: This is now only used for mixed string/object keys like system prompts
  private safeJsonParse(data: any): any {
    if (!data) return null
    if (typeof data === 'string') {
      // Check if it looks like JSON (starts with { or [ after trimming)
      const trimmed = data.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
        try {
          return JSON.parse(data)
        } catch (error) {
          // If it fails to parse but looks like JSON, there's a real error
          console.error('Failed to parse JSON string:', error)
          // Return the string as-is for system prompts and other plain text
          return data
        }
      }
      // Doesn't look like JSON, return as plain string (e.g., system prompts)
      return data
    }
    // If it's already an object, return as-is
    return data
  }

  // ===== SESSIONS =====

  async getSessions(userId: string, includeArchived = false): Promise<ChatSessionRow[]> {
    return this.execute(async (client) => {
      // Get all session IDs for user
      const sessionIds = await client.sMembers(`user:${userId}:sessions`)
      
      if (sessionIds.length === 0) {
        return []
      }
      
      // Get all session data using RedisJSON
      const sessions: ChatSessionRow[] = []
      for (const sessionId of sessionIds) {
        try {
          const sessionData = await client.json.get(`session:${sessionId}`)
          if (sessionData) {
            const session = sessionData as unknown as ChatSessionRow
            if (!session.archived || includeArchived) {
              sessions.push(session)
            }
          }
        } catch (error) {
          logger.warn(`Failed to load session ${sessionId}:`, error)
        }
      }
      
      // Sort by last_modified_at descending
      sessions.sort((a, b) => {
        const dateA = new Date(a.last_modified_at || a.created_at).getTime()
        const dateB = new Date(b.last_modified_at || b.created_at).getTime()
        return dateB - dateA
      })
      
      return sessions
    })
  }

  async getSession(sessionId: string): Promise<ChatSessionRow | null> {
    return this.execute(async (client) => {
      try {
        const sessionData = await client.json.get(`session:${sessionId}`)
        if (!sessionData) return null
        
        return sessionData as unknown as ChatSessionRow
      } catch (error) {
        console.error('[getSession] Error:', error)
        return null
      }
    })
  }

  async createSession(session: Partial<ChatSessionRow>): Promise<ChatSessionRow> {
    return this.execute(async (client) => {
      // If no folder_id provided, get or create default folder
      let folderId = session.folder_id
      
      if (!folderId && session.user_id) {
        // Check for default folder
        const defaultFolderId = await client.get(`user:${session.user_id}:default_folder`)
        
        if (defaultFolderId) {
          folderId = defaultFolderId
        } else {
          // Create default folder if it doesn't exist
          const newDefaultFolderId = crypto.randomUUID()
          const now = new Date().toISOString()
          const defaultFolder = {
            id: newDefaultFolderId,
            user_id: session.user_id,
            name: 'My Chats',
            is_default: true,
            is_expanded: true,
            sort_order: 0,
            last_used_at: now,
            created_at: now
          }
          
          await client.json.set(`folder:${session.user_id}:${newDefaultFolderId}`, '$', defaultFolder)
          await client.sAdd(`user:${session.user_id}:folders`, newDefaultFolderId)
          await client.set(`user:${session.user_id}:default_folder`, newDefaultFolderId)
          
          folderId = newDefaultFolderId
        }
      }
      
      const sessionData: ChatSessionRow = {
        ...session,
        id: session.id!,
        folder_id: folderId,
        created_at: session.created_at || new Date().toISOString(),
        last_modified_at: session.last_modified_at || new Date().toISOString(),
        archived: false,
        locked: Boolean(session.locked)
      }
      
      // Store session using RedisJSON
      await client.json.set(`session:${sessionData.id}`, '$', sessionData as any)
      
      // Add to user's session list
      if (sessionData.user_id) {
        await client.sAdd(`user:${sessionData.user_id}:sessions`, sessionData.id)
        
        // Add session to folder's session set
        if (folderId) {
          await client.sAdd(`folder:${sessionData.user_id}:${folderId}:sessions`, sessionData.id)
          await this.touchFolderLastUsed(
            client,
            sessionData.user_id,
            folderId,
            sessionData.last_modified_at
          )
        }
      }
      
      // Create empty message list for this session
      await client.del(`messages:${sessionData.id}`)
      
      return sessionData
    })
  }

  /**
   * BL-734: write only the top-level fields the caller passed, each by path, and stamp
   * `last_modified_at`, in one step inside Redis (the BL-690 script, the group left alone). It
   * used to read the whole chat and write that copy back in a second round trip, erasing a
   * Compact event, a graduation mark, or any other block written in between. `undefined` skips a
   * field; `null` is written as null; a `metadata` passed replaces that one block. A chat that is
   * gone throws "Session not found" and is not recreated.
   */
  async updateSession(id: string, updates: Partial<ChatSessionRow>): Promise<void> {
    return this.execute(async (client) => {
      const now = new Date().toISOString()
      const pairs = Object.entries(updates).flatMap(([name, value]) => {
        if (!/^[a-z_]+$/.test(name)) throw new Error(`Not a chat field name: ${name}`)
        return value === undefined ? [] : [name, JSON.stringify(value)]
      })
      const answer = await client.eval(UPDATE_SESSION_FIELDS_SCRIPT, {
        keys: [`session:${id}`],
        arguments: [JSON.stringify(now), 'keep', ...pairs]
      })
      if (answer === 'MISSING') throw new Error('Session not found')
      if (answer !== 'OK') {
        throw new Error(`The update of session ${id} answered ${String(answer)}.`)
      }
      const session = (await client.json.get(`session:${id}`, {
        path: ['$.user_id', '$.folder_id']
      })) as Record<string, unknown[]> | null
      const userId = session?.['$.user_id']?.[0]
      const folderId = session?.['$.folder_id']?.[0]
      await this.touchFolderLastUsed(
        client,
        typeof userId === 'string' ? userId : undefined,
        typeof folderId === 'string' ? folderId : undefined,
        now
      )
    })
  }

  /**
   * BL-690: write the fields a browser may change, each by path, and the chat's group
   * (`groupChat`: an object sets `metadata.group_chat`, `null` removes it, `undefined` keeps it).
   * Every other stored field and metadata block stays. The route owns the allow list of `fields`.
   * `false` when the chat is gone: nothing is written.
   */
  async updateSessionFields(
    id: string,
    fields: Record<string, unknown>,
    groupChat: Record<string, unknown> | null | undefined
  ): Promise<boolean> {
    return this.execute(async (client) => {
      const now = new Date().toISOString()
      const pairs = Object.entries(fields).flatMap(([name, value]) => {
        if (!/^[a-z_]+$/.test(name)) throw new Error(`Not a chat field name: ${name}`)
        return [name, JSON.stringify(value ?? null)]
      })
      const answer = await client.eval(UPDATE_SESSION_FIELDS_SCRIPT, {
        keys: [`session:${id}`],
        arguments: [
          JSON.stringify(now),
          groupChat === undefined ? 'keep' : groupChat === null ? 'remove' : JSON.stringify(groupChat),
          ...pairs
        ]
      })
      if (answer === 'MISSING') return false
      const session = (await client.json.get(`session:${id}`, {
        path: ['$.user_id', '$.folder_id']
      })) as Record<string, unknown[]> | null
      const userId = session?.['$.user_id']?.[0]
      const folderId = session?.['$.folder_id']?.[0]
      await this.touchFolderLastUsed(
        client,
        typeof userId === 'string' ? userId : undefined,
        typeof folderId === 'string' ? folderId : undefined,
        now
      )
      return true
    })
  }

  /**
   * BL-723: write a regular chat's graduation mark at its own path, in one step inside Redis:
   * the last graduated message, its time, and the new segment id added to the stored list (the
   * last 100 kept). Every other metadata block and field stays as stored now. BL-737: the write
   * is a compare-and-set on `expectedLastGraduatedMessageId` — the id THIS graduation read as its
   * starting mark (`null` when it read none) — against the mark's CURRENT stored id, so two
   * graduations racing each other settle by whichever CAS lands first, and a graduation that
   * resumes after its old mark's message was deleted always reads and matches the current id.
   * `'missing'` when the chat is gone; `'superseded'` when the CAS did not match (another write
   * landed first, or a mark now exists that did not exist when this graduation started): neither
   * writes anything. `'superseded_linked'` is the same CAS loss, but the winning write already
   * carries THIS call's own `mark.segmentId` in its `segmentIds` (the winner reused it) — the
   * caller must not delete a segment the winner just linked in (BL-737 review).
   */
  async writeRegularGraduationMark(
    sessionId: string,
    mark: {
      lastGraduatedMessageId: string
      lastGraduatedAt: string
      segmentId: string
    },
    expectedLastGraduatedMessageId: string | null
  ): Promise<'ok' | 'superseded' | 'superseded_linked' | 'missing'> {
    return this.execute(async (client) => {
      const now = new Date().toISOString()
      const answer = await client.eval(WRITE_REGULAR_GRADUATION_MARK_SCRIPT, {
        keys: [`session:${sessionId}`],
        arguments: [
          JSON.stringify(now),
          JSON.stringify(mark.lastGraduatedMessageId),
          JSON.stringify(mark.lastGraduatedAt),
          JSON.stringify(mark.segmentId),
          expectedLastGraduatedMessageId ?? '',
          JSON.stringify({
            version: 1,
            lastGraduatedMessageId: mark.lastGraduatedMessageId,
            lastGraduatedAt: mark.lastGraduatedAt,
            segmentIds: [mark.segmentId]
          })
        ]
      })
      if (answer === 'MISSING') return 'missing'
      if (answer === 'SUPERSEDED') return 'superseded'
      if (answer === 'SUPERSEDED_LINKED') return 'superseded_linked'
      if (answer !== 'OK') {
        throw new Error(`The graduation mark write of session ${sessionId} answered ${String(answer)}.`)
      }
      const session = (await client.json.get(`session:${sessionId}`, {
        path: ['$.user_id', '$.folder_id']
      })) as Record<string, unknown[]> | null
      const userId = session?.['$.user_id']?.[0]
      const folderId = session?.['$.folder_id']?.[0]
      await this.touchFolderLastUsed(
        client,
        typeof userId === 'string' ? userId : undefined,
        typeof folderId === 'string' ? folderId : undefined,
        now
      )
      return 'ok'
    })
  }

  /**
   * BL-736: a Group delete removes a chat's `metadata.group_chat` only while it still names the
   * Group being deleted, checked and written in one step inside Redis. It used to be read (by the
   * delete route, before its loop) and removed unconditionally, so a chat moved to a DIFFERENT
   * Group in the gap between that read and this write lost its new Group. `false` when the chat is
   * gone, or when it no longer names this Group (moved, or already cleared): nothing is written.
   */
  async clearGroupChatIfMatches(sessionId: string, groupId: string): Promise<boolean> {
    return this.execute(async (client) => {
      const now = new Date().toISOString()
      const answer = await client.eval(CLEAR_GROUP_CHAT_IF_MATCHES_SCRIPT, {
        keys: [`session:${sessionId}`],
        arguments: [JSON.stringify(now), groupId]
      })
      if (answer === 'MISSING' || answer === 'CHANGED') return false
      if (answer !== 'OK') {
        throw new Error(`The group-chat clear of session ${sessionId} answered ${String(answer)}.`)
      }
      const session = (await client.json.get(`session:${sessionId}`, {
        path: ['$.user_id', '$.folder_id']
      })) as Record<string, unknown[]> | null
      const userId = session?.['$.user_id']?.[0]
      const folderId = session?.['$.folder_id']?.[0]
      await this.touchFolderLastUsed(
        client,
        typeof userId === 'string' ? userId : undefined,
        typeof folderId === 'string' ? folderId : undefined,
        now
      )
      return true
    })
  }

  /**
   * BL-474 step 2: write a reply's image-origin record (pending at its run's start, decided at its
   * end) by `WRITE_IMAGE_ORIGIN_SCRIPT`'s rules. Only `imageAddressOrigins.ts` calls it.
   */
  async writeImageOriginRecord(input: {
    userId: string
    sessionId: string
    messageId: string
    version: number
    state: 'pending' | 'decided'
    record: Record<string, unknown>
  }): Promise<ImageOriginWriteAnswer> {
    return this.execute(async (client) => {
      const answer = await client.eval(WRITE_IMAGE_ORIGIN_SCRIPT, {
        keys: [
          `session:${input.sessionId}`,
          `message:${input.sessionId}:${input.messageId}`,
          `image_origins:${input.sessionId}`,
          `image_origin:${input.sessionId}:${input.messageId}`
        ],
        arguments: [
          input.userId,
          input.sessionId,
          input.messageId,
          String(input.version),
          input.state,
          JSON.stringify(input.record)
        ]
      })
      const known: Record<string, ImageOriginWriteAnswer> = {
        OK: 'ok',
        MISSING_CHAT: 'missing_chat',
        NOT_OWNER: 'not_owner',
        MISSING_REPLY: 'missing_reply',
        NOT_REPLY: 'not_reply',
        OLDER: 'older',
        KEPT: 'kept'
      }
      const mapped = typeof answer === 'string' ? known[answer] : undefined
      if (!mapped) throw new Error(`The image origin write answered ${String(answer)}.`)
      return mapped
    })
  }

  /**
   * BL-735: write the Infinite Session transition's two owned fields (`metadata.fixedSession` and
   * `locked`) at their own path. `false` when the chat is gone: nothing is written.
   */
  async writeFixedSessionMark(
    sessionId: string,
    fixedSession: FixedSessionMetadata
  ): Promise<boolean> {
    return this.execute(async (client) => {
      const now = new Date().toISOString()
      const answer = await client.eval(WRITE_FIXED_SESSION_MARK_SCRIPT, {
        keys: [`session:${sessionId}`],
        arguments: [JSON.stringify(now), JSON.stringify(fixedSession)]
      })
      if (answer === 'MISSING') return false
      if (answer !== 'OK') {
        throw new Error(`The Infinite Session mark write of session ${sessionId} answered ${String(answer)}.`)
      }
      const session = (await client.json.get(`session:${sessionId}`, {
        path: ['$.user_id', '$.folder_id']
      })) as Record<string, unknown[]> | null
      const userId = session?.['$.user_id']?.[0]
      const folderId = session?.['$.folder_id']?.[0]
      await this.touchFolderLastUsed(
        client,
        typeof userId === 'string' ? userId : undefined,
        typeof folderId === 'string' ? folderId : undefined,
        now
      )
      return true
    })
  }

  /** Touch the folder of a chat whose record a by-path script just wrote. */
  private async touchFolderOfSession(client: RedisClientType, sessionId: string, now: string) {
    const session = (await client.json.get(`session:${sessionId}`, {
      path: ['$.user_id', '$.folder_id']
    })) as Record<string, unknown[]> | null
    const userId = session?.['$.user_id']?.[0]
    const folderId = session?.['$.folder_id']?.[0]
    await this.touchFolderLastUsed(
      client,
      typeof userId === 'string' ? userId : undefined,
      typeof folderId === 'string' ? folderId : undefined,
      now
    )
  }

  /**
   * BL-549 (N4): add one graduation event to an Infinite Session's window, at its own path, in
   * one step inside Redis. Every other metadata block and every event another writer added
   * stays. `missing` when the chat is gone, `not_fixed` when it is not an Infinite Session:
   * nothing is written.
   */
  async appendFixedSessionGraduationEvent(
    sessionId: string,
    event: Record<string, unknown>
  ): Promise<'ok' | 'missing' | 'not_fixed'> {
    return this.execute(async (client) => {
      const now = new Date().toISOString()
      const answer = await client.eval(APPEND_FIXED_SESSION_GRADUATION_EVENT_SCRIPT, {
        keys: [`session:${sessionId}`],
        arguments: [
          JSON.stringify(event),
          JSON.stringify({ version: 1, events: [event] }),
          JSON.stringify(now)
        ]
      })
      if (answer === 'MISSING') return 'missing'
      if (answer === 'NOT_FIXED') return 'not_fixed'
      if (answer !== 'OK') {
        throw new Error(`The graduation event write of session ${sessionId} answered ${String(answer)}.`)
      }
      await this.touchFolderOfSession(client, sessionId, now)
      return 'ok'
    })
  }

  /**
   * BL-549 (N4): replace graduation events with one era event, at the event list's own path, in
   * one step inside Redis, only while every replaced event is still stored. `changed` names the
   * replaced ids that are gone: nothing was written.
   */
  async swapFixedSessionGraduationEvents(
    sessionId: string,
    removeEventIds: string[],
    eraEvent: Record<string, unknown>
  ): Promise<{ ok: true } | { ok: false; reason: 'missing' | 'not_fixed' } | { ok: false; reason: 'changed'; missing: string[] }> {
    if (removeEventIds.length === 0) {
      throw new Error('swapFixedSessionGraduationEvents requires at least one event id to replace.')
    }
    return this.execute(async (client) => {
      const now = new Date().toISOString()
      const answer = await client.eval(SWAP_FIXED_SESSION_GRADUATION_EVENTS_SCRIPT, {
        keys: [`session:${sessionId}`],
        arguments: [JSON.stringify(eraEvent), JSON.stringify(now), ...removeEventIds]
      })
      if (answer === 'MISSING') return { ok: false as const, reason: 'missing' as const }
      if (answer === 'NOT_FIXED') return { ok: false as const, reason: 'not_fixed' as const }
      if (typeof answer === 'string' && answer.startsWith('CHANGED:')) {
        return { ok: false as const, reason: 'changed' as const, missing: answer.slice('CHANGED:'.length).split(',') }
      }
      if (answer !== 'OK') {
        throw new Error(`The graduation event swap of session ${sessionId} answered ${String(answer)}.`)
      }
      await this.touchFolderOfSession(client, sessionId, now)
      return { ok: true as const }
    })
  }

  /**
   * BL-549 (N4): add a nap's record to the chat's nap history (the last `limit` kept), at its own
   * path, in one step inside Redis. Answers the chat's metadata as stored after the write (for
   * the page's session store), or `null` when the chat is gone: nothing is written.
   */
  async appendFixedSessionNapRecord(
    sessionId: string,
    record: Record<string, unknown>,
    limit: number = 20
  ): Promise<Record<string, any> | null> {
    return this.execute(async (client) => {
      const now = new Date().toISOString()
      const answer = await client.eval(APPEND_FIXED_SESSION_NAP_RECORD_SCRIPT, {
        keys: [`session:${sessionId}`],
        arguments: [JSON.stringify(record), String(limit), JSON.stringify(now)]
      })
      if (answer === 'MISSING') return null
      if (typeof answer !== 'string') {
        throw new Error(`The nap record write of session ${sessionId} gave no answer.`)
      }
      // A script answers JSON.GET's raw JSON text: a `$` path answers a list of matches.
      const [metadata] = JSON.parse(answer) as Array<Record<string, any>>
      await this.touchFolderOfSession(client, sessionId, now)
      return metadata
    })
  }

  /**
   * BL-622 (C1, C2): add one Compact event to the chat's record, at its own path and in one step
   * inside Redis, only while the chat's last Compact event is still `expectedLastEventId` (`null`:
   * the Compact read no event). A Compact reads the chat, waits on its summary model, and then
   * writes; `updateSession` would write back the metadata block it read, and erase what another
   * writer added meanwhile. `changed` means another Compact wrote first: nothing was written.
   */
  async appendContextCompactionEvent(
    sessionId: string,
    event: Record<string, unknown>,
    expectedLastEventId: string | null
  ): Promise<ContextCompactionEventWrite> {
    return this.execute(async (client) => {
      const now = new Date().toISOString()
      const answer = await client.eval(APPEND_CONTEXT_COMPACTION_EVENT_SCRIPT, {
        keys: [`session:${sessionId}`],
        arguments: [
          JSON.stringify(event),
          expectedLastEventId ?? '',
          JSON.stringify({ version: 1, events: [event] }),
          JSON.stringify(now)
        ]
      })
      if (answer === 'MISSING') return { ok: false, reason: 'missing' }
      if (typeof answer === 'string' && answer.startsWith('CHANGED:')) {
        const lastEventId = answer.slice('CHANGED:'.length)
        return { ok: false, reason: 'changed', lastEventId: lastEventId || null }
      }
      if (typeof answer !== 'string') {
        throw new Error(`The Compact event write of session ${sessionId} gave no answer.`)
      }
      // A script answers JSON.GET's raw JSON text: a `$` path answers a list of matches.
      const [contextCompaction] = JSON.parse(answer) as Array<
        Extract<ContextCompactionEventWrite, { ok: true }>['contextCompaction']
      >
      const session = (await client.json.get(`session:${sessionId}`, {
        path: ['$.user_id', '$.folder_id']
      })) as Record<string, unknown[]> | null
      const userId = session?.['$.user_id']?.[0]
      const folderId = session?.['$.folder_id']?.[0]
      await this.touchFolderLastUsed(
        client,
        typeof userId === 'string' ? userId : undefined,
        typeof folderId === 'string' ? folderId : undefined,
        now
      )
      return { ok: true, contextCompaction }
    })
  }

  /**
   * Sweep a chat and every key it owns. The SWEEP only: a server route deletes a chat through
   * `deleteSessionStoppingItsTurn` (`sessionDeleteTurnStop.ts`), which stops the chat's running
   * reply first and calls this once that reply's request is done (2026-09-18). Swept under a
   * running reply, the reply's request went on writing its message, message list, zip, zip set,
   * and Execution Viewer log into a chat that no longer existed.
   */
  async deleteSession(id: string): Promise<void> {
    return this.execute(async (client) => {
      try {
        logger.debug(`[deleteSession] Starting deletion for session ${id}`)
        // BL-541: every KEYS pattern below is built from this id, and Redis reads `*`, `?`, `[`,
        // `]`, and `\` in a pattern as glob syntax: unescaped, deleting a chat named `a*` swept
        // the records of every chat whose id starts with `a`. The create route refuses those
        // characters; this covers an id already stored or brought back by a restore.
        const idPattern = escapeRedisGlob(id)
        
        // Get session to find user_id
        const session = await client.json.get(`session:${id}`)
        logger.debug(`[deleteSession] Found session:`, session ? 'YES' : 'NO')

        const sessionObj = session as any
        if (sessionObj?.locked) {
          throw new Error('Session is locked and cannot be deleted until unlocked')
        }
        
        // Delete all messages in this session and collect zip IDs
        const messageIds = await client.lRange(`messages:${id}`, 0, -1)
        logger.debug(`[deleteSession] Found ${messageIds.length} messages to delete`)
        const zipIdsToDelete = new Set<string>()
        
        // FIRST: Get all zips associated with this session from the session's zip set
        try {
          const sessionZips = await client.sMembers(`session:${id}:zips`)
          if (sessionZips && sessionZips.length > 0) {
            logger.debug(`[deleteSession] Found ${sessionZips.length} zips in session zip set`)
            sessionZips.forEach(zipId => zipIdsToDelete.add(zipId))
          }
        } catch (error) {
          console.error(`[deleteSession] Error getting session zips:`, error)
        }
        
        for (const msgId of messageIds) {
          try {
            // Get message to extract zip IDs before deleting
            const messageKey = `message:${id}:${msgId}`
            const message = await client.json.get(messageKey)
            if (message) {
              // Extract zip IDs from zipMetadata
              const messageObj = message as any
              if (messageObj.zipMetadata && Array.isArray(messageObj.zipMetadata)) {
                for (const zipMeta of messageObj.zipMetadata) {
                  if (zipMeta.zipId) {
                    zipIdsToDelete.add(zipMeta.zipId)
                  }
                }
              }
              
              // Check for new format zips: {{batshit-zip:id}} or {{batshit-zip:id:::description}},
              // read once (BL-707: the pattern searched to the first `}` again from every opener).
              for (const reference of scanDeletionSweepZipReferences(String(messageObj.content || ''))) {
                zipIdsToDelete.add(reference.id)
              }
              
              // Also check for old format (backward compatibility during transition). Linear: its
              // id stops at the next `|`, and every opener holds one.
              let match
              const oldZipPattern = /\{\{batshit\|id:([^|]+)\|/g
              while ((match = oldZipPattern.exec(messageObj.content || '')) !== null) {
                zipIdsToDelete.add(match[1])
              }
            }
            
            await client.del(messageKey)
          } catch (msgError) {
            console.error(`[deleteSession] Error processing message ${msgId}:`, msgError)
            // Continue with other messages
          }
        }
        
        // Delete the session's zip set
        try {
          await client.del(`session:${id}:zips`)
        } catch (error) {
          console.error(`[deleteSession] Error deleting session zip set:`, error)
        }
      
        // Delete all collected zips
        if (zipIdsToDelete.size > 0) {
          logger.debug(`[deleteSession] Deleting ${zipIdsToDelete.size} zips for session ${id}`)
          for (const zipId of zipIdsToDelete) {
            try {
              await client.del(`zip:${zipId}`)
            } catch (zipError) {
              console.error(`[deleteSession] Error deleting zip ${zipId}:`, zipError)
            }
          }
        }
        
        // Delete pins for this session
        try {
          await client.del(`pins:${id}`)
        } catch (pinError) {
          console.error(`[deleteSession] Error deleting pins:`, pinError)
        }
        
        // Delete clip-related session data
        try {
          await client.del(`session:${id}:clips`)
          await client.del(`session:${id}:clip_state`)
          await client.del(`session:${id}:active_clips`)
        } catch (clipError) {
          console.error(`[deleteSession] Error deleting clip data:`, clipError)
        }

        // Delete the session's episode ledger + recall/linger state (SA-104, DL-104-13)
        try {
          const episodeKeys = await client.keys(`episode:${idPattern}:*`)
          if (episodeKeys.length > 0) {
            await client.del(episodeKeys as [string, ...string[]])
          }
          await client.del(`session:${id}:episodes`)
          await client.del(`memlinger:${id}`)
        } catch (episodeError) {
          console.error(`[deleteSession] Error deleting episode ledger:`, episodeError)
        }
        
        // Delete all session_clip associations
        try {
          // Use KEYS command for pattern matching (Redis 8 compatible)
          // Note: KEYS is blocking but safe for small datasets
          const sessionClipKeys = await client.keys(`session_clip:${idPattern}:*`)
          
          if (sessionClipKeys && sessionClipKeys.length > 0) {
            await client.del(sessionClipKeys as [string, ...string[]])
            logger.debug(`[deleteSession] Deleted ${sessionClipKeys.length} session_clip associations`)
          }
        } catch (scanError) {
          console.error(`[deleteSession] Error scanning/deleting session_clip keys:`, scanError)
        }
        
        // Delete any subagent sessions associated with this session
        try {
          // Use KEYS command for pattern matching (Redis 8 compatible)
          // Note: KEYS is blocking but safe for small datasets
          // Pattern matches: subagent_sessions:{sessionId}:subagent:{subagentName}
          const subagentKeys = await client.keys(`subagent_sessions:${idPattern}:subagent:*`)

          if (subagentKeys && subagentKeys.length > 0) {
            await client.del(subagentKeys as [string, ...string[]])
            logger.debug(`[deleteSession] Deleted ${subagentKeys.length} subagent sessions`)
          }
        } catch (subagentError) {
          console.error(`[deleteSession] Error scanning/deleting subagent keys:`, subagentError)
        }

        // SA-111 P2: the Batshit-issued n8n Workflow Subagent thread ids
        // (`subagent_thread:{sessionId}:{slug}`, DL-111-06) and the in-flight run locks
        // (`subagent_lock:{sessionId}:{slug}`, DL-111-05). Both carry a TTL, but the
        // Session Key Cleanup rule is enumerate-don't-assume: a key that expires "soon"
        // still outlives its session until it does.
        try {
          const threadIdKeys = await client.keys(`subagent_thread:${idPattern}:*`)
          if (threadIdKeys && threadIdKeys.length > 0) {
            await client.del(threadIdKeys as [string, ...string[]])
            logger.debug(`[deleteSession] Deleted ${threadIdKeys.length} subagent thread ids`)
          }

          const subagentLockKeys = await client.keys(`subagent_lock:${idPattern}:*`)
          if (subagentLockKeys && subagentLockKeys.length > 0) {
            await client.del(subagentLockKeys as [string, ...string[]])
            logger.debug(`[deleteSession] Deleted ${subagentLockKeys.length} subagent run locks`)
          }
        } catch (threadError) {
          console.error(`[deleteSession] Error deleting subagent thread/lock keys:`, threadError)
        }

        // SA-116 P1 (DL-116-15): the risk-approval records raised in this chat, plus their
        // index. They carry a 24-hour EXPIRE, which is NOT a reason to skip this — the same
        // reasoning left `n8n:sse-callback:` unenumerated until AMD-111-02, and a consent
        // record that expires "soon" still outlives its chat until it does. An approval is
        // session-scoped, so `deleteAgent` deliberately owes it nothing.
        try {
          const { sweepSessionApprovals } = await import(
            '$lib/server/services/controlApprovals'
          )
          await sweepSessionApprovals(id)
        } catch (approvalError) {
          console.error(`[deleteSession] Error deleting control approvals:`, approvalError)
        }

        // SA-111 AMD-111-02: scoped per-message n8n callback tokens. TTL-bounded (~30 min)
        // and deliberately NOT part of backup — they are short-lived credentials, not data —
        // but they are session-scoped state and belong in this sweep.
        try {
          const callbackKeys = await client.keys(`n8n:sse-callback:${idPattern}:*`)
          if (callbackKeys && callbackKeys.length > 0) {
            await client.del(callbackKeys as [string, ...string[]])
            logger.debug(`[deleteSession] Deleted ${callbackKeys.length} n8n callback tokens`)
          }
        } catch (callbackError) {
          console.error(`[deleteSession] Error deleting n8n callback tokens:`, callbackError)
        }
        
        // Note: We don't delete upload:images:* keys because they might be shared across sessions
        // The session-specific upload references are handled as zips with pattern: {sessionId}-upload-*
        // These are already deleted above when we delete all zips from messages
        
        // Delete message list
        try {
          await client.del(`messages:${id}`)
        } catch (msgListError) {
          console.error(`[deleteSession] Error deleting message list:`, msgListError)
        }

	        // Delete session-specific message cache (used by send-routed for Batshit agents)
	        try {
	          await client.del(`session:${id}:messages`)
	          logger.debug(`[deleteSession] Deleted session:${id}:messages cache`)
	        } catch (msgCacheError) {
	          console.error(`[deleteSession] Error deleting message cache:`, msgCacheError)
	        }

	        // Delete execution viewer snapshots for this session
	        try {
	          await client.del(`session:${id}:execution_log`)
	          logger.debug(`[deleteSession] Deleted session:${id}:execution_log`)
	        } catch (executionLogError) {
	          console.error(`[deleteSession] Error deleting execution log:`, executionLogError)
	        }

	        // Delete session usage tracking
	        try {
	          await client.del(`session:${id}:usage`)
	          logger.debug(`[deleteSession] Deleted session:${id}:usage`)
	        } catch (usageError) {
          console.error(`[deleteSession] Error deleting session usage:`, usageError)
        }

        // Delete the zip state: the held and zipped sets and every item record. The item records
        // are swept by PATTERN, the way backup reads them (SA-129 P2b, BL-352): a record whose
        // set member is gone (a write that raced a release, before the zip state lock) would
        // outlive its chat if the sweep followed only the set members.
        for (const family of ['unzipped', 'rezipped'] as const) {
          try {
            const itemKeys = await client.keys(`${family}_item:${idPattern}:*`)
            if (itemKeys.length > 0) {
              await client.del(itemKeys)
              logger.debug(`[deleteSession] Deleted ${itemKeys.length} ${family}_item keys`)
            }
            await client.del(`${family}:${id}`)
          } catch (zipStateError) {
            console.error(`[deleteSession] Error deleting ${family} zip state:`, zipStateError)
          }
        }

        // SA-120 P6: what the Judge Juice after-reply check noticed about this chat's replies
        // (`jev_post_turn:{id}` + `jev_post_turn_item:{id}:*`). Session-scoped, no TTL, so this
        // sweep is the only thing that ever removes them.
        try {
          const { sweepPostTurnRecords } = await import('$lib/server/services/postTurnCheckState')
          await sweepPostTurnRecords(id)
        } catch (postTurnError) {
          console.error(`[deleteSession] Error deleting Judge Juice after-reply records:`, postTurnError)
        }

        try {
          const { sweepCodexCleanupWarnings } = await import('$lib/server/services/codexCleanupWarnings')
          await sweepCodexCleanupWarnings(id)
        } catch (cleanupWarningError) {
          console.error(`[deleteSession] Error deleting Codex cleanup warnings:`, cleanupWarningError)
        }

        // BL-474 step 2: where each reply's outside pictures came from (`image_origins:{id}` +
        // `image_origin:{id}:*`). Session-scoped, no TTL, so this sweep is the only thing that
        // ever removes them.
        try {
          const { sweepImageOrigins } = await import('$lib/server/services/imageAddressOrigins')
          await sweepImageOrigins(id)
        } catch (imageOriginError) {
          console.error(`[deleteSession] Error deleting image origin records:`, imageOriginError)
        }

        // Delete message counter for this session (Story 6.9b)
        try {
          await client.del(`message_counter:${id}`)
          logger.debug(`[deleteSession] Deleted message counter for session`)
        } catch (counterError) {
          console.error(`[deleteSession] Error deleting message counter:`, counterError)
        }

        // Delete session
        try {
          await client.del(`session:${id}`)
        } catch (sessionDelError) {
          console.error(`[deleteSession] Error deleting session:`, sessionDelError)
        }
        
        // Remove from user's session list
        if (sessionObj?.user_id) {
          try {
            await client.sRem(`user:${sessionObj.user_id}:sessions`, id)
          } catch (userSessionError) {
            console.error(`[deleteSession] Error removing from user session list:`, userSessionError)
          }
          
          // Remove from folder's session list
          if (sessionObj.folder_id) {
            try {
              await client.sRem(`folder:${sessionObj.user_id}:${sessionObj.folder_id}:sessions`, id)
            } catch (folderSessionError) {
              console.error(`[deleteSession] Error removing from folder session list:`, folderSessionError)
            }
          }
        }
        
        logger.debug(`[deleteSession] Successfully deleted session ${id} and all related data`)
        return // Return success - the main deletion worked even if some cleanup failed
      } catch (error) {
        console.error(`[deleteSession] Critical error deleting session ${id}:`, error)
        throw error
      }
    })
  }

  async archiveSession(id: string): Promise<void> {
    await this.updateSession(id, {
      archived: true,
      archived_at: new Date().toISOString()
    })
  }

  async unarchiveSession(id: string): Promise<void> {
    await this.updateSession(id, {
      archived: false,
      archived_at: null
    })
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.updateSession(sessionId, {
      last_modified_at: new Date().toISOString()
    })
  }

  // ===== MESSAGES =====

  /**
   * The FIRST `limit` messages, oldest first.
   *
   * BL-4: this and the two readers below skip the saved message of a send that is still waiting
   * in the chat's line (`queuedSendHiddenIds.ts`): it is not part of the conversation until its
   * turn. They filter the list POSITIONS they were asked for and never widen them, so a window
   * that holds a waiting message is one shorter, and no window repeats or skips a message the
   * next one returns. Raw readers of the list (the delete sweep, `saveMessage`, the backup) see
   * everything.
   */
  async getMessages(sessionId: string, limit = 100): Promise<ChatMemoryRow[]> {
    return this.execute(async (client) => {
      // Get message IDs
      const messageIds = filterQueuedSendMessageIds(
        sessionId,
        await client.lRange(`messages:${sessionId}`, 0, limit - 1)
      )

      if (messageIds.length === 0) {
        return []
      }
      
      // Get all message data using RedisJSON for native JSON retrieval
      const messages: ChatMemoryRow[] = []
      for (const msgId of messageIds) {
        try {
          const key = `message:${sessionId}:${msgId}`
          // Pure RedisJSON - no parsing needed!
          const messageData = await client.json.get(key)
          if (messageData) {
            messages.push(messageData as unknown as ChatMemoryRow)
          }
        } catch (error) {
          logger.warn(`Failed to load message ${msgId}:`, error)
        }
      }
      
      return messages
    })
  }

  /**
   * The LAST `limit` messages of a session, oldest-first within that window.
   *
   * SA-113 P3 (F-P2-1). `getMessages` above is `lRange(key, 0, limit - 1)` — the FIRST
   * `limit` messages — which is right for callers that explicitly want the beginning, and
   * silently wrong for every caller that meant "the recent end".
   * Four callers meant the recent end and were reading ancient history on any chat longer
   * than their window: the DM chain-depth guard, the DM presence check, the wake-up
   * primitive's history re-read, and the LiveKit voice context seed.
   *
   * Use THIS one whenever the window is smaller than a chat could be. Use `getAllMessages`
   * for a complete transcript; never guess a limit that the chat might outgrow.
   */
  async getRecentMessages(sessionId: string, limit = 100): Promise<ChatMemoryRow[]> {
    if (!Number.isFinite(limit) || limit <= 0) return []
    return this.execute(async (client) => {
      const messageIds = filterQueuedSendMessageIds(
        sessionId,
        await client.lRange(`messages:${sessionId}`, -limit, -1)
      )

      if (messageIds.length === 0) {
        return []
      }

      const messages: ChatMemoryRow[] = []
      for (const msgId of messageIds) {
        try {
          const key = `message:${sessionId}:${msgId}`
          const messageData = await client.json.get(key)
          if (messageData) {
            messages.push(messageData as unknown as ChatMemoryRow)
          }
        } catch (error) {
          logger.warn(`Failed to load message ${msgId}:`, error)
        }
      }

      return messages
    })
  }

  /** Every stored message in conversation order. Reserved for genuinely full-history work. */
  async getAllMessages(sessionId: string): Promise<ChatMemoryRow[]> {
    return this.execute(async (client) => {
      const messageIds = filterQueuedSendMessageIds(
        sessionId,
        await client.lRange(`messages:${sessionId}`, 0, -1)
      )
      const messages: ChatMemoryRow[] = []
      for (const msgId of messageIds) {
        try {
          const messageData = await client.json.get(`message:${sessionId}:${msgId}`)
          if (messageData) messages.push(messageData as unknown as ChatMemoryRow)
        } catch (error) {
          logger.warn(`Failed to load message ${msgId}:`, error)
        }
      }
      return messages
    })
  }

  /** The browser/current-context window: newest 1,000 messages, in conversation order. */
  async getSessionMessages(sessionId: string): Promise<Message[]> {
    return this.toSessionMessages(await this.getRecentMessages(sessionId, 1000))
  }

  /** The complete stored transcript. Do not use this for model context or the browser window. */
  async getAllSessionMessages(sessionId: string): Promise<Message[]> {
    return this.toSessionMessages(await this.getAllMessages(sessionId))
  }

  private toSessionMessages(messages: ChatMemoryRow[]): Message[] {
    return messages.map(msg => {
      const metadata =
        msg.metadata && typeof msg.metadata === 'object'
          ? msg.metadata
          : undefined
      const status =
        msg.status === 'error' || metadata?.error_message
          ? 'error'
          : msg.status === 'in_progress'
            ? 'in_progress'
            : 'complete'

      return {
        id: msg.id,
        session_id: msg.session_id,
        user_id: msg.user_id || '',
        agent_id: msg.agent_id || undefined,
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content || '',
        timestamp: msg.created_at,
        created_at: msg.created_at,
        metadata,
        model: (msg as any).model || (msg as any).model_id || undefined,
        provider: (msg as any).provider || undefined,
        zipMetadata: msg.zipMetadata || undefined,
        toolResults: msg.toolResults || undefined,
        intermediateSteps: msg.intermediateSteps || undefined,
        toolPlaceholders: msg.toolPlaceholders || undefined,
        toolPreface: (msg as any).toolPreface || undefined,
        status
      } as Message
    })
  }

  async saveMessage(message: Message | Partial<ChatMemoryRow>, options: { browserMutation?: BrowserMessageMutationPolicy } = {}): Promise<void> {
    await this.execute(async (client) => {
      // SA-911: Clean up duplicate zip refs before persisting (placeholders no longer used but kept for safety)
      const dedupeZipRefs = (text: any) => {
        if (text === null || text === undefined) return ''
        const asString =
          typeof text === 'string'
            ? text
            : (() => {
                try {
                  const json = JSON.stringify(text)
                  return typeof json === 'string' ? json : String(text)
                } catch {
                  return String(text)
                }
              })()

        if (!asString) return asString
        // Remove any stray placeholders (legacy, shouldn't exist after SA-911). Both token
        // shapes are read by one scan (`braceScan.ts`): their regexes searched to the first `}`
        // again from every opener, about 30 s for 20,000 unclosed openers in 1 MB, on this
        // save (the reply-end save included).
        let cleaned = replaceBracedTokens(asString, '{{TOOL_LOADING_PLACEHOLDER:', () => '')

        const seen = new Set<string>()
        cleaned = replaceBracedTokens(cleaned, '{{batshit-zip:', (m) => {
          if (seen.has(m)) return ''
          seen.add(m)
          return m
        })

        return cleaned.replace(/\n{3,}/g, '\n\n').trim()
      }

      const collectTrustedClipIds = async (sessionId: string, metadata: unknown) => {
        const ids = new Set(collectTrustedClipIdsFromMetadata(metadata))

        if (sessionId) {
          const state = await client.json.get(`session:${sessionId}:clip_state`).catch(() => null)
          const stateClips = Array.isArray((state as any)?.clips) ? (state as any).clips : []
          for (const entry of stateClips) {
            if (typeof entry?.clipId === 'string' && entry.clipId.trim()) {
              ids.add(entry.clipId.trim())
            }
          }

          const activeClipIds = await client.sMembers(`session:${sessionId}:active_clips`).catch(() => [])
          for (const clipId of activeClipIds) {
            if (clipId) ids.add(clipId)
          }

          const sessionClipIds = await client.sMembers(`session:${sessionId}:clips`).catch(() => [])
          for (const clipId of sessionClipIds) {
            if (clipId) ids.add(clipId)
          }
        }

        return Array.from(ids)
      }

      const sanitizePersistedContent = (
        text: any,
        role?: string,
        trustedClipIds?: string[]
      ) => {
        const cleaned = dedupeZipRefs(text)
        if (role !== 'user') return cleaned
        return neutralizeUntrustedClipReferenceSyntax(
          neutralizeAllZipReferenceSyntax(cleaned),
          { trustedClipIds }
        )
      }

      // Convert to ChatMemoryRow format
      const role = (message as any).role
      const sessionId = (message as any).session_id || ''
      // A message belongs to a chat that exists. The `updateSession` / `touchSession` at the end
      // refused a chat that no longer exists, but only AFTER the message was written and pushed
      // onto the list, which left both behind for a chat deleted mid-reply (2026-09-18).
      if (sessionId && !(await client.exists(`session:${sessionId}`))) {
        throw new Error('Session not found')
      }
      const metadata = (message as any).metadata
      const trustedClipIds = await collectTrustedClipIds(sessionId, metadata)
      const messageData: ChatMemoryRow = {
        id: message.id || crypto.randomUUID(),
        session_id: sessionId,
        user_id: (message as any).user_id || '',
        agent_id: (message as any).agent_id,
        role,
        status: (message as any).status,
        content: sanitizePersistedContent((message as any).content || '', role, trustedClipIds),
        model_id: (message as any).model_id || (message as any).model,
        model: (message as any).model || (message as any).model_id,
        provider: (message as any).provider,
        zipMetadata: (message as any).zipMetadata,
        toolResults: (message as any).toolResults,
        intermediateSteps: (message as any).intermediateSteps,
        toolPlaceholders: (message as any).toolPlaceholders,
        toolPreface: (message as any).toolPreface,
        metadata: (message as any).metadata,
        created_at: new Date().toISOString()
      }

      // If the message already exists, merge metadata instead of overwriting it.
      // This prevents client-side "saveMessage" calls from clobbering server-enriched fields
      // (e.g. reasoning summaries, model ids, execution metadata).
      const messageKey = `message:${messageData.session_id}:${messageData.id}`
      const existing = await client.json.get(messageKey)
      if (existing && typeof existing === 'object') {
        const existingObj = existing as any

        messageData.created_at = existingObj.created_at || messageData.created_at

        const existingMetadata =
          existingObj.metadata && typeof existingObj.metadata === 'object'
            ? existingObj.metadata
            : {}
        const incomingMetadata =
          messageData.metadata && typeof messageData.metadata === 'object'
            ? messageData.metadata
            : {}
        // The approvals a click answered are the server's record (`toolApprovalState.ts`): a
        // tab's copy of this message can predate the click, and its save must not undo it.
        messageData.metadata = options.browserMutation ? { ...existingMetadata, ...incomingMetadata } : keepAnsweredApprovals(existingMetadata, {
          ...existingMetadata,
          ...incomingMetadata
        })

        if (!messageData.intermediateSteps && existingObj.intermediateSteps) {
          messageData.intermediateSteps = existingObj.intermediateSteps
        }
        if (!messageData.toolResults && existingObj.toolResults) {
          messageData.toolResults = existingObj.toolResults
        }
        if (!messageData.toolPlaceholders && existingObj.toolPlaceholders) {
          messageData.toolPlaceholders = existingObj.toolPlaceholders
        }
        if (!messageData.toolPreface && existingObj.toolPreface) {
          messageData.toolPreface = existingObj.toolPreface
        }
      }
      
      // Store message using RedisJSON for native JSON storage. One script, so a move that
      // landed after the read above keeps its date (BL-195).
      const writeResult = await client.eval(SAVE_MESSAGE_KEEPING_CREATED_AT_SCRIPT, {
        keys: options.browserMutation ? [messageKey, `session:${messageData.session_id}`] : [messageKey],
        arguments: [
          JSON.stringify(messageData),
          typeof messageData.created_at === 'string' ? messageData.created_at : '',
          ...(options.browserMutation ? [JSON.stringify({ ...options.browserMutation,
            // This is computed from the original user-editable metadata, before the merge.
            // It is an internal writer policy, never copied from request policy fields.
            mergeMetadataKeys: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? Object.keys(metadata) : []
          })] : [])
        ]
      })
      if (options.browserMutation && writeResult !== 'OK') {
        throw new BrowserMessageMutationError(writeResult as BrowserMessageMutationError['code'])
      }
      
      // Add to session's message list (only if not already present)
      const existingMessages = await client.lRange(`messages:${messageData.session_id}`, 0, -1)
      const messageExists = existingMessages.includes(messageData.id)
      
      if (!messageExists) {
        await client.rPush(`messages:${messageData.session_id}`, messageData.id)
      }
      
      // Update session last activity
      if (messageData.session_id) {
        // Keep `session.agent_id` in sync with the most recent message so
        // server-side streaming helpers (SSE, zip detection, Mode 1 hydration)
        // can resolve the active agent without relying on client state.
        if (messageData.agent_id) {
          await this.updateSession(messageData.session_id, {
            agent_id: messageData.agent_id
          })
        } else {
          await this.touchSession(messageData.session_id)
        }
      }
    })
    // A stopped Codex command may report cleanup failure before this final reply save.
    // The warning is a separate server-owned record, flushed only after the reply exists.
    if ((message as any).role === 'assistant' && (message as any).session_id && message.id) {
      try {
        const { flushPendingCodexCleanupWarning } = await import('$lib/server/services/codexCleanupWarnings')
        await flushPendingCodexCleanupWarning((message as any).session_id, message.id)
      } catch (error) {
        // The reply itself is saved. A warning write failure must not turn its finalizer into
        // a second failure; the pending entry remains for a later save until its short expiry.
        console.error('[Codex cleanup] Could not flush pending warning after reply save:', error)
      }
    }
  }

  /**
   * BL-4 — move one saved user message to the end of its chat, dated now.
   *
   * A send that waited in the chat's line saved its message BEFORE the reply it waited behind
   * was written (a reply is added to the list when it is finalized), so the message sits above
   * that reply. When its turn comes, or when it is kept unanswered (Stop, shutdown, the line's
   * cap), it moves to the end in one script (BL-195), so no reader sees it missing or twice and
   * no delete or save lands halfway, and `created_at` is set to now so a reader that sorts by
   * time agrees with the list.
   * A Send now of a kept message passes `createdAt`, the time its tab sent it
   * (`resentMessageCreatedAt`), so the reply that tab adds next sorts after it. The record
   * itself is never rewritten: one message, one copy. Answers `null`, touching nothing, for a
   * message or a chat that is gone.
   */
  async moveMessageToEnd(
    sessionId: string,
    messageId: string,
    options: { createdAt?: string | null } = {}
  ): Promise<ChatMemoryRow | null> {
    return this.execute(async (client) => {
      if (!sessionId || !messageId) return null
      const createdAt = options.createdAt ?? new Date().toISOString()
      const moved = await client.eval(MOVE_MESSAGE_TO_END_SCRIPT, {
        keys: [`session:${sessionId}`, `message:${sessionId}:${messageId}`, `messages:${sessionId}`],
        arguments: [messageId, JSON.stringify(createdAt)]
      })
      // A script answers JSON.GET's raw JSON text; nil when the message or chat is gone.
      return typeof moved === 'string' ? (JSON.parse(moved) as ChatMemoryRow) : null
    })
  }

  async updateMessage(messageId: string, sessionId: string, updates: Partial<ChatMemoryRow>, userId: string,
    options: { browserMutation?: BrowserMessageMutationPolicy } = {}): Promise<void> {
    return this.execute(async (client) => {
      // Verify session belongs to user
      const session = await client.json.get(`session:${sessionId}`)
      if (!session) throw new Error('Session not found')
      const sessionObj = session as any
      if (sessionObj.user_id !== userId) throw new Error('Unauthorized: Session does not belong to user')
      
      // Get existing message
      const existing = await client.json.get(`message:${sessionId}:${messageId}`)
      if (!existing) throw new Error('Message not found')
      
      // Update the message
      const updated: Record<string, any> = {
        ...(existing as any),
        ...updates,
        updated_at: new Date().toISOString()
      }
      if (updated.role === 'user' && typeof updated.content === 'string') {
        const trustedClipIds = new Set(collectTrustedClipIdsFromMetadata(updated.metadata))

        const state = await client.json.get(`session:${sessionId}:clip_state`).catch(() => null)
        const stateClips = Array.isArray((state as any)?.clips) ? (state as any).clips : []
        for (const entry of stateClips) {
          if (typeof entry?.clipId === 'string' && entry.clipId.trim()) {
            trustedClipIds.add(entry.clipId.trim())
          }
        }

        const activeClipIds = await client.sMembers(`session:${sessionId}:active_clips`).catch(() => [])
        for (const clipId of activeClipIds) {
          if (clipId) trustedClipIds.add(clipId)
        }

        const sessionClipIds = await client.sMembers(`session:${sessionId}:clips`).catch(() => [])
        for (const clipId of sessionClipIds) {
          if (clipId) trustedClipIds.add(clipId)
        }

        updated.content = neutralizeUntrustedClipReferenceSyntax(
          neutralizeAllZipReferenceSyntax(updated.content),
          { trustedClipIds }
        )
      }
      
      if (options.browserMutation) {
        const writeResult = await client.eval(SAVE_MESSAGE_KEEPING_CREATED_AT_SCRIPT, {
          keys: [`message:${sessionId}:${messageId}`, `session:${sessionId}`],
          arguments: [JSON.stringify(updated), typeof updated.created_at === 'string' ? updated.created_at : '',
            JSON.stringify(options.browserMutation)]
        })
        if (writeResult !== 'OK') throw new BrowserMessageMutationError(writeResult as BrowserMessageMutationError['code'])
      } else {
        await client.json.set(`message:${sessionId}:${messageId}`, '$', updated)
      }
      
      // Touch session to update last activity
      await this.touchSession(sessionId)
    })
  }

  async deleteMessage(
    messageId: string,
    sessionId: string,
    userId: string,
    options: { stillRunning?: () => boolean } = {}
  ): Promise<void> {
    return this.execute(async (client) => {
      // Verify session belongs to user
      const session = await client.json.get(`session:${sessionId}`)
      if (!session) throw new Error('Session not found')
      const sessionObj = session as any
      if (sessionObj.user_id !== userId) throw new Error('Unauthorized: Session does not belong to user')

      // BL-390: the zips this message made go with it, with their zip state. Deleting only the
      // record left them in `session:{id}:zips`, so the Zip Manager still listed the deleted tool
      // output, it could still be opened, and every later backup carried it. Every zip state
      // writer takes the chat's zip state lock, so this one does too. Inside it: this message's
      // read, the zip set and each zip's owner (what the zip writers change), the second running
      // check (BL-381), and the MULTI, so the decision and the write see the same zip state.
      // Every other message's claims, read BEFORE the lock: message saves never take the zip
      // state lock, so holding it during these reads would order nothing, and it would keep every
      // zip state writer of the chat waiting on a long read. Only the fields a claim can live in
      // (`zipClaimsOfMessage`), never the whole record.
      const otherIds = ((await client.lRange(`messages:${sessionId}`, 0, -1)) ?? []).filter((id) => id !== messageId)
      const otherMessages = await readZipClaimFieldsOfMessages(
        client,
        sessionId,
        otherIds,
        'Another message of this chat could not be read, so nothing was deleted.'
      )

      await withZipStateLock(sessionId, async () => {
        const messageKey = `message:${sessionId}:${messageId}`
        // A failed read THROWS here and stops the delete with nothing deleted: it must never
        // read as "this message has no zips". A message already gone (a retry) reads as null,
        // and its zips are still found through their own records below.
        const message = (await client.json.get(messageKey)) as any
        const zipSetKey = `session:${sessionId}:zips`
        const candidates = [
          ...new Set([...((await client.sMembers(zipSetKey)) ?? []), ...zipClaimsOfMessage(message)])
        ].sort()
        const zipKeys = candidates.map((zipId) => `zip:${zipId}`)
        const owners = zipKeys.length > 0 ? await client.json.mGet(zipKeys, '$.metadata.messageId') : []
        const sessions = zipKeys.length > 0 ? await client.json.mGet(zipKeys, '$.metadata.sessionId') : []
        const zipIdsToDelete = zipsOwnedOnlyByMessage({
          messageId,
          sessionId,
          zips: candidates.map((zipId, index) => ({
            zipId,
            messageId: firstJsonPathMatch(owners[index]),
            sessionId: firstJsonPathMatch(sessions[index])
          })),
          message,
          otherMessageIds: otherIds,
          otherMessages
        })

        // BL-381: the route's running check, again right before the write, inside the lock: a
        // turn that started on this message since the route checked refuses it the same way.
        if (options.stillRunning?.()) throw new MessageStillRunningError()

        // One MULTI (the BL-537 rule for zip state): a lost connection applies none of it.
        const multi = client.multi()
        multi.del(messageKey)
        multi.lRem(`messages:${sessionId}`, 0, messageId)
        for (const zipId of zipIdsToDelete) queueZipRemoval(multi, sessionId, zipId)
        await multi.exec()
      })

      // SA-120 P6: a Judge Juice after-reply record annotates exactly one reply and goes with it.
      const { deletePostTurnRecord } = await import('$lib/server/services/postTurnCheckState')
      await deletePostTurnRecord(sessionId, messageId)
      const { deleteCodexCleanupWarning } = await import('$lib/server/services/codexCleanupWarnings')
      await deleteCodexCleanupWarning(sessionId, messageId)
      // BL-474 step 2: the record of where the reply's pictures came from goes with the reply.
      const { deleteImageOrigin } = await import('$lib/server/services/imageAddressOrigins')
      await deleteImageOrigin(sessionId, messageId)

      // Clear any stale per-session message cache so refresh reloads the live list.
      await client.del(`session:${sessionId}:messages`)
      
      // Touch session to update last activity
      await this.touchSession(sessionId)
    })
  }

  /**
   * BL-775: removes the zips `messageId` made (among `zipIds`) that no message of its chat names,
   * the message itself included, with their zip state, by the claim rules of a message delete
   * (BL-390, `unclaimedZipsMadeByMessage`) and under the chat's zip state lock. The finalize calls
   * it for a reply it saved from its own copy: that copy does not name the zips the stream path
   * made, which would otherwise be left with no reference. Answers the ids it removed. A message
   * that exists but cannot be read stops it with nothing removed.
   */
  async removeUnclaimedZipsMadeByMessage(sessionId: string, messageId: string, zipIds: string[]): Promise<string[]> {
    const candidates = [...new Set(zipIds.filter((id) => typeof id === 'string' && id.length > 0))].sort()
    if (!sessionId || !messageId || candidates.length === 0) return []
    return this.execute(async (client) => {
      const ids = (await client.lRange(`messages:${sessionId}`, 0, -1)) ?? []
      const chatMessages = await readZipClaimFieldsOfMessages(
        client,
        sessionId,
        ids,
        'A message of this chat could not be read, so no zip was removed.'
      )
      return withZipStateLock(sessionId, async () => {
        const zipKeys = candidates.map((zipId) => `zip:${zipId}`)
        const owners = await client.json.mGet(zipKeys, '$.metadata.messageId')
        const sessions = await client.json.mGet(zipKeys, '$.metadata.sessionId')
        const removable = unclaimedZipsMadeByMessage({
          messageId,
          sessionId,
          zips: candidates.map((zipId, index) => ({
            zipId,
            messageId: firstJsonPathMatch(owners[index]),
            sessionId: firstJsonPathMatch(sessions[index])
          })),
          chatMessages
        })
        if (removable.length === 0) return []
        const multi = client.multi()
        for (const zipId of removable) queueZipRemoval(multi, sessionId, zipId)
        await multi.exec()
        return removable
      })
    })
  }

  // ===== AGENTS =====

  async getAgents(userId: string): Promise<AgentRow[]> {
    return this.execute(async (client) => {
      // Get all agent IDs for user
      const setKey = `user:${userId}:agents`
      const agentIds = await client.sMembers(setKey)

      if (agentIds.length === 0) {
        return []
      }
      
      // Get all agent data using RedisJSON
      const agents: AgentRow[] = []
      for (const agentId of agentIds) {
        try {
          const agentData = await client.json.get(`agent:${agentId}`)
          if (agentData) {
            const normalizedAgent = canonicalizePrimaryAgentRecord(
              agentData as Record<string, any>
            ) as AgentRow
            agents.push(resolveUploadUrlsForBrowserInPayload(normalizedAgent))

            // BL-770: by path, never the whole record read here. An empty update (review item 1):
            // the script works the type out from the record as it is when it runs, never from
            // this read, and removes the legacy fields.
            if (hasLegacyPrimaryAgentFields(agentData as Record<string, any>)) {
              await this.writeAgentUpdate(client, agentId, {}, {})
            }
          }
        } catch (error) {
          logger.warn(`Failed to load agent ${agentId}:`, error)
        }
      }

      // Sort by created_at descending
      agents.sort((a, b) => {
        const dateA = new Date(a.created_at || 0).getTime()
        const dateB = new Date(b.created_at || 0).getTime()
        return dateB - dateA
      })

      // Map database fields to frontend format
      const mappedAgents = agents.map(w => ({
        ...w,
        displayName: w.displayName || '',
        avatar_url: w.avatar || w.avatar_url || undefined,
        ai_permissions: {
          ...w.ai_permissions
        }
      }))

      return mappedAgents
    })
  }

  async createAgent(agent: Partial<AgentRow>): Promise<AgentRow> {
    return this.execute(async (client) => {
      // Add default granular settings for common tools
      const defaultGranularSettings = {
        // File reading - keep visible longer for reference
        buffer_size_read_file: 8,
        zip_threshold_read_file: 0,
        auto_zip_read_file: false,
        
        // File writing - moderate visibility
        buffer_size_write_file: 2,
        zip_threshold_write_file: 0,
        auto_zip_write_file: false,

        // File edit/diff operations
        buffer_size_edit_file: 2,
        zip_threshold_edit_file: 0,
        auto_zip_edit_file: false,

        // Command execution - compress quickly
        buffer_size_execute_command: 1,
        zip_threshold_execute_command: 0,
        auto_zip_execute_command: false,
        
        // Listing operations - compress immediately by default
        buffer_size_list_files: 1,
        zip_threshold_list_files: 0,
        auto_zip_list_files: true,
        
        // Fallback for all other tools
        buffer_size_all_other_tools: 1,
        zip_threshold_all_other_tools: 0,
        auto_zip_all_other_tools: true
      }

      const resolvedAgentType = normalizePrimaryAgentType(agent)

      const show_reasoning =
        typeof (agent as any).show_reasoning === 'boolean'
          ? Boolean((agent as any).show_reasoning)
          : shouldShowReasoningByDefaultForPrimaryAgent(resolvedAgentType)

      const preserve_reasoning =
        typeof (agent as any).preserve_reasoning === 'boolean'
          ? Boolean((agent as any).preserve_reasoning)
          : false
      
      const agentData = canonicalizePrimaryAgentRecord({
        ...defaultGranularSettings,  // Apply defaults first
        ...agent,  // Then override with any provided values
        agentType: resolvedAgentType,
        show_reasoning,
        preserve_reasoning: show_reasoning ? preserve_reasoning : false,
        id: agent.id!,
        user_id: agent.user_id!,
        displayName: agent.displayName!,
        created_at: agent.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }) as AgentRow
      const storageAgentData = normalizeUploadUrlsForStorageInPayload(agentData)
      
      // Store agent using RedisJSON for native JSON storage
      await client.json.set(`agent:${agent.id}`, '$', storageAgentData as any)
      
      // Add to user's agent list
      if (agentData.user_id) {
        await client.sAdd(`user:${agentData.user_id}:agents`, agentData.id)
      }
      
      // Map database fields to frontend format
      return {
        ...resolveUploadUrlsForBrowserInPayload(storageAgentData),
        displayName: storageAgentData.displayName || '',
        avatar_url: storageAgentData.avatar || storageAgentData.avatar_url || undefined
      }
    })
  }

  /**
   * BL-768: write only the fields the caller passed, each by path, in one step inside Redis
   * (`UPDATE_AGENT_FIELDS_SCRIPT`; the rules are `planAgentRecordUpdate`'s in
   * `agentRecordUpdate.ts`). It used to read the whole record and write that copy back, so two
   * saves at the same moment took back each other's fields. `provider_specific_settings` is
   * written key by key (a `null` key removes it). Everything is checked first: a refused save throws
   * `AgentUpdateRejectedError` (a 400) and writes nothing. The only read is of the type fields;
   * the script writes `agentType` only when it is passed or the stored type is legacy or not
   * canonical, and a worked-out type only while those fields are unchanged (else this reads them
   * again, `AGENT_UPDATE_TYPE_TRIES` times at most, then throws `AgentUpdateConflictError`, a 409).
   * An agent that is gone throws "Agent not found" and is not recreated.
   *
   * BL-1294: `options.expectedMemory` is the memory settings a save of them started from (Agent
   * Settings' baseline). The stored memory settings are read beside the type fields and compared by
   * value with it before the script runs; a difference throws `AgentMemorySettingsConflictError` (a
   * 409, `memory_settings_changed`) and writes nothing. The script then checks the same raw answers
   * again before its first write (`MEMORY_CHANGED`: read and compare again, the type rule's tries).
   */
  async updateAgent(id: string, updates: Partial<AgentRow>, options: AgentUpdateOptions = {}): Promise<void> {
    return this.execute(async (client) => this.writeAgentUpdate(client, id, updates as Record<string, unknown>, options))
  }

  private async writeAgentUpdate(
    client: RedisClientType,
    id: string,
    updates: Record<string, unknown>,
    options: AgentUpdateOptions
  ): Promise<void> {
    const key = `agent:${id}`
    const plan = planAgentRecordUpdate({ updates, now: new Date().toISOString() })
    const guardsMemory = options.expectedMemory !== undefined
    const readPaths = (paths: readonly string[]) =>
      Promise.all(paths.map((path) => client.sendCommand<string | null>(['JSON.GET', key, path])))
    let lastAnswer: unknown = null
    for (let attempt = 0; attempt < AGENT_UPDATE_TYPE_TRIES; attempt += 1) {
      // Each path's raw answer, so the script can compare the very text it reads again. Separate
      // commands in one round trip; a mix of old and new answers cannot match the record as it is.
      const [fields, memory] = await Promise.all([
        readPaths(AGENT_TYPE_SOURCE_PATHS),
        guardsMemory ? readPaths(AGENT_MEMORY_SOURCE_PATHS) : Promise.resolve(null)
      ])
      if (fields.some((field) => field === null) || memory?.some((answer) => answer === null)) {
        throw new Error('Agent not found')
      }
      if (memory && !agentMemoryBaseMatches(agentMemoryFieldsFromAnswers(memory as string[]), options.expectedMemory)) {
        throw new AgentMemorySettingsConflictError()
      }
      lastAnswer = await client.eval(UPDATE_AGENT_FIELDS_SCRIPT, {
        keys: [key],
        arguments: agentUpdateScriptArguments(plan, fields.join('\n'), memory ? memory.join('\n') : null)
      })
      if (lastAnswer === 'OK') return
      if (lastAnswer === 'MISSING') throw new Error('Agent not found')
      if (lastAnswer !== 'TYPE_CHANGED' && lastAnswer !== 'MEMORY_CHANGED') {
        throw new Error(`The update of agent ${id} answered ${String(lastAnswer)}.`)
      }
    }
    // A concurrent change, not a server fault: `PUT /api/agents/[id]` answers 409.
    if (lastAnswer === 'MEMORY_CHANGED') throw new AgentMemorySettingsConflictError()
    throw new AgentUpdateConflictError(
      `The type of agent ${id} kept changing while it was being saved (${AGENT_UPDATE_TYPE_TRIES} tries), so nothing was saved. Try again.`
    )
  }

  /**
   * BL-914: write only the fields the caller passed to a Subagent record, each by path, in one
   * step inside Redis (`UPDATE_SUBAGENT_FIELDS_SCRIPT`; the rules are `planSubagentRecordUpdate`'s
   * in `subagentRecordUpdate.ts`, the agent update's since BL-768). `writes` is what
   * `buildSubagentWrites` gives: the fields the request names, a `null` removing a field of
   * `SUBAGENT_REMOVES_ON_NULL` and a key or entry of a block, never `id`, `user_id`, `slug` or
   * `created_at`. Everything is checked first: a refused save throws `AgentUpdateRejectedError`
   * (a 400) and writes nothing. Answers `false`, writing nothing, when the Subagent is gone (a
   * delete landed first): it is not made again.
   */
  async updateSubagent(id: string, writes: Record<string, unknown>): Promise<boolean> {
    const plan = planSubagentRecordUpdate({ writes, now: new Date().toISOString() })
    return this.execute(async (client) => {
      const answer = await client.eval(UPDATE_SUBAGENT_FIELDS_SCRIPT, {
        keys: [`subagent:${id}`],
        arguments: [serializeAgentRecordPlan(plan.ops)]
      })
      if (answer === 'OK') return true
      if (answer === 'MISSING') return false
      throw new Error(`The update of Subagent ${id} answered ${String(answer)}.`)
    })
  }

  /**
   * BL-770: how an agent record is stored, for the `/fix` route: `json` (with the record), `string`
   * (with the raw stored text, never parsed here), `none`, or `other`.
   */
  async readAgentRecordStorage(
    id: string
  ): Promise<{ type: 'none' } | { type: 'other' } | { type: 'json'; record: unknown } | { type: 'string'; raw: string }> {
    return this.execute(async (client) => {
      const key = `agent:${id}`
      const type = await client.type(key)
      if (type === 'none') return { type: 'none' as const }
      if (type === 'ReJSON-RL' || type === 'json' || type === 'JSON') {
        return { type: 'json' as const, record: await client.json.get(key) }
      }
      if (type === 'string') return { type: 'string' as const, raw: (await client.get(key)) ?? '' }
      return { type: 'other' as const }
    })
  }

  /**
   * BL-770: replace an agent record stored as a JSON string with the RedisJSON `record`, only while
   * the stored string is still `raw` (`REPLACE_STRING_AGENT_RECORD_SCRIPT`). `false` when it changed.
   */
  async replaceStringAgentRecord(id: string, raw: string, record: Record<string, unknown>): Promise<boolean> {
    return this.execute(async (client) => {
      const answer = await client.eval(REPLACE_STRING_AGENT_RECORD_SCRIPT, {
        keys: [`agent:${id}`],
        arguments: [raw, JSON.stringify(record)]
      })
      return answer === 'OK'
    })
  }

  /**
   * Returns the holds it released (BL-539), so the delete route can tell every open tab of
   * those chats; this module stays free of the publisher.
   */
  async deleteAgent(id: string): Promise<{ releasedHolds: Array<{ sessionId: string; zipId: string }> }> {
    // BL-608: three sweeps below (wake hooks, schedules, zip holds) find the agent's records
    // through `agent.user_id`, and each reads the record strictly, so a failed read stops the
    // delete there. Read it once here too, before anything is deleted, so a read that fails
    // from the start costs nothing: before, `redis.get` answered a failed read with null, those
    // sweeps found nothing, and the agent was deleted anyway with its hooks, schedules, and
    // holds left behind.
    await this.json.get(`agent:${id}`)
    // Dynamic import avoids a redis.ts <-> memoryMedia.ts module cycle. Media cleanup
    // is part of the destructive contract: fail before deleting the agent if it fails.
    const { sweepAgentMemoryMedia } = await import('$lib/server/services/memory/memoryMedia')
    await sweepAgentMemoryMedia(id)
    // SA-113 P2 (DL-113-02): DMs addressed to this agent go with it, along with its inbox
    // and sent indexes. DMs it SENT stay with their recipients, carrying the sender name
    // frozen at send time, so the other side of a conversation does not go blank. Same
    // dynamic-import reason as above.
    const { sweepAgentDms } = await import('$lib/server/services/dm/dmStore')
    await sweepAgentDms(id)
    // SA-113 P3 (DL-113-09): a wake-up webhook pointing at a deleted agent is a live
    // credential that can only ever produce a 404, so it goes with the agent. This runs
    // BEFORE the agent record is deleted, because the sweep reads `agent.user_id` to find
    // the hook index.
    const { sweepAgentWakeHooks } = await import('$lib/server/services/dm/wakeHookStore')
    await sweepAgentWakeHooks(id)
    // SA-115 P3 (DL-115-12): a schedule pointing at a deleted agent is a clock that can
    // only ever fail its recipient check every minute, so it goes with the agent. Same
    // BEFORE-the-record-delete reason as the two sweeps above: it reads `agent.user_id`
    // to find the schedule index.
    const { sweepAgentSchedules } = await import(
      '$lib/server/services/schedules/scheduleStore'
    )
    await sweepAgentSchedules(id)
    // SA-117 P1 (DL-117-09): a managed CLI run credential naming a deleted agent is a live
    // credential that authenticates as nobody, so it goes with the agent. Its index is
    // agent-scoped rather than user-scoped, so unlike the three sweeps above this one does not
    // need `agent.user_id` — it still runs BEFORE the record delete so the destructive order
    // stays one rule instead of two. Same dynamic-import reason as above.
    const { sweepAgentRunCredentials } = await import(
      '$lib/server/services/agentRunCredentials'
    )
    await sweepAgentRunCredentials(id)
    // SA-129 P2b (BL-351): the agent's holds (`unzipped_item` records with its `agentId`) go
    // with it: no other agent can release them, so each would keep its file open for good.
    // Session-scoped keys, found in the chats of the agent's user (BL-539), so BEFORE the record
    // delete like the sweeps above; same dynamic-import reason as above.
    const { markAgentBeingDeleted, releaseDeletedAgentHolds } = await import('$lib/server/services/zipHolds')
    // BL-606: from here until the record is gone, no turn of this agent may write zip state: the
    // release goes chat by chat, and a turn that finished in a chat it had already passed would
    // hold a file for an agent that no longer exists. After the record delete, the hold step's
    // own record check refuses.
    const agentDeleteDone = markAgentBeingDeleted(id)
    let releasedHolds: Array<{ sessionId: string; zipId: string }>
    try {
      releasedHolds = await releaseDeletedAgentHolds(id)
      await this.execute(async (client) => {
        // Get agent to find user_id
        const agent = await client.json.get(`agent:${id}`)

        // Delete agent
        await client.del(`agent:${id}`)
        await client.del(`agent:${id}:subagents`)

        // Delete the agent's memory store (SA-104, DL-104-13). Memories, graduated
        // segments, and the dreaming log are agent-scoped and survive session deletion;
        // agent deletion is the explicit lifecycle end for them. KEYS is blocking but
        // safe at single-user scale.
        for (const pattern of [`memory:${id}:*`, `memseg:${id}:*`, `memdream:${id}:*`]) {
          try {
            const memoryKeys = await client.keys(pattern)
            if (memoryKeys.length > 0) {
              await client.del(memoryKeys as [string, ...string[]])
              logger.debug(`[deleteAgent] Deleted ${memoryKeys.length} keys for ${pattern}`)
            }
          } catch (memoryError) {
            console.error(`[deleteAgent] Error deleting memory keys for ${pattern}:`, memoryError)
          }
        }
        try {
          await client.del(`memdream_index:${id}`)
        } catch (dreamIndexError) {
          console.error(`[deleteAgent] Error deleting dreaming-log index:`, dreamIndexError)
        }
        try {
          await client.del(`memfold:${id}`)
        } catch (foldError) {
          console.error(`[deleteAgent] Error deleting awareness fold:`, foldError)
        }

        // Remove from user's agent list
        const agentObj = agent as any
        if (agentObj?.user_id) {
          const userId = agentObj.user_id as string
          await client.sRem(`user:${userId}:agents`, id)

          // 2026-09-19 (Josh: "when you delete an agent, it should delete everything about that
          // agent"): the agent's id also sits inside two per-user lists that are not the agent's
          // own records — a skill's `enabled_agent_ids` (Settings → Skills, enabled for chosen
          // agents) and an artifact's `agent_allowlist` (Artifacts → Agent use). Each scrub is
          // a path-scoped write of that ONE field: a whole-record write here would race the
          // skill registry and the artifacts service, which own those records.
          const scrubAgentIdList = async (key: string, path: string) => {
            const raw = await client.json.get(key, { path: `$${path}` })
            const list = Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0]) ? raw[0] : null
            if (!list || !list.includes(id)) return false
            await client.json.set(key, `$${path}`, list.filter((value) => value !== id) as any)
            return true
          }
          try {
            const skillKeys = await client.keys(`slash_command:${userId}:*`)
            let scrubbed = 0
            for (const key of skillKeys) {
              if (await scrubAgentIdList(key, '.enabled_agent_ids')) scrubbed += 1
            }
            if (scrubbed > 0) logger.debug(`[deleteAgent] Removed ${id} from ${scrubbed} skill enable-list(s)`)
          } catch (skillError) {
            console.error(`[deleteAgent] Error scrubbing skill enable-lists:`, skillError)
          }
          try {
            const artifactIds = await client.sMembers(`user:${userId}:artifacts`)
            let scrubbed = 0
            for (const artifactId of artifactIds) {
              if (await scrubAgentIdList(`artifact:${artifactId}`, '.agent_allowlist')) scrubbed += 1
            }
            if (scrubbed > 0) logger.debug(`[deleteAgent] Removed ${id} from ${scrubbed} artifact allow-list(s)`)
          } catch (artifactError) {
            console.error(`[deleteAgent] Error scrubbing artifact allow-lists:`, artifactError)
          }

          const groupIds = await client.sMembers(`user:${userId}:groups`)
          for (const groupId of groupIds) {
            try {
              const storedGroup = await client.json.get(`group:${groupId}`)
              if (!storedGroup) continue

              const group = storedGroup as unknown as GroupChatGroupRow
              const existingAgentIds = Array.isArray(group.agent_ids) ? group.agent_ids : []
              const nextAgentIds = existingAgentIds.filter((agentId) => agentId !== id)
              const removedFromRoster = nextAgentIds.length !== existingAgentIds.length

              const existingAgentSettings =
                group.agent_settings && typeof group.agent_settings === 'object'
                  ? group.agent_settings
                  : {}
              const removedAgentSettings = Object.prototype.hasOwnProperty.call(
                existingAgentSettings,
                id
              )
              const nextAgentSettings = { ...existingAgentSettings }
              delete nextAgentSettings[id]

              const requestedDriverAgentId =
                typeof group.driver_agent_id === 'string' && group.driver_agent_id.trim().length > 0
                  ? group.driver_agent_id.trim()
                  : null
              const nextDriverAgentId = group.driver_mode
                ? requestedDriverAgentId && nextAgentIds.includes(requestedDriverAgentId)
                  ? requestedDriverAgentId
                  : nextAgentIds[0] ?? null
                : requestedDriverAgentId === id
                  ? null
                  : requestedDriverAgentId
              const driverChanged = nextDriverAgentId !== requestedDriverAgentId

              if (!removedFromRoster && !removedAgentSettings && !driverChanged) {
                continue
              }

              const updatedGroup = normalizeUploadUrlsForStorageInPayload<GroupChatGroupRow>({
                ...group,
                agent_ids: nextAgentIds,
                agent_settings: nextAgentSettings,
                driver_agent_id: nextDriverAgentId,
                updated_at: new Date().toISOString()
              })

              await client.json.set(`group:${groupId}`, '$', updatedGroup as any)
            } catch (error) {
              logger.warn(`Failed to scrub deleted agent ${id} from group ${groupId}:`, error)
            }
          }
        }
      })
    } finally {
      agentDeleteDone()
    }
    return { releasedHolds }
  }

  // ===== GROUPS =====

  async getGroups(userId: string): Promise<GroupChatGroupRow[]> {
    return this.execute(async (client) => {
      const setKey = `user:${userId}:groups`
      const groupIds = await client.sMembers(setKey)

      if (groupIds.length === 0) {
        return []
      }

      const groups: GroupChatGroupRow[] = []
      for (const groupId of groupIds) {
        try {
          const groupData = await client.json.get(`group:${groupId}`)
          if (groupData) {
            groups.push(resolveUploadUrlsForBrowserInPayload(groupData as unknown as GroupChatGroupRow))
          }
        } catch (error) {
          logger.warn(`Failed to load group ${groupId}:`, error)
        }
      }

      groups.sort((a, b) => {
        const dateA = new Date(a.updated_at || a.created_at || 0).getTime()
        const dateB = new Date(b.updated_at || b.created_at || 0).getTime()
        return dateB - dateA
      })

      return groups
    })
  }

  async getGroup(id: string): Promise<GroupChatGroupRow | null> {
    return this.execute(async (client) => {
      const group = await client.json.get(`group:${id}`)
      return group
        ? resolveUploadUrlsForBrowserInPayload(group as unknown as GroupChatGroupRow)
        : null
    })
  }

  async createGroup(group: Partial<GroupChatGroupRow>): Promise<GroupChatGroupRow> {
    return this.execute(async (client) => {
      const now = new Date().toISOString()
      const maxAgents = normalizeGroupMaxAgents(group.max_agents, 4)
      const normalizedAgentIds = Array.from(
        new Set(
          (Array.isArray(group.agent_ids) ? group.agent_ids : [])
            .map((id) => (typeof id === 'string' ? id.trim() : ''))
            .filter(Boolean)
        )
      ).slice(0, maxAgents)
      const driverMode = group.driver_mode === true
      const requestedDriverAgentId =
        typeof group.driver_agent_id === 'string' && group.driver_agent_id.trim().length > 0
          ? group.driver_agent_id.trim()
          : null
      const resolvedDriverAgentId = driverMode
        ? requestedDriverAgentId && normalizedAgentIds.includes(requestedDriverAgentId)
          ? requestedDriverAgentId
          : normalizedAgentIds[0] ?? null
        : requestedDriverAgentId
      const sharedToolsSource: unknown[] = Array.isArray(group.shared_tools)
        ? group.shared_tools
        : Array.isArray(group.zip_settings?.shared_tools)
          ? group.zip_settings.shared_tools
          : []
      const normalizedSharedTools = Array.from(
        new Set(
          sharedToolsSource
            .map((toolName: unknown) => (typeof toolName === 'string' ? toolName.trim() : ''))
            .filter((toolName): toolName is string => toolName.length > 0)
        )
      )
      const groupData: GroupChatGroupRow = {
        id: group.id!,
        user_id: group.user_id!,
        name: group.name || 'New Group',
        avatar_url:
          typeof group.avatar_url === 'string' && group.avatar_url.trim().length > 0
            ? group.avatar_url.trim()
            : undefined,
        avatar_icon_ref: group.avatar_icon_ref ?? undefined,
        avatar_icon_fit: group.avatar_icon_fit ?? undefined,
        description: group.description,
        agent_ids: normalizedAgentIds,
        agent_settings:
          group.agent_settings && typeof group.agent_settings === 'object'
            ? group.agent_settings
            : {},
        group_system_prompt:
          typeof group.group_system_prompt === 'string'
            ? group.group_system_prompt
            : undefined,
        max_followups_total: normalizeGroupMaxFollowupsTotal(group.max_followups_total, 5),
        max_agents: maxAgents,
        driver_mode: driverMode,
        driver_agent_id: resolvedDriverAgentId,
        shared_tools: normalizedSharedTools,
        zip_settings: null,
        created_at: group.created_at || now,
        updated_at: now
      }
      const storageGroupData = normalizeUploadUrlsForStorageInPayload(groupData)

      await client.json.set(`group:${groupData.id}`, '$', storageGroupData as any)
      await client.sAdd(`user:${groupData.user_id}:groups`, groupData.id)

      return resolveUploadUrlsForBrowserInPayload(storageGroupData)
    })
  }

  async updateGroup(id: string, updates: Partial<GroupChatGroupRow>): Promise<void> {
    return this.execute(async (client) => {
      const existing = await client.json.get(`group:${id}`)
      if (!existing) throw new Error('Group not found')

      const merged = {
        ...(existing as unknown as GroupChatGroupRow),
        ...updates
      }
      const maxAgents = normalizeGroupMaxAgents(merged.max_agents, 4)
      const normalizedAgentIds = Array.from(
        new Set(
          (Array.isArray(merged.agent_ids) ? merged.agent_ids : [])
            .map((agentId) => (typeof agentId === 'string' ? agentId.trim() : ''))
            .filter(Boolean)
        )
      ).slice(0, maxAgents)
      const driverMode = merged.driver_mode === true
      const requestedDriverAgentId =
        typeof merged.driver_agent_id === 'string' && merged.driver_agent_id.trim().length > 0
          ? merged.driver_agent_id.trim()
          : null
      const resolvedDriverAgentId = driverMode
        ? requestedDriverAgentId && normalizedAgentIds.includes(requestedDriverAgentId)
          ? requestedDriverAgentId
          : normalizedAgentIds[0] ?? null
        : requestedDriverAgentId
      const sharedToolsSource: unknown[] = Array.isArray(merged.shared_tools)
        ? merged.shared_tools
        : Array.isArray((merged as any)?.zip_settings?.shared_tools)
          ? (merged as any).zip_settings.shared_tools
          : []
      const normalizedSharedTools = Array.from(
        new Set(
          sharedToolsSource
            .map((toolName: unknown) => (typeof toolName === 'string' ? toolName.trim() : ''))
            .filter((toolName): toolName is string => toolName.length > 0)
        )
      )

      const updated: GroupChatGroupRow = {
        ...merged,
        avatar_url:
          typeof merged.avatar_url === 'string' && merged.avatar_url.trim().length > 0
            ? merged.avatar_url.trim()
            : undefined,
        avatar_icon_ref: merged.avatar_icon_ref ?? undefined,
        avatar_icon_fit: merged.avatar_icon_fit ?? undefined,
        agent_ids: normalizedAgentIds,
        max_followups_total: normalizeGroupMaxFollowupsTotal(merged.max_followups_total, 5),
        max_agents: maxAgents,
        driver_mode: driverMode,
        driver_agent_id: resolvedDriverAgentId,
        shared_tools: normalizedSharedTools,
        zip_settings: null,
        updated_at: new Date().toISOString()
      }
      // BL-482: an empty Group System Prompt is no prompt. Settings sends `''` for a cleared prompt
      // (it sent `undefined`, which JSON drops, so the merge above kept the old one); the stored
      // group then has no `group_system_prompt` at all, and the next group turn adds no custom
      // prompt block.
      const groupPrompt = (merged as { group_system_prompt?: unknown }).group_system_prompt
      if (groupPrompt === null || (typeof groupPrompt === 'string' && groupPrompt.trim() === '')) {
        delete updated.group_system_prompt
      }
      const storageUpdated = normalizeUploadUrlsForStorageInPayload(updated)

      await client.json.set(`group:${id}`, '$', storageUpdated as any)
    })
  }

  async deleteGroup(id: string): Promise<void> {
    return this.execute(async (client) => {
      const group = await client.json.get(`group:${id}`)
      await client.del(`group:${id}`)

      const groupObj = group as any
      if (groupObj?.user_id) {
        await client.sRem(`user:${groupObj.user_id}:groups`, id)
      }
    })
  }

  // ===== VOICE PROFILES =====

  async getVoiceProfiles(userId: string): Promise<VoiceProfileRecord[]> {
    return this.execute(async (client) => {
      const setKey = `user:${userId}:voice_profiles`
      const profileIds = await client.sMembers(setKey)

      if (profileIds.length === 0) {
        return []
      }

      const profiles: VoiceProfileRecord[] = []
      for (const profileId of profileIds) {
        try {
          const profile = await client.json.get(`voice_profile:${profileId}`)
          if (profile) {
            profiles.push(profile as unknown as VoiceProfileRecord)
          }
        } catch (error) {
          logger.warn(`Failed to load voice profile ${profileId}:`, error)
        }
      }

      profiles.sort((a, b) => {
        const dateA = new Date(a.updated_at || a.created_at || 0).getTime()
        const dateB = new Date(b.updated_at || b.created_at || 0).getTime()
        return dateB - dateA
      })

      return profiles
    })
  }

  async getVoiceProfile(id: string): Promise<VoiceProfileRecord | null> {
    return this.execute(async (client) => {
      const profile = await client.json.get(`voice_profile:${id}`)
      return (profile as unknown as VoiceProfileRecord) ?? null
    })
  }

  async createVoiceProfile(profile: VoiceProfileRecord): Promise<VoiceProfileRecord> {
    return this.execute(async (client) => {
      await client.json.set(`voice_profile:${profile.id}`, '$', profile as any)
      await client.sAdd(`user:${profile.user_id}:voice_profiles`, profile.id)
      return profile
    })
  }

  async deleteVoiceProfile(id: string, userId: string): Promise<void> {
    return this.execute(async (client) => {
      await client.del(`voice_profile:${id}`)
      await client.sRem(`user:${userId}:voice_profiles`, id)
    })
  }

  // ===== USER SETTINGS =====

  async getUserSettings(userId: string): Promise<UserSettingsRow | null> {
    try {
      const settings = await this.json.get(`user:${userId}:settings`, '$')
      return settings
        ? resolveUploadUrlsForBrowserInPayload(settings as UserSettingsRow)
        : null
    } catch (error) {
      // Null strictly means "no settings saved yet". Redis failures rethrow so callers
      // fail loudly instead of treating an outage as an empty profile — a swallowed read
      // here also let updateUserSettings rebuild from null and wipe saved fields (G-0031).
      console.error('Error getting user settings:', error)
      throw error
    }
  }

  async updateUserSettings(userId: string, updates: { 
    displayName?: string | null, 
    avatar_url?: string | null, 
    avatar_icon_ref?: UserSettingsRow['avatar_icon_ref'],
    avatar_icon_fit?: UserSettingsRow['avatar_icon_fit'],
    always_show_zip_borders?: boolean,
    show_zip_visual_indicators?: boolean,
    // New visual indicator settings
    show_zipped_badges?: boolean,
    zipped_badges_hover_only?: boolean,
    show_zipped_borders?: boolean,
    zipped_borders_hover_only?: boolean,
    show_unzipped_badges?: boolean,
    unzipped_badges_hover_only?: boolean,
    show_unzipped_borders?: boolean,
    unzipped_borders_hover_only?: boolean,
    // Global zip settings
    global_zip_settings?: any,
    global_auto_compact_settings?: any,
    global_tool_grid_settings?: any,
    global_chat_settings?: any,
    ui_settings?: any,
    admin_settings?: any,
    global_custom_system_prompt?: string,
    upload_settings?: any,
    upload_provider?: string,
    voice_settings?: VoiceSettings,
    goons_settings?: GoonsSettings,
    onboarding_settings?: UserSettingsRow['onboarding_settings']
  }): Promise<UserSettingsRow> {
    return this.execute(async (client) => {
      // Get existing or create new with defaults
      const existing = await this.getUserSettings(userId)
      
      const settingsData: UserSettingsRow = {
        id: existing?.id || `settings_${userId}`,
        user_id: userId,
        displayName: updates.displayName !== undefined ? (updates.displayName === null ? undefined : updates.displayName) : existing?.displayName,
        avatar_url: updates.avatar_url !== undefined ? (updates.avatar_url === null ? undefined : updates.avatar_url) : existing?.avatar_url,
        avatar_icon_ref: updates.avatar_icon_ref !== undefined ? updates.avatar_icon_ref : existing?.avatar_icon_ref,
        avatar_icon_fit: updates.avatar_icon_fit !== undefined ? updates.avatar_icon_fit : existing?.avatar_icon_fit,
        always_show_zip_borders: updates.always_show_zip_borders !== undefined ? updates.always_show_zip_borders : existing?.always_show_zip_borders,
        // New visual indicator settings
        show_zipped_badges: updates.show_zipped_badges !== undefined ? updates.show_zipped_badges : existing?.show_zipped_badges,
        zipped_badges_hover_only: updates.zipped_badges_hover_only !== undefined ? updates.zipped_badges_hover_only : existing?.zipped_badges_hover_only,
        show_zipped_borders: updates.show_zipped_borders !== undefined ? updates.show_zipped_borders : existing?.show_zipped_borders,
        zipped_borders_hover_only: updates.zipped_borders_hover_only !== undefined ? updates.zipped_borders_hover_only : existing?.zipped_borders_hover_only,
        show_unzipped_badges: updates.show_unzipped_badges !== undefined ? updates.show_unzipped_badges : existing?.show_unzipped_badges,
        unzipped_badges_hover_only: updates.unzipped_badges_hover_only !== undefined ? updates.unzipped_badges_hover_only : existing?.unzipped_badges_hover_only,
        show_unzipped_borders: updates.show_unzipped_borders !== undefined ? updates.show_unzipped_borders : existing?.show_unzipped_borders,
        unzipped_borders_hover_only: updates.unzipped_borders_hover_only !== undefined ? updates.unzipped_borders_hover_only : existing?.unzipped_borders_hover_only,
        // Global zip settings
        global_zip_settings: updates.global_zip_settings !== undefined ? updates.global_zip_settings : existing?.global_zip_settings,
        global_auto_compact_settings:
          updates.global_auto_compact_settings !== undefined
            ? updates.global_auto_compact_settings
            : (existing as any)?.global_auto_compact_settings,
        global_tool_grid_settings:
          updates.global_tool_grid_settings !== undefined
            ? updates.global_tool_grid_settings
            : existing?.global_tool_grid_settings,
        // SA-114 P3 (DL-114-01): the busy-send mode.
        global_chat_settings:
          updates.global_chat_settings !== undefined
            ? updates.global_chat_settings
            : (existing as any)?.global_chat_settings,
        ui_settings: updates.ui_settings !== undefined ? updates.ui_settings : existing?.ui_settings,
        admin_settings: updates.admin_settings !== undefined ? updates.admin_settings : (existing as any)?.admin_settings,
        global_custom_system_prompt: updates.global_custom_system_prompt !== undefined ? updates.global_custom_system_prompt : existing?.global_custom_system_prompt,
        upload_settings: updates.upload_settings !== undefined ? updates.upload_settings : existing?.upload_settings,
        upload_provider: updates.upload_provider !== undefined ? updates.upload_provider : existing?.upload_provider,
        voice_settings: updates.voice_settings !== undefined ? updates.voice_settings : existing?.voice_settings,
        goons_settings: updates.goons_settings !== undefined ? updates.goons_settings : (existing as any)?.goons_settings,
        onboarding_settings:
          updates.onboarding_settings !== undefined
            ? updates.onboarding_settings
            : (existing as any)?.onboarding_settings,
        created_at: existing?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      
      // Handle show_zip_visual_indicators as part of ui_settings
      if (updates.show_zip_visual_indicators !== undefined) {
        settingsData.ui_settings = settingsData.ui_settings || {}
        settingsData.ui_settings.show_zip_visual_indicators = updates.show_zip_visual_indicators
      }
      
      const storageSettingsData = normalizeUploadUrlsForStorageInPayload(settingsData)
      await storeUserSettingsForClient(client, userId, storageSettingsData)
      
      return resolveUploadUrlsForBrowserInPayload(storageSettingsData)
    })
  }

  async saveUserSettings(userId: string, completeSettings: any): Promise<UserSettingsRow> {
    return this.execute(async (client) => {
      const user = await this.getUserSettings(userId)
      const updated: UserSettingsRow = {
        id: user?.id || `settings_${userId}`,
        user_id: userId,
        displayName: user?.displayName,
        avatar_url: user?.avatar_url,
        avatar_icon_ref: user?.avatar_icon_ref,
        avatar_icon_fit: user?.avatar_icon_fit,
        always_show_zip_borders: user?.always_show_zip_borders,
        global_custom_system_prompt: user?.global_custom_system_prompt,
        global_auto_compact_settings: (user as any)?.global_auto_compact_settings,
        ui_settings: completeSettings, // Replace entire settings object
        admin_settings: (user as any)?.admin_settings,
        upload_settings: user?.upload_settings,
        upload_provider: user?.upload_provider,
        voice_settings: user?.voice_settings,
        goons_settings: (user as any)?.goons_settings,
        created_at: user?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      
      const storageUpdated = normalizeUploadUrlsForStorageInPayload(updated)
      await storeUserSettingsForClient(client, userId, storageUpdated)
      return resolveUploadUrlsForBrowserInPayload(storageUpdated)
    })
  }

  // ===== PROJECTS =====

  async getProjects(userId: string): Promise<ProjectRow[]> {
    return this.execute(async (client) => {
      // Get all project keys for this user
      const pattern = `project:${userId}:*`
      const keys = await client.keys(pattern)
      
      if (keys.length === 0) {
        return []
      }
      
      // Get all project data using RedisJSON
      const projects: ProjectRow[] = []
      for (const key of keys) {
        try {
          const projectData = await client.json.get(key)
          if (projectData) {
            projects.push(projectData as unknown as ProjectRow)
          }
        } catch (error) {
          logger.warn(`Failed to load project ${key}:`, error)
        }
      }
      
      return projects.sort((a, b) => 
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
    })
  }

  async saveProject(project: ProjectRow): Promise<ProjectRow> {
    return this.execute(async (client) => {
      const key = `project:${project.user_id}:${project.id}`
      await client.json.set(key, '$', project as any)
      return project
    })
  }

  async updateProject(projectId: string, userId: string, updates: Partial<ProjectRow>): Promise<ProjectRow> {
    return this.execute(async (client) => {
      const key = `project:${userId}:${projectId}`
      
      // Get existing project
      const existing = await client.json.get(key)
      if (!existing) throw new Error('Project not found')
      
      // Merge updates
      const updated = {
        ...(existing as any),
        ...updates,
        updated_at: new Date().toISOString()
      }
      
      // Save back
      await client.json.set(key, '$', updated as any)
      
      return updated as ProjectRow
    })
  }

  async deleteProject(projectId: string, userId: string): Promise<void> {
    return this.execute(async (client) => {
      const key = `project:${userId}:${projectId}`
      await client.del(key)
    })
  }

  async getProjectPreferences(userId: string): Promise<ProjectPreferences | null> {
    return this.execute(async (client) => {
      try {
        const prefs = await client.json.get(`project_prefs:${userId}`)
        if (!isProjectPreferences(prefs)) {
          if (prefs) {
            logger.warn('[Redis] Project preferences missing required fields', { userId })
          }
          return null
        }
        return prefs
      } catch (error) {
        console.error('[Redis] Failed to load project preferences:', error)
        return null
      }
    })
  }

  async saveProjectPreferences(
    userId: string,
    updates: { default_workspace_path?: string | null }
  ): Promise<ProjectPreferences> {
    return this.execute(async (client) => {
      const key = `project_prefs:${userId}`
      const existing = (await client.json.get(key)) as ProjectPreferences | null
      const now = new Date().toISOString()
      const trimmed = updates.default_workspace_path?.trim()
      const prefs: ProjectPreferences = {
        user_id: userId,
        default_workspace_path: trimmed && trimmed.length > 0 ? trimmed : undefined,
        created_at: existing?.created_at ?? now,
        updated_at: now
      }
      await client.json.set(key, '$', prefs as any)
      return prefs
    })
  }

  // ===== REDIS OPERATIONS =====

  // Generic Redis operations for system prompts and other data
  async get(key: string): Promise<any> {
    return this.execute(async (client) => {
      try {
        // First check if the key exists and what type it is
        const exists = await client.exists(key)
        if (!exists) return null
        
        const type = await client.type(key)
        
        // If it's a JSON type, use JSON.GET.
        // Different Redis clients/adapters can report this as ReJSON-RL or json.
        if (type === 'ReJSON-RL' || type === 'json' || type === 'JSON') {
          const value = await client.json.get(key)
          return value
        } else {
          // Regular strings (system prompts, simple values)
          const value = await client.get(key)
          return this.safeJsonParse(value)
        }
      } catch (error) {
        console.error('Error getting key:', key, error)
        return null
      }
    })
  }

  async set(key: string, value: any): Promise<void> {
    return this.execute(async (client) => {
      if (typeof value === 'object' && value !== null) {
        // Store objects using RedisJSON for native JSON operations
        await client.json.set(key, '$', value)
      } else {
        // Store strings and primitives as regular Redis strings (system prompts, etc.)
        await client.set(key, String(value))
      }
    })
  }

  async del(key: string): Promise<void> {
    return this.execute(async (client) => {
      await client.del(key)
    })
  }

  async exists(key: string): Promise<boolean> {
    return this.execute(async (client) => {
      return (await client.exists(key)) === 1
    })
  }

  async keys(pattern: string): Promise<string[]> {
    return this.execute(async (client) => {
      return await client.keys(pattern)
    })
  }

  // Set operations
  async sMembers(key: string): Promise<string[]> {
    return this.execute(async (client) => {
      return await client.sMembers(key)
    })
  }

  async sAdd(key: string, member: string): Promise<void> {
    return this.execute(async (client) => {
      await client.sAdd(key, member)
    })
  }

  async sRem(key: string, member: string): Promise<void> {
    return this.execute(async (client) => {
      await client.sRem(key, member)
    })
  }

  // List operations
  async lRange(key: string, start: number = 0, stop: number = -1): Promise<string[]> {
    return this.execute(async (client) => {
      return await client.lRange(key, start, stop)
    })
  }

  async rPush(key: string, element: string): Promise<void> {
    return this.execute(async (client) => {
      await client.rPush(key, element)
    })
  }

  async lRem(key: string, count: number, element: string): Promise<void> {
    return this.execute(async (client) => {
      await client.lRem(key, count, element)
    })
  }

  // ===== FOLDERS =====

  async getFolders(userId: string): Promise<ChatFolderRow[]> {
    return this.execute(async (client) => {
      try {
        // Get all folder IDs for user
        const folderIds = await client.sMembers(`user:${userId}:folders`)
        
        if (!folderIds || folderIds.length === 0) {
          // Create default folder if none exist
          const defaultFolder = await this.createDefaultFolder(userId)
          return [defaultFolder]
        }

        const folders: ChatFolderRow[] = []
        for (const folderId of folderIds) {
          const folder = await client.json.get(`folder:${userId}:${folderId}`)
          if (folder) {
            const folderData = folder as unknown as ChatFolderRow
            
            // Count sessions in folder (excluding archived)
            const sessionIds = await client.sMembers(`folder:${userId}:${folderId}:sessions`)
            let chatCount = 0
            let latestSessionAt: string | undefined
            for (const sessionId of sessionIds) {
              const session = await client.json.get(`session:${sessionId}`)
              if (session) {
                const sessionData = session as unknown as ChatSessionRow
                if (!sessionData.archived) {
                  chatCount++
                  latestSessionAt = this.newestTimestamp(
                    latestSessionAt,
                    sessionData.last_modified_at,
                    sessionData.created_at
                  )
                }
              }
            }
            folderData.chat_count = chatCount
            folderData.last_used_at =
              this.newestTimestamp(folderData.last_used_at, latestSessionAt, folderData.created_at) ??
              folderData.created_at
            
            folders.push(folderData)
          }
        }

        this.sortFoldersForDisplay(folders)
        
        return folders
      } catch (error) {
        console.error('[getFolders] Error:', error)
        // Return default folder on error
        const defaultFolder = await this.createDefaultFolder(userId)
        return [defaultFolder]
      }
    })
  }

  async getFolder(userId: string, folderId: string): Promise<ChatFolderRow | null> {
    return this.execute(async (client) => {
      try {
        const folder = await client.json.get(`folder:${userId}:${folderId}`)
        if (!folder) return null
        
        const folderData = folder as unknown as ChatFolderRow
        
        // Count sessions in folder
        const sessionIds = await client.sMembers(`folder:${userId}:${folderId}:sessions`)
        let chatCount = 0
        for (const sessionId of sessionIds) {
          const session = await client.json.get(`session:${sessionId}`)
          if (session) {
            const sessionData = session as unknown as ChatSessionRow
            if (!sessionData.archived) {
              chatCount++
            }
          }
        }
        folderData.chat_count = chatCount
        
        return folderData
      } catch (error) {
        console.error('[getFolder] Error:', error)
        return null
      }
    })
  }

  async createFolder(folder: ChatFolderRow): Promise<ChatFolderRow> {
    return this.execute(async (client) => {
      try {
        const now = new Date().toISOString()
        const folderToStore: ChatFolderRow = {
          ...folder,
          created_at: folder.created_at || now,
          last_used_at: folder.last_used_at || folder.created_at || now
        }

        // Store folder
        await client.json.set(`folder:${folder.user_id}:${folder.id}`, '$', folderToStore as any)
        
        // Add to user's folder set
        await client.sAdd(`user:${folder.user_id}:folders`, folder.id)
        
        // If this is the default folder, store its ID
        if (folderToStore.is_default) {
          await client.set(`user:${folder.user_id}:default_folder`, folder.id)
        }
        
        return folderToStore
      } catch (error) {
        console.error('[createFolder] Error:', error)
        throw error
      }
    })
  }

  async updateFolder(userId: string, folderId: string, updates: Partial<ChatFolderRow>): Promise<ChatFolderRow | null> {
    return this.execute(async (client) => {
      try {
        const folder = await client.json.get(`folder:${userId}:${folderId}`)
        if (!folder) return null
        
        const folderData = folder as unknown as ChatFolderRow
        
        // Update allowed fields
        if (updates.name !== undefined) folderData.name = updates.name
        if (updates.sort_order !== undefined) folderData.sort_order = updates.sort_order
        if (updates.is_expanded !== undefined) folderData.is_expanded = updates.is_expanded
        if (updates.is_default !== undefined) folderData.is_default = updates.is_default
        
        folderData.updated_at = new Date().toISOString()
        
        // Save updated folder
        await client.json.set(`folder:${userId}:${folderId}`, '$', folderData as any)
        
        return folderData
      } catch (error) {
        console.error('[updateFolder] Error:', error)
        return null
      }
    })
  }

  /**
   * Delete a folder. With `deleteSessions`, its chats go too, each through the caller's
   * `deleteSession`: the folder route passes `deleteSessionStoppingItsTurn`, which stops a chat's
   * running reply before sweeping it (`sessionDeleteTurnStop.ts`). The type makes the caller
   * choose, so this facade never sweeps a chat under a running reply by default.
   */
  async deleteFolder(
    userId: string,
    folderId: string,
    options:
      | { deleteSessions?: false }
      | {
          deleteSessions: true
          deleteSession: (sessionId: string) => Promise<unknown>
          /** The chats the dialog showed; anything else there now deletes nothing (BL-388). */
          expectedSessionIds: ReadonlyArray<string>
        } = {}
  ): Promise<{
    success: boolean
    moved_to?: string
    deleted_sessions?: number
    error?: string
    code?: string
    total_sessions?: number
    stopped_at?: { id: string; name: string; locked: boolean }
    cause?: unknown
  }> {
    if (options.deleteSessions) {
      const validation = await this.execute(async (client) => {
        try {
          // The one selection rule the delete dialog reads too (`folderChatsForDelete.ts`).
          const selection = await selectFolderChats(client, userId, folderId)
          if (!selection) {
            return { success: false as const, error: 'Folder not found', sessionIds: [] as string[] }
          }
          if (selection.folder.is_default) {
            console.error('[deleteFolder] Cannot delete default folder')
            return {
              success: false as const,
              error: 'Cannot delete default folder',
              sessionIds: [] as string[]
            }
          }

          const sessionIds = selection.chats.map((chat) => chat.id)
          if (!sameFolderChatIds(selection.chats, options.expectedSessionIds)) {
            return {
              success: false as const,
              error: FOLDER_CHANGED_MESSAGE,
              code: FOLDER_CHANGED_CODE,
              sessionIds
            }
          }
          const lockedSessionIds = selection.chats.filter((chat) => chat.locked).map((chat) => chat.id)

          if (lockedSessionIds.length > 0) {
            return {
              success: false as const,
              error:
                lockedSessionIds.length === 1
                  ? 'Folder contains a locked session. Unlock it before deleting the folder and sessions.'
                  : `Folder contains ${lockedSessionIds.length} locked sessions. Unlock them before deleting the folder and sessions.`,
              sessionIds
            }
          }

          return { success: true as const, sessionIds, chats: selection.chats }
        } catch (error) {
          console.error('[deleteFolder] Error validating delete-with-sessions:', error)
          return {
            success: false as const,
            error: 'Failed to validate folder deletion',
            sessionIds: [] as string[]
          }
        }
      })

      if (!validation.success) {
        return {
          success: false,
          error: validation.error,
          ...('code' in validation ? { code: validation.code } : {})
        }
      }

      // BL-388: a chat whose delete throws (its reply still stopping, locked meanwhile, or a
      // failure) stops the loop. The chats before it stay deleted and the folder stays, and the
      // result says how far it got; the caller's error is handed back as `cause`.
      const total = validation.chats.length
      let deleted = 0
      for (const chat of validation.chats) {
        try {
          await options.deleteSession(chat.id)
        } catch (cause) {
          // Whether it is locked now names the reason; a failed read leaves the reason unnamed
          // ("could not be deleted"), never a delete.
          const now = await this.execute((client) => client.json.get(`session:${chat.id}`)).catch(
            () => null
          )
          return {
            success: false,
            code: 'folder_delete_stopped',
            error: `Deleted ${deleted} of ${total} chats; "${chat.name}" could not be deleted.`,
            deleted_sessions: deleted,
            total_sessions: total,
            stopped_at: {
              id: chat.id,
              name: chat.name,
              locked: (now as { locked?: unknown } | null)?.locked === true
            },
            cause
          }
        }
        deleted++
      }

      return this.execute(async (client) => {
        try {
          // A chat that arrived while the loop ran keeps the folder; nothing is moved.
          const after = await selectFolderChats(client, userId, folderId)
          if (after && after.chats.length > 0) {
            return {
              success: false,
              code: 'folder_not_empty',
              error: 'A new chat arrived in the folder, so the folder remains.',
              deleted_sessions: deleted,
              total_sessions: total
            }
          }
          await client.del(`folder:${userId}:${folderId}`)
          await client.del(`folder:${userId}:${folderId}:sessions`)
          await client.sRem(`user:${userId}:folders`, folderId)

          return {
            success: true,
            deleted_sessions: deleted
          }
        } catch (error) {
          console.error('[deleteFolder] Error deleting folder after sessions:', error)
          return { success: false, error: 'Failed to delete folder' }
        }
      })
    }

    return this.execute(async (client) => {
      try {
        // Get folder to check if it's default
        const folder = await client.json.get(`folder:${userId}:${folderId}`)
        if (!folder) {
          return { success: false, error: 'Folder not found' }
        }
        
        const folderData = folder as unknown as ChatFolderRow
        
        // Cannot delete default folder
        if (folderData.is_default) {
          console.error('[deleteFolder] Cannot delete default folder')
          return { success: false, error: 'Cannot delete default folder' }
        }
        
        // Get or create default folder
        let defaultFolderId = await client.get(`user:${userId}:default_folder`)
        
        if (!defaultFolderId) {
          // Create default folder if it doesn't exist
          const defaultFolder = await this.createDefaultFolder(userId)
          defaultFolderId = defaultFolder.id
        }
        
        // Move all sessions from this folder to default folder
        const sessionIds = await client.sMembers(`folder:${userId}:${folderId}:sessions`)
        
        for (const sessionId of sessionIds) {
          const session = await client.json.get(`session:${sessionId}`)
          if (session) {
            const sessionData = session as unknown as ChatSessionRow
            sessionData.folder_id = defaultFolderId
            await client.json.set(`session:${sessionId}`, '$', sessionData as any)
            await client.sAdd(`folder:${userId}:${defaultFolderId}:sessions`, sessionId)
          }
        }
        await this.touchFolderLastUsed(client, userId, defaultFolderId)
        
        // Delete folder references
        await client.del(`folder:${userId}:${folderId}`)
        await client.del(`folder:${userId}:${folderId}:sessions`)
        await client.sRem(`user:${userId}:folders`, folderId)
        
        return { success: true, moved_to: defaultFolderId }
      } catch (error) {
        console.error('[deleteFolder] Error:', error)
        return { success: false, error: 'Failed to delete folder' }
      }
    })
  }

  async getDefaultFolder(userId: string): Promise<ChatFolderRow> {
    return this.execute(async (client) => {
      try {
        // Check for existing default folder
        const defaultFolderId = await client.get(`user:${userId}:default_folder`)
        
        if (defaultFolderId) {
          const folder = await client.json.get(`folder:${userId}:${defaultFolderId}`)
          if (folder) {
            return folder as unknown as ChatFolderRow
          }
        }
        
        // Create default folder if it doesn't exist
        return await this.createDefaultFolder(userId)
      } catch (error) {
        console.error('[getDefaultFolder] Error:', error)
        // Always return a default folder
        return await this.createDefaultFolder(userId)
      }
    })
  }

  private async createDefaultFolder(userId: string): Promise<ChatFolderRow> {
    return this.execute(async (client) => {
      const folderId = crypto.randomUUID()
      
      const now = new Date().toISOString()
      const defaultFolder: ChatFolderRow = {
        id: folderId,
        user_id: userId,
        name: 'My Chats',
        is_default: true,
        is_expanded: true,
        sort_order: 0,
        last_used_at: now,
        created_at: now,
        chat_count: 0
      }
      
      await client.json.set(`folder:${userId}:${folderId}`, '$', defaultFolder as any)
      await client.sAdd(`user:${userId}:folders`, folderId)
      await client.set(`user:${userId}:default_folder`, folderId)
      
      return defaultFolder
    })
  }

  async setDefaultFolder(userId: string, folderId: string): Promise<boolean> {
    return this.execute(async (client) => {
      try {
        await client.set(`user:${userId}:default_folder`, folderId)
        return true
      } catch (error) {
        console.error('[setDefaultFolder] Error:', error)
        return false
      }
    })
  }

  async moveSessionToFolder(sessionId: string, fromFolderId: string | null, toFolderId: string, userId: string): Promise<boolean> {
    return this.execute(async (client) => {
      try {
        // Get session
        const session = await client.json.get(`session:${sessionId}`)
        if (!session) return false
        
        const sessionData = session as unknown as ChatSessionRow
        
        // Remove from old folder if exists
        if (fromFolderId && fromFolderId !== toFolderId) {
          await client.sRem(`folder:${userId}:${fromFolderId}:sessions`, sessionId)
        }
        
        // Update session's folder_id
        sessionData.folder_id = toFolderId
        await client.json.set(`session:${sessionId}`, '$', sessionData as any)
        
        // Add to new folder
        await client.sAdd(`folder:${userId}:${toFolderId}:sessions`, sessionId)
        await this.touchFolderLastUsed(client, userId, toFolderId)
        
        return true
      } catch (error) {
        console.error('[moveSessionToFolder] Error:', error)
        return false
      }
    })
  }

  // ===== ZIPS =====
  
  async createZip(zip: {
    id: string
    content: string
    type: string
    tokens: number
    description: string
    metadata?: any
  }): Promise<void> {
    return this.execute(async (client) => {
      // NO MORE NORMALIZATION! Each zip has a unique ID now
      // We're using timestamp + random string, so no duplicates possible
      
      const zipData = {
        ...zip,
        created_at: new Date().toISOString()
      }
      
      // Store using RedisJSON for native JSON operations
      // Each zip has a unique ID, no overwriting issues
      await client.json.set(`zip:${zip.id}`, '$', zipData as any)
      
      // Add to session's zip set if sessionId is provided
      if (zip.metadata?.sessionId) {
        await client.sAdd(`session:${zip.metadata.sessionId}:zips`, zip.id)
      }
      
      // NO TTL - zips persist until session is deleted
      // Zips are cleaned up when their session is deleted
    })
  }
  
  async getZip(zipId: string): Promise<any> {
    return this.execute(async (client) => {
      try {
        // NO NORMALIZATION - fetch with exact ID
        const key = `zip:${zipId}`
        const zipData = await client.json.get(key)
        if (!zipData) {
          console.warn(`[Redis] Zip not found for id ${zipId} (key: ${key})`)
        }
        return zipData
      } catch (error) {
        console.error(`[Redis] Error getting zip ${zipId}:`, error)
        return null
      }
    })
  }
  
  async getZips(zipIds: string[]): Promise<Map<string, any>> {
    return this.execute(async (client) => {
      const results = new Map()
      
      // DON'T normalize - just fetch with the exact IDs provided
      logger.debug('[Redis.getZips] Fetching zip IDs:', zipIds)
      
      // Fetch each zip individually - simpler and more reliable than pipeline
      for (const zipId of zipIds) {
        try {
          const data = await client.json.get(`zip:${zipId}`)
          if (data) {
            logger.debug(`[Redis.getZips] Found data for ${zipId}`)
            results.set(zipId, data)
          } else {
            logger.debug(`[Redis.getZips] No data for ${zipId}`)
          }
        } catch (error) {
          logger.debug(`[Redis.getZips] Error fetching ${zipId}:`, error)
        }
      }
      
      logger.debug('[Redis.getZips] Returning results for', results.size, 'zips')
      return results
    })
  }
  
  async deleteZip(zipId: string): Promise<void> {
    return this.execute(async (client) => {
      // NO NORMALIZATION - delete with exact ID
      
      // Get zip data to find session
      const zipData = await client.json.get(`zip:${zipId}`)
      
      // Remove from session's zip set if it exists
      const zipDataObj = zipData as any
      if (zipDataObj && zipDataObj.metadata?.sessionId) {
        await client.sRem(`session:${zipDataObj.metadata.sessionId}:zips`, zipId)
      }
      
      // Delete the zip
      await client.del(`zip:${zipId}`)
    })
  }
  
  async getSessionZips(sessionId: string): Promise<string[]> {
    return this.execute(async (client) => {
      const zipIds = await client.sMembers(`session:${sessionId}:zips`)
      return zipIds || []
    })
  }

  // Connection management
  async disconnect(): Promise<void> {
    if (this.client) {
      const client = this.client
      this.client = null
      if (client.isOpen) {
        await client.disconnect()
      }
    }
  }

  // Health check
  async ping(): Promise<string> {
    return this.execute(async (client) => {
      return await client.ping()
    })
  }

  // Set operations (for MCP tracking)
  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.execute(async (client) => {
      return await client.sAdd(key, members)
    })
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return this.execute(async (client) => {
      return await client.sRem(key, members)
    })
  }

  async smembers(key: string): Promise<string[]> {
    return this.execute(async (client) => {
      return await client.sMembers(key)
    })
  }

  async sismember(key: string, member: string): Promise<boolean> {
    return this.execute(async (client) => {
      const result = await client.sIsMember(key, member)
      return result === 1
    })
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    return this.execute(async (client) => {
      return await client.lPush(key, values)
    })
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.execute(async (client) => {
      return await client.lRange(key, start, stop)
    })
  }

  async ltrim(key: string, start: number, stop: number): Promise<string> {
    return this.execute(async (client) => {
      return await client.lTrim(key, start, stop)
    })
  }

  // JSON operations (for Redis 8 Stack with RedisJSON)
  json = {
    get: async (key: string, path: string = '$'): Promise<any> => {
      return this.execute(async (client) => {
        const result = await client.json.get(key, { path })
        // JSONPath $ returns array - unwrap if single result at root
        if (path === '$' && Array.isArray(result) && result.length === 1) {
          return result[0]
        }
        return result
      })
    },
    set: async (key: string, path: string, value: any): Promise<string | null> => {
      return this.execute(async (client) => {
        return await client.json.set(key, path, value)
      })
    },
    /**
     * `JSON.SET key path value XX`: writes only when the key (at `$`) or the path already
     * exists, and answers whether it wrote. BL-753: a read-then-write-whole-record edit uses it
     * so a write that lands after the record's delete does not make the record again.
     */
    setIfExists: async (key: string, path: string, value: any): Promise<boolean> => {
      return this.execute(async (client) => {
        return (await client.json.set(key, path, value, { condition: 'XX' })) === 'OK'
      })
    },
    /**
     * `JSON.SET key path value NX`: writes only when the key (at `$`) or the path does not exist
     * yet, and answers whether it wrote. BL-516: a preset create makes its record in one step, so
     * two creates of one id at the same moment cannot both write.
     */
    setIfAbsent: async (key: string, path: string, value: any): Promise<boolean> => {
      return this.execute(async (client) => {
        return (await client.json.set(key, path, value, { condition: 'NX' })) === 'OK'
      })
    },
    /**
     * BL-1371: the exact RedisJSON text of `JSON.GET key path`, unparsed, for a compare-and-set
     * (`setIfUnchanged`, `delIfUnchanged`). A `$` path answers a JSON array (`[]` when the path
     * matches nothing); a missing key answers null. A failed read throws, never null.
     */
    getRaw: async (key: string, path: string): Promise<string | null> => {
      return this.execute(async (client) => {
        const raw = await client.sendCommand<string | null>(['JSON.GET', key, path])
        if (raw !== null && typeof raw !== 'string') {
          throw new Error(`JSON.GET ${key} ${path} answered ${typeof raw}, not text.`)
        }
        return raw
      })
    },
    /**
     * BL-1371: write `value` at `path` only while the stored text there is still `expectedRaw`
     * (from `getRaw`; '' for a key that did not exist). Answers true when it wrote, false when the
     * text changed, so the caller reads again. The value is sent as `JSON.stringify(value)`, the
     * bytes `json.set` sends.
     */
    setIfUnchanged: async (key: string, path: string, expectedRaw: string, value: any): Promise<boolean> => {
      return this.execute(async (client) => {
        const answer = await client.eval(JSON_COMPARE_AND_WRITE_SCRIPT, {
          keys: [key],
          arguments: ['SET', path, expectedRaw, jsonTextOf(value)]
        })
        return readJsonCompareAndWriteAnswer(answer, 'SET', key, path)
      })
    },
    /** BL-1371: delete `path` only while its stored text is still `expectedRaw`; as `setIfUnchanged`. */
    delIfUnchanged: async (key: string, path: string, expectedRaw: string): Promise<boolean> => {
      return this.execute(async (client) => {
        const answer = await client.eval(JSON_COMPARE_AND_WRITE_SCRIPT, {
          keys: [key],
          arguments: ['DEL', path, expectedRaw]
        })
        return readJsonCompareAndWriteAnswer(answer, 'DEL', key, path)
      })
    },
    /**
     * BL-1397: move a gateway's legacy n8n Instance token into the ABSENT saved key, or (with no
     * new key document) only retire the copy, while BOTH owners still read exactly as given.
     * `MOVE_LEGACY_N8N_TOKEN_SCRIPT` (`n8nCredentialScripts.ts`) has the order and answers.
     */
    moveLegacyN8nToken: async (
      keyKey: string,
      registryKey: string,
      expectedKeyRaw: string,
      elementPath: string,
      expectedElementRaw: string,
      newKeyDocument: unknown | null
    ): Promise<LegacyN8nTokenMoveAnswer> => {
      return this.execute(async (client) => {
        const answer = await client.eval(MOVE_LEGACY_N8N_TOKEN_SCRIPT, {
          keys: [keyKey, registryKey],
          arguments: [
            expectedKeyRaw,
            elementPath,
            expectedElementRaw,
            newKeyDocument === null ? '' : jsonTextOf(newKeyDocument)
          ]
        })
        return readLegacyN8nTokenMoveAnswer(answer)
      })
    },
    /**
     * BL-1397: delete the saved n8n Instance token and every legacy copy planned from the WHOLE
     * registry text, in one step that writes only while both owners read exactly as given.
     */
    deleteN8nToken: async (
      keyKey: string,
      registryKey: string,
      expectedKeyRaw: string,
      expectedRegistryRaw: string,
      copyPaths: string[]
    ): Promise<N8nTokenDeleteAnswer> => {
      return this.execute(async (client) => {
        const answer = await client.eval(DELETE_N8N_TOKEN_SCRIPT, {
          keys: [keyKey, registryKey],
          arguments: [expectedKeyRaw, expectedRegistryRaw, JSON.stringify(copyPaths)]
        })
        return readN8nTokenDeleteAnswer(answer)
      })
    },
    /**
     * Add to one number inside a record without reading and rewriting the whole thing.
     *
     * Use this instead of read-modify-write for any counter that can be bumped while
     * another writer owns the same record (SA-113 F-P3-2: a wake hook's `useCount` bump
     * was undoing a concurrent rotate or resurrecting a revoked hook).
     */
    numIncrBy: async (key: string, path: string, by: number): Promise<any> => {
      return this.execute(async (client) => {
        return await client.json.numIncrBy(key, path, by)
      })
    }
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    return this.execute(async (client) => {
      const result = await client.expire(key, seconds)
      return result === 1
    })
  }

  /**
   * Remove a key's expiry so it lives until something deletes it.
   *
   * SA-113 P4: the drawer's Reopen turns a closed DM back into an open one, and a closed
   * DM is carrying the 30-day retention TTL. Without clearing it, a reopened DM would
   * quietly disappear while it still said "new" in the roster.
   */
  async persist(key: string): Promise<boolean> {
    return this.execute(async (client) => {
      const result = await client.persist(key)
      return result === 1
    })
  }

  async ttl(key: string): Promise<number> {
    return this.execute(async (client) => {
      return await client.ttl(key)
    })
  }

  async incr(key: string): Promise<number> {
    return this.execute(async (client) => {
      return await client.incr(key)
    })
  }
}

export async function disconnectAllRedisServices(): Promise<void> {
  await RedisService.disconnectAll()
}

// Export singleton instance
export const redis = new RedisService()
