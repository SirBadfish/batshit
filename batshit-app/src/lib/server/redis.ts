import { mergeGoonsSettingsPatch } from '$lib/goons/resolve'
import { mergeVoiceSettingsSave } from '$lib/utils/voiceSettingsSave'
import { ToolOperationsRefusal } from './toolOperationalSettingsOwner'
import { acquireToolOperationsPreservation, CHECK_TOOL_OPERATIONS_PRESERVATION_LUA, CHECK_USER_SETTINGS_ROOT_LUA, prepareToolOperationsPreservation, refuseWholeToolOperationsWrite, toolOperationsPreservationArgument, TOOL_OPERATIONS_PRESERVATION_PATHS, UserSettingsSourceChanged } from './toolOperationalSettingsPreservation'
import { CHECK_TYPED_TOOLS_LUA, makeTypedToolsSnapshot, namesTypedFileToolsWrite, readTypedToolsSnapshot, requireTypedToolsExpected, typedToolsWriteGuard, TypedToolsBaseRequiredError, TypedToolsConflictError, TypedToolsSaveUnconfirmedError } from './typedFileToolsSettingsGuard'
import { withoutSkillReadSettings } from '$lib/utils/skillSessions'
import { mcpSettingsLeaves } from '$lib/utils/agentSettingsSectionSaves'
import { mcpSettingsReadPaths, makeMcpSettingsSnapshot, requireMcpSettingsExpected, mcpSettingsWriteGuard, CHECK_MCP_SETTINGS_LUA, McpSettingsBaseRequiredError, McpSettingsConflictError, McpSettingsSaveUnconfirmedError } from './agentRecordUpdate'
import { AUTO_COMPACT_COMMON_FIELDS, validateAutoCompactChanges } from '$lib/appActions/settings/autoCompactPreferences'
import { CHECK_CONFIGURED_TTS_LUA, readConfiguredTtsSnapshot, configuredTtsIssueGuard, checkConfiguredTtsIssue, planConfiguredTtsOps, requireConfiguredTtsExpected, configuredTtsTupleChanges, voiceEngineClearSource, ConfiguredTtsBaseRequiredError, ConfiguredTtsConflictError, ConfiguredTtsSaveUnconfirmedError, ConfiguredTtsModelLockedError } from './configuredTtsGuard'
import { readAgentVoiceModelLockSource } from './modelVoiceSelectionSource'
import { CHECK_AUTO_COMPACT_LUA, readAutoCompactSnapshot, autoCompactIssueGuard, checkAutoCompactIssue, requireAutoCompactExpected, AutoCompactBaseRequiredError, AutoCompactConflictError, AutoCompactSaveUnconfirmedError } from './autoCompactGuard'
import { CHECK_MODEL_SELECTION_LUA, MODEL_SETTING_KEY_LUA, READ_CLEAR_PRESET_STATE_SCRIPT, ModelSelectionBaseRequiredError, ModelSelectionConflictError, ModelSelectionSaveUnconfirmedError, modelSelectionIssueGuard, namesModelSelection, readModelSelectionSnapshot, requireModelSelectionRevision, assertModelSelectionClear, assertModelSelectionClearOwner, prepareModelSelectionClear, type SelectionDependency, type SelectionSourceProof, type ModelSelectionClear, type ModelSelectionMutation, type ModelSelectionSnapshot } from './modelSelectionGuard'
import { isCompleteEmptyModelSelection } from '$lib/utils/modelPresetPick'
import { isAgentRuntimeSettingKey } from '$lib/utils/modelSettingsMapper'
import { CHECK_INSTRUCTIONS_LUA, instructionLeaves, readInstructionsSnapshot, requireInstructionsExpected, instructionsWriteBasis,
  instructionsIssueGuard, checkInstructionsIssue, InstructionsBaseRequiredError, InstructionsConflictError, InstructionsSaveUnconfirmedError } from './instructionsGuard'
// Direct Redis service for SvelteKit server-side operations
// Replaces batshit-server proxy with direct Redis 8 JSON support

import { logger } from '$lib/utils/logger'
import { agentSetupCache } from './services/agentSetupCache'
import { withSettingsRecordReplacement, captureSettingsLifecycle, assertSettingsLifecycle, acquireSettingsReplacementMutation, acquireSettingsMutation, type SettingsLifecycleSnapshot } from '$lib/server/services/appActions/settings/lifecycle'
import { beginSlashCommandWrite, currentSlashCommandWriteRevision, isSlashCommandMutationError } from '$lib/server/services/slashCommandRevisionProtocol'
import { escapeRedisGlob } from '$lib/utils/redisGlob'
import { validateReasoningRetentionSave } from '$lib/utils/reasoningRetention'
import { createSubjectPopulation, deletePrimaryPopulation } from '$lib/server/services/subjectPopulation'
import { admitPresetReferences, preparePresetReferences, readPresetReferenceSnapshot, completePresetReferenceWrite,
  PresetReferenceWriteError, PRESET_REFERENCE_GUARD_LUA, type PresetReferencePreparation, type PresetReferenceSnapshot } from '$lib/server/services/modelPresetReferenceGuard'
import { replaceBracedTokens } from '$lib/utils/braceScan'
import {
  firstJsonPathMatch,
  unclaimedZipsMadeByMessage,
  ZIP_RECORD_CHAT_PATHS,
  zipCandidatesOfDeletedMessage,
  zipClaimsOfMessage,
  zipRecordChat,
  zipsOfDeletedChat,
  zipsOwnedOnlyByMessage
} from '$lib/utils/messageDeletionZips'
import { MessageStillRunningError } from '$lib/server/messageStillRunningError'
import { SessionSweepReadError } from '$lib/server/sessionSweepReadError'
import { BrowserMessageMutationError, type BrowserMessageMutationPolicy } from '$lib/server/browserMessageMutation'
import { withZipStateLock } from '$lib/server/services/zipStateLock'
import {
  FOLDER_CHANGED_CODE,
  FOLDER_CHANGED_MESSAGE,
  sameFolderChatIds,
  selectFolderChats
} from '$lib/server/services/folderChatsForDelete'
import type { FixedSessionMetadata } from '$lib/utils/fixedSession'
import { AbortError, createClient, type RedisClientType } from 'redis'
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
  isRetiredPrimaryAgentType,
  normalizePrimaryAgentType,
  shouldShowReasoningByDefaultForPrimaryAgent
} from '$lib/utils/primaryAgentType'
import { isRetiredSubagentType, normalizeSubagentType } from '$lib/utils/subagentType'
import {
  AGENT_MEMORY_SOURCE_PATHS,
  AGENT_TYPE_SOURCE_PATHS,
  AgentMemorySettingsConflictError,
  AgentUpdateConflictError,
  AgentUpdateRejectedError,
  agentMemoryBaseMatches,
  agentMemoryFieldsFromAnswers,
  agentUpdateScriptArguments,
  planAgentRecordUpdate,
  serializeAgentRecordPlan,
  capturedAgentVoicePostimage,
  capturedModelSelectionUpdates,
  type AgentUpdateOptions
} from '$lib/server/agentRecordUpdate'
import { planSubagentRecordUpdate } from '$lib/server/subagentRecordUpdate'
import {
  collectTrustedClipIdsFromMetadata,
  neutralizeAllZipReferenceSyntax,
  neutralizeUntrustedClipReferenceSyntax
} from '$lib/utils/zipReferenceSafety'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'
import { resolveRedisConnectionUrl } from '$lib/server/redisConnection'
import { BATSHIT_RUNTIME_REDIS_PORTS } from '$lib/server/redisRuntimePorts'
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
import { serializeUserSettingsReservedLiterals } from './userSettingsLiteralSerialization'

const PUBLIC_SETTINGS_PRESERVATION_PATHS = Object.freeze([...TOOL_OPERATIONS_PRESERVATION_PATHS, '$.goons_settings.globalCloset'])

const STORE_SETTINGS_WITH_CUSTOM_GOON_REFS_SCRIPT = `${CUSTOM_GOON_UPLOAD_GUARD_LUA}
${PRESET_REFERENCE_GUARD_LUA}
${CHECK_TOOL_OPERATIONS_PRESERVATION_LUA}
local toolNext = cjson.decode(ARGV[1])
if type(toolNext.global_tool_grid_settings) == 'table' and toolNext.global_tool_grid_settings.typed_file_tools ~= nil then return 'TOOL_OPERATIONS_CHANGED' end
if not presetReferencesAvailable(ARGV[3]) then return 'PRESET_REFERENCE_CHANGED' end
if not customGoonUploadsAvailable(ARGV[2]) then
  return 'ASSET_UNAVAILABLE'
end
${CHECK_USER_SETTINGS_ROOT_LUA}
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
 * the new `created_at` as JSON, then (BL-903 a, only for a kept send) its `keptSend` mark as
 * JSON, written in the same step. Answers the moved record as JSON.
 */
/** BL-903 (a): a kept send's mark, `metadata.keptSend`: why it was not sent, and its send facts. */
export type KeptSendMark = { reason: string; sendFacts?: Record<string, unknown> | null }

/** Only the mark's two fields are saved, and `sendFacts` only when the send had any. */
export function keptSendMarkToSave(mark: KeptSendMark): KeptSendMark {
  const sendFacts = mark.sendFacts && typeof mark.sendFacts === 'object' && Object.keys(mark.sendFacts).length > 0
    ? mark.sendFacts
    : null
  return { reason: mark.reason, ...(sendFacts ? { sendFacts } : {}) }
}

const MOVE_MESSAGE_TO_END_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then
  return false
end
redis.call('JSON.SET', KEYS[2], '$.created_at', ARGV[2])
if ARGV[3] then
  local metadataType = redis.call('JSON.TYPE', KEYS[2], '$.metadata')
  if metadataType[1] == 'object' then
    redis.call('JSON.SET', KEYS[2], '$.metadata.keptSend', ARGV[3])
  else
    redis.call('JSON.SET', KEYS[2], '$.metadata', '{"keptSend":' .. ARGV[3] .. '}')
  end
end
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
${PRESET_REFERENCE_GUARD_LUA}
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
local guard = ARGV[5] ~= '' and cjson.decode(ARGV[5]) or {}
${CHECK_MCP_SETTINGS_LUA}
local typedTools = guard.typedTools
${CHECK_TYPED_TOOLS_LUA}
local namesVoice = false
for _, op in ipairs(cjson.decode(ARGV[1])) do if (op[2] == '$.voice_profile' and op[1] ~= 'delnull') or string.sub(op[2], 1, 16) == '$.voice_profile[' then namesVoice = true end end
if namesVoice and not guard.ttsSelection then return 'TTS_SELECTION_BASE_REQUIRED' end
if guard.ttsSelection then local tts = guard.ttsSelection; ${CHECK_CONFIGURED_TTS_LUA} end
if not presetReferencesAvailable(guard.presetReferences) then return 'PRESET_REFERENCE_CHANGED' end
local namesAutoCompact = false
for _, op in ipairs(cjson.decode(ARGV[1])) do
  if op[2] == '$.auto_compact_settings' or string.sub(op[2], 1, 24) == '$.auto_compact_settings[' then namesAutoCompact = true end
end
if namesAutoCompact and not guard.autoCompact then return 'AUTO_COMPACT_BASE_REQUIRED' end
if guard.autoCompact then local compact = guard.autoCompact; ${CHECK_AUTO_COMPACT_LUA} end
local namesInstructions = false
for _, op in ipairs(cjson.decode(ARGV[1])) do
  if op[2] == '$.system_prompt' or op[2] == '$.include_global_prompt' then namesInstructions = true end
end
if namesInstructions and not guard.instructions then return 'INSTRUCTIONS_BASE_REQUIRED' end
if guard.instructions then
  local instructions = guard.instructions
  ${CHECK_INSTRUCTIONS_LUA}
end
${MODEL_SETTING_KEY_LUA}
local currentType = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.agentType') or '[]')[1]
local resultingType = currentType
if ARGV[2] == 'set' or ARGV[2] == 'derive' or (currentType ~= 'api' and currentType ~= 'cli' and currentType ~= 'n8n') then resultingType = cjson.decode(ARGV[3]) end
local function checkModelSelection(modelSelection)
  local needsBase = currentType == 'api' or modelSelection.currentType == 'api' or resultingType == 'api'
  if needsBase and not modelSelection.clientBase then return 'MODEL_SELECTION_BASE_REQUIRED' end
  ${CHECK_MODEL_SELECTION_LUA}
end
if guard.modelSelection then
  local refusal = checkModelSelection(guard.modelSelection)
  if refusal then return refusal end
end
if ARGV[5] ~= '' then
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
if guard.ttsSelection and guard.ttsSelection.removeFishAlias then redis.call('JSON.DEL', KEYS[1], '$.voice_profile.tts.providerOptions.fish.reference_id') end
${APPLY_RECORD_OPS_LUA}
if typedTools then
  local typedRaw, mcpRaw = {}, {}
  for _, path in ipairs(typedTools.paths) do typedRaw[#typedRaw + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
  if guard.mcpSettings then for _, path in ipairs(guard.mcpSettings.paths) do mcpRaw[#mcpRaw + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end end
  return {'TYPED_TOOLS_SAVED', typedRaw, mcpRaw}
end
if guard.mcpSettings then
  local out = {'MCP_SETTINGS_SAVED'}
  for _, path in ipairs(guard.mcpSettings.paths) do out[#out + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
  return out
end
return 'OK'
`

/** How many times `updateAgent` works a changing type out again before it gives up (writing nothing). */
const AGENT_UPDATE_TYPE_TRIES = 3

class SubjectSaveUnconfirmedError extends Error {
  readonly status = 503
  readonly code = 'subject_save_unconfirmed'
  constructor() { super('The save was issued but its outcome is unconfirmed. Reload before trying again.') }
}

async function modelSelectionWriteBasis(client: RedisClientType, target: ModelSelectionSnapshot, updates: Record<string, unknown>, kind: 'agent' | 'subagent', mutation?: ModelSelectionMutation, ordinaryClear?: ModelSelectionClear) {
  const selected = Object.hasOwn(updates, 'primary_model_preset_id') ? updates.primary_model_preset_id : target.record.primary_model_preset_id
  const old = target.record.primary_model_preset_id
  const original = captureSettingsLifecycle(typeof old === 'string' && old ? [`model:${old}`] : [])
  const extraChecks: SelectionDependency[] = []
  const clear = mutation?.clear ?? ordinaryClear
  if (clear && kind === 'agent' && target.record.claude_settings == null && typeof old === 'string' && old.trim()) {
    if (old !== old.trim()) throw new ModelSelectionConflictError()
    assertModelSelectionClearOwner(clear, kind, String(target.record.id), String(target.record.user_id), old)
    const state = await client.eval(READ_CLEAR_PRESET_STATE_SCRIPT, { keys: [`model:${old}`, `user:${target.record.user_id}:models`], arguments: [old] })
    if (state === 'ABSENT') extraChecks.push({ key: `model:${old}`, paths: [['$', '']] })
    else if (state !== 'PRESENT') throw new ModelSelectionConflictError()
  }
  let source: SelectionSourceProof | undefined = typeof selected === 'string' && selected ? mutation?.source : undefined
  if (!source && typeof selected === 'string' && selected) {
    const owner = await import('$lib/server/services/modelPresetSelectionOwner')
    const dependency = await owner.readOwnedModelPresetDependency(String(target.record.user_id), selected)
    // SA-139 R5: a save that names a new preset refuses a leftover Claude Code CLI one, as the
    // selection read does (`mutation.source` already passed it). A record that only keeps an old
    // one is refused when it runs (`resolveApiSubagentModel`).
    if (Object.hasOwn(updates, 'primary_model_preset_id') && selected !== old) owner.assertNotClaudeCliPreset(dependency.preset)
    source = dependency
  }
  if (mutation?.clear) assertModelSelectionClear(mutation.clear, target, updates, kind)
  else if (mutation && (!source || source.membership.member !== selected)) throw new ModelSelectionConflictError()
  for (const lifecycle of [target.lifecycle, original, source?.lifecycle, mutation?.authority?.lifecycle]) if (lifecycle) assertSettingsLifecycle(lifecycle)
  return { source, extraChecks, issueTarget: target, expectedRevision: target.revision, lifecycle: { epoch: target.lifecycle.epoch, records: [...target.lifecycle.records, ...original.records,
    ...(source?.lifecycle.records ?? []), ...(mutation?.authority?.lifecycle?.records ?? [])] } }
}
function checkModelSelectionIssue(mutation?: ModelSelectionMutation) {
  mutation?.check()
  if (mutation?.signal?.aborted || mutation?.deadlineAt !== undefined && Date.now() >= mutation.deadlineAt) throw new ModelSelectionConflictError()
}

/**
 * BL-914: a Subagent update's by-path writes, in one step inside Redis. KEYS: the Subagent record,
 * then the keys the model selection guard names. ARGV (positional): [1] the plan's ops as JSON
 * (`planSubagentRecordUpdate`, `serializeAgentRecordPlan`), run by `APPLY_RECORD_OPS_LUA`; [2] the
 * model selection guard, `''` or JSON; [3] the instructions guard, `''` or JSON; [4] the Typed File
 * Tools guard, `''` or JSON. There is no type rule: the type fields are written only as ops, when
 * the request names them. The existence check comes before the first write, so `MISSING` writes
 * nothing and a Subagent deleted meanwhile is not made again; a key that is not JSON fails on its
 * first command. Answers `MISSING`, a guard's refusal, `OK`, or the Typed File Tools receipt.
 */
const UPDATE_SUBAGENT_FIELDS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
local shape = redis.pcall('JSON.TYPE', KEYS[1], '$')
if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return 'INVALID_RECORD' end
local typedTools = ARGV[4] and ARGV[4] ~= '' and cjson.decode(ARGV[4]) or nil
${CHECK_TYPED_TOOLS_LUA}
local namesInstructions = false
for _, op in ipairs(cjson.decode(ARGV[1])) do
  if op[2] == '$.system_prompt' or op[2] == '$.include_global_prompt' then namesInstructions = true end
end
if namesInstructions and (not ARGV[3] or ARGV[3] == '') then return 'INSTRUCTIONS_BASE_REQUIRED' end
if ARGV[3] and ARGV[3] ~= '' then
  local instructions = cjson.decode(ARGV[3])
  ${CHECK_INSTRUCTIONS_LUA}
end
${MODEL_SETTING_KEY_LUA}
if ARGV[2] and ARGV[2] ~= '' then
  local modelSelection = cjson.decode(ARGV[2])
  local currentType = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.subagentType') or '[]')[1]
  local resultingType = currentType
  for _, op in ipairs(cjson.decode(ARGV[1])) do
    if op[2] == '$.subagentType' and op[1] == 'set' then resultingType = cjson.decode(op[3]) end
  end
  local needsBase = currentType == 'api' or modelSelection.currentType == 'api' or resultingType == 'api'
  if needsBase and not modelSelection.clientBase then return 'MODEL_SELECTION_BASE_REQUIRED' end
  ${CHECK_MODEL_SELECTION_LUA}
end
${APPLY_RECORD_OPS_LUA}
if typedTools then
  local raw = {}
  for _, path in ipairs(typedTools.paths) do raw[#raw + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
  return {'TYPED_TOOLS_SAVED', raw}
end
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

/** Public native Closet edits use the existing named Goon-settings patch. Other writes
 * carry its captured storage literal, never an older whole-form copy. The existing
 * full-root CAS guards this same original snapshot through final publication. */
function publicClosetLiteral(source: PresetReferenceSnapshot, settings: UserSettingsRow, explicit: boolean): string | undefined {
  const encoded = source.exists ? new Map(source.extraRawPaths ?? []).get('$.goons_settings.globalCloset') : '[]'
  if (typeof encoded !== 'string') throw new UserSettingsSourceChanged()
  const current: unknown = JSON.parse(encoded)
  if (!Array.isArray(current) || current.length > 1) throw new UserSettingsSourceChanged()
  if (explicit) return undefined
  const goons = settings.goons_settings
  const present = !!goons && typeof goons === 'object' && Object.hasOwn(goons, 'globalCloset')
  if ((current.length === 1) !== present ||
    JSON.stringify(current[0]) !== JSON.stringify(goons?.globalCloset)) throw new UserSettingsSourceChanged()
  return current.length ? encoded.trim().slice(1, -1) : undefined
}

async function storeUserSettingsForClient(
  client: RedisClientType,
  userId: string,
  settings: UserSettingsRow,
  references: { snapshot: PresetReferenceSnapshot; preparation: PresetReferencePreparation; toolLifecycle: SettingsLifecycleSnapshot; adminExplicit: boolean; closetExplicit: boolean }
) {
  const settingsKey = `user:${userId}:settings`
  refuseWholeToolOperationsWrite({ global_tool_grid_settings: references.snapshot.record.global_tool_grid_settings })
  refuseWholeToolOperationsWrite({ global_tool_grid_settings: settings.global_tool_grid_settings })
  const tools = prepareToolOperationsPreservation(userId, settings, references.snapshot, references.toolLifecycle, references.adminExplicit)
  const closetLiteral = publicClosetLiteral(references.snapshot, settings, references.closetExplicit)
  const serialized = serializeUserSettingsReservedLiterals(settings as unknown as Record<string, unknown>, { admin: tools.literal, legacyCloset: closetLiteral })
  // A legacy Goons settings object can carry custom upload refs at any depth.
  // Check their metadata and deletion/restore claims in the same EVAL that
  // publishes the final settings value, so a reservation cannot slip between
  // a preflight check and this whole-record write.
  const customUploadKeys = await collectGoonGuardedReferences(settings.goons_settings, userId)
  const lease = await admitPresetReferences(userId, 'settings', references.snapshot, settings, references.preparation)
  let result: unknown
  let issued = false
  let toolLease: ReturnType<typeof acquireToolOperationsPreservation> | undefined
  try {
    toolLease = acquireToolOperationsPreservation(tools.snapshot)
    lease.check(); toolLease.check(); issued = true
    result = await client.eval(STORE_SETTINGS_WITH_CUSTOM_GOON_REFS_SCRIPT, {
      keys: [settingsKey],
      // Positions 4/5 stay reserved: the shared unchanged tool/root guards own ARGV[6].
      arguments: [serialized, JSON.stringify(customUploadKeys), lease.guard, '', '', toolOperationsPreservationArgument(tools.snapshot, tools.adminRaw, tools.rootRaw)]
    })
  } catch (error) {
    if (issued) { toolLease?.unknown(); lease.unknown(); throw new PresetReferenceWriteError('unknown') }
    toolLease?.settle(); lease.settle(); throw error
  }
  if (typeof result === 'string' && ['STORED', 'ASSET_UNAVAILABLE', 'PRESET_REFERENCE_CHANGED', 'TOOL_OPERATIONS_CHANGED', 'USER_SETTINGS_CHANGED'].includes(result)) toolLease?.settle(); else toolLease?.unknown()
  completePresetReferenceWrite(lease, result, ['STORED', 'ASSET_UNAVAILABLE', 'TOOL_OPERATIONS_CHANGED', 'USER_SETTINGS_CHANGED'])
  if (result === 'USER_SETTINGS_CHANGED') throw new UserSettingsSourceChanged()
  if (result === 'TOOL_OPERATIONS_CHANGED') throw new ToolOperationsRefusal()
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

// The memory-search test escape below must never match a real Batshit Redis port
// (`BATSHIT_RUNTIME_REDIS_PORTS`).
function isDesignatedMemorySearchTestUrl(redisUrl: string): boolean {
  if (process.env.VITEST_MEMORY_SEARCH !== 'true') return false
  const designated = process.env.MEMORY_TEST_REDIS_URL?.trim()
  if (!designated || redisUrl !== designated) return false
  try {
    return !BATSHIT_RUNTIME_REDIS_PORTS.has(Number(new URL(redisUrl).port || '6379'))
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
 * The chat delete's reading of a message key that exists but is not JSON (BL-1798 re-review):
 * it claims no zip, and `onUnreadable` names it, so a broken record never leaves its chat
 * undeletable. The chat delete also reads the page-saved `zipMetadata`.
 */
type ChatDeleteClaimRead = { chatDelete: { onUnreadable: (key: string) => void } }

/**
 * The fields a zip claim can live in (`zipClaimsOfMessage`), read for each message id with
 * `JSON.MGET` in batches of 200, never the whole record. JSON.MGET answers null for a missing key
 * AND for a key that is not JSON, without throwing: a missing message claims nothing. One that
 * exists but cannot be read might claim a zip, so the message delete and the unclaimed-zip removal
 * stop with `unreadable` and write nothing (BL-390); the chat delete reads it as claiming nothing
 * (`ChatDeleteClaimRead`), since it deletes that key with the chat. A failed read throws for all.
 */
async function readZipClaimFieldsOfMessages(
  client: RedisClientType,
  sessionId: string,
  ids: string[],
  unreadable: string | ChatDeleteClaimRead
): Promise<unknown[]> {
  const chatDelete = typeof unreadable === 'string' ? null : unreadable.chatDelete
  const messages: unknown[] = []
  for (let index = 0; index < ids.length; index += 200) {
    const batch = ids.slice(index, index + 200)
    const keys = batch.map((id) => `message:${sessionId}:${id}`)
    const contents = await client.json.mGet(keys, '$.content')
    const zipIds = await client.json.mGet(keys, '$.metadata.zipIds')
    const zipIdsSnake = await client.json.mGet(keys, '$.metadata.zip_ids')
    const zipReferences = await client.json.mGet(keys, '$.metadata.zipReferences')
    const zipMetadata = chatDelete ? await client.json.mGet(keys, '$.zipMetadata') : null
    for (let offset = 0; offset < batch.length; offset += 1) {
      if (contents[offset] == null) {
        if ((await client.exists(keys[offset])) > 0) {
          if (!chatDelete) throw new Error(unreadable as string)
          chatDelete.onUnreadable(keys[offset])
        }
        messages.push(null)
        continue
      }
      messages.push({
        content: firstJsonPathMatch(contents[offset]),
        ...(zipMetadata ? { zipMetadata: firstJsonPathMatch(zipMetadata[offset]) } : {}),
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

/**
 * BL-1798: the chat each zip record names (`zipRecordChat`), read by path with `JSON.MGET` in
 * batches of 200, never the whole record (a tool result can be large). A missing key, or one that
 * is not JSON, names no chat (`null`).
 */
async function readZipRecordChats(
  client: RedisClientType,
  zipIds: string[]
): Promise<Array<{ zipId: string; recordedSessionId: string | null }>> {
  const zips: Array<{ zipId: string; recordedSessionId: string | null }> = []
  for (let index = 0; index < zipIds.length; index += 200) {
    const batch = zipIds.slice(index, index + 200)
    const keys = batch.map((zipId) => `zip:${zipId}`)
    const answers: unknown[][] = []
    for (const path of ZIP_RECORD_CHAT_PATHS) answers.push(await client.json.mGet(keys, path))
    batch.forEach((zipId, offset) => {
      zips.push({
        zipId,
        recordedSessionId: zipRecordChat(answers.map((answer) => firstJsonPathMatch(answer[offset])))
      })
    })
  }
  return zips
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

/** SA-137: clear `metadata.liveFileReadSnapshot` only while its `pauseId` is ARGV[1]. */
const RETIRE_LIVE_FILE_READ_REPLAY_SCRIPT = `
local raw = redis.call('JSON.GET', KEYS[1], '$.metadata.liveFileReadSnapshot.pauseId')
if not raw then return 0 end
local ids = cjson.decode(raw)
if type(ids) ~= 'table' or ids[1] ~= ARGV[1] then return 0 end
redis.call('JSON.SET', KEYS[1], '$.metadata.liveFileReadSnapshot', 'null')
return 1
`

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
            // Only Vitest's mutable env-mock alias is updated; the real Kit namespace is readonly.
            Object.assign(envModule.env, { REDIS_URL: redisUrl })
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

  /**
   * The compiler's session read (BL-2217, decision 11 confirm review M1). `null` only when the
   * record is absent; a failed read throws `SESSION_UNAVAILABLE`, so a compile never treats an
   * unreadable Infinite Session as a regular chat and sends it different memory guidance.
   * `getSession` stays tolerant for its other readers.
   */
  async getSessionForCompile(sessionId: string): Promise<ChatSessionRow | null> {
    try {
      return await this.execute(async (client) => {
        const sessionData = await client.json.get(`session:${sessionId}`)
        return sessionData ? (sessionData as unknown as ChatSessionRow) : null
      })
    } catch (error) {
      throw new Error(
        `SESSION_UNAVAILABLE: failed to read session:${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
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
    return withSettingsRecordReplacement(`session:${session.id}`, () => this.execute(async (client) => {
      if (session.id) agentSetupCache.clearSessionRecord(session.id)
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
    }))
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
  /**
   * SA-137 (D7, P0 settle 2026-10-21): clears one paused reply's live-file-read replay field, only
   * while it is still the same pause (its `pauseId`). One script, so a newer pause of the same reply
   * written in between is never cleared. True when it cleared the field.
   */
  async retireLiveFileReadReplay(sessionId: string, messageId: string, pauseId: string): Promise<boolean> {
    return this.execute(async (client) => {
      const answer = await client.eval(RETIRE_LIVE_FILE_READ_REPLAY_SCRIPT, {
        keys: [`message:${sessionId}:${messageId}`],
        arguments: [pauseId]
      })
      return Number(answer) === 1
    })
  }

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
    return withSettingsRecordReplacement(`session:${id}`, () => this.execute(async (client) => {
      agentSetupCache.clearSessionRecord(id)
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

        // Every read the zip sweep needs comes BEFORE the first write, and a failed one throws
        // with nothing deleted (review of BL-1798, S1: the rule of BL-390's message delete and
        // BL-608's agent delete). Read after the messages and the chat's set were gone, a failed
        // read left every zip of the chat with nothing that could find it again.
        // The candidates are the chat's set and every zip a message names: its claims as a
        // message delete reads them (metadata `zipIds`, `zip_ids`, `zipReferences`, and every
        // reference in its words, an empty description and the older `{{batshit|id:…|` form
        // included; BL-1513), plus the page-saved `zipMetadata`. Only this chat's go (BL-1798): a
        // message's words and metadata can name another chat's zip (the older form and a voice
        // transcript are saved as written, and a tab posts `zipMetadata` and `zipIds`), so a zip
        // goes when its record names this chat, or names no chat and this chat's set lists it
        // (`zipsOfDeletedChat`).
        // Messages are read by path (`readZipClaimFieldsOfMessages`), and a message key that
        // exists but is not JSON claims nothing and goes with the chat (logged): refused, it left
        // the chat undeletable (BL-1798 re-review). Only a failed read stops the delete.
        let messageIds: string[]
        let zipIdsToDelete: string[]
        let zipCandidateCount: number
        const unreadableMessageKeys: string[] = []
        try {
          messageIds = (await client.lRange(`messages:${id}`, 0, -1)) ?? []
          const sessionZips = (await client.sMembers(`session:${id}:zips`)) ?? []
          const zipCandidates = new Set<string>(sessionZips)
          const messages = await readZipClaimFieldsOfMessages(client, id, messageIds, {
            chatDelete: { onUnreadable: (key) => unreadableMessageKeys.push(key) }
          })
          for (const message of messages) {
            for (const zipId of zipCandidatesOfDeletedMessage(message)) zipCandidates.add(zipId)
          }
          zipCandidateCount = zipCandidates.size
          zipIdsToDelete = zipCandidates.size === 0
            ? []
            : zipsOfDeletedChat({
                sessionId: id,
                setMembers: sessionZips,
                zips: await readZipRecordChats(client, [...zipCandidates].sort())
              })
        } catch (readError) {
          throw new SessionSweepReadError(readError)
        }
        if (unreadableMessageKeys.length > 0) {
          console.warn(
            `[deleteSession] ${unreadableMessageKeys.length} message record(s) of chat ${id} are not JSON, so they name no zip; they are deleted with the chat:`,
            unreadableMessageKeys
          )
        }
        logger.debug(`[deleteSession] Found ${messageIds.length} messages and ${zipIdsToDelete.length} of ${zipCandidateCount} named zips to delete`)

        // SA-133: session-owned boards outlive messages/episodes, never their chat.
        const whiteboardKeys = await client.keys(`whiteboard:${idPattern}:*`)
        if (whiteboardKeys.length > 0) await client.del(whiteboardKeys)
        // SA-137 P4 (D10): the chat's live file read receipt (it carries a TTL; a chat ends it first).
        await client.del(`live_file_reads:${id}`)

        for (const msgId of messageIds) {
          try {
            await client.del(`message:${id}:${msgId}`)
          } catch (msgError) {
            console.error(`[deleteSession] Error deleting message ${msgId}:`, msgError)
            // Continue with other messages
          }
        }

        // Delete the session's zip set
        try {
          await client.del(`session:${id}:zips`)
        } catch (error) {
          console.error(`[deleteSession] Error deleting session zip set:`, error)
        }

        for (const zipId of zipIdsToDelete) {
          try {
            await client.del(`zip:${zipId}`)
          } catch (zipError) {
            console.error(`[deleteSession] Error deleting zip ${zipId}:`, zipError)
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

        // SA-111 P2: the in-flight run locks (`subagent_lock:{sessionId}:{slug}`, DL-111-05).
        // They carry a TTL, but the Session Key Cleanup rule is enumerate-don't-assume: a key
        // that expires "soon" still outlives its session until it does. (SA-139 R2 removed the
        // n8n Workflow Subagent's `subagent_thread:` ids with their only writer; a leftover id
        // ends on its own 7-day TTL.)
        try {
          const subagentLockKeys = await client.keys(`subagent_lock:${idPattern}:*`)
          if (subagentLockKeys && subagentLockKeys.length > 0) {
            await client.del(subagentLockKeys as [string, ...string[]])
            logger.debug(`[deleteSession] Deleted ${subagentLockKeys.length} subagent run locks`)
          }
        } catch (threadError) {
          console.error(`[deleteSession] Error deleting subagent run locks:`, threadError)
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

        // Upload and Clip records are not this chat's to sweep: a Clip, a memory image, or
        // another chat can use the same upload. The chat's own zips went above (BL-1798).
        
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

        // Skill lifecycle metadata belongs to this chat (holds use the existing sweep above).
        await client.del(`skill_sessions:${id}`)

        // SA-120 P6: what the Judge Juice after-reply check noticed about this chat's replies
        // (`jev_post_turn:{id}` + `jev_post_turn_item:{id}:*`). Session-scoped, no TTL, so this
        // sweep is the only thing that ever removes them.
        try {
          const { sweepPostTurnRecords } = await import('$lib/server/services/postTurnCheckState')
          await sweepPostTurnRecords(id)
        } catch (postTurnError) {
          console.error(`[deleteSession] Error deleting Judge Juice after-reply records:`, postTurnError)
        }

        // SA-139 R1: a stopped Codex CLI reply's cleanup warnings (`codex_cleanup_warnings:{id}` +
        // `codex_cleanup_warning:{id}:*`), left from before Codex CLI was removed. No TTL and nothing
        // writes them any more, so this sweep is the only thing that ever removes them. The items
        // are swept by pattern: one can sit outside the set.
        try {
          const warningKeys = await client.keys(`codex_cleanup_warning:${idPattern}:*`)
          if (warningKeys.length > 0) await client.del(warningKeys)
          await client.del(`codex_cleanup_warnings:${id}`)
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
    }))
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
   * BL-903 (a): a kept send passes `keptSend` (why it was not sent, and the send facts its
   * request carried), saved on the record in the same step as the move, so every tab, after a
   * reload too, draws its "Not sent" receipt, and its Send now runs the send as it was made.
   */
  async moveMessageToEnd(
    sessionId: string,
    messageId: string,
    options: { createdAt?: string | null; keptSend?: KeptSendMark | null } = {}
  ): Promise<ChatMemoryRow | null> {
    return this.execute(async (client) => {
      if (!sessionId || !messageId) return null
      const createdAt = options.createdAt ?? new Date().toISOString()
      const moved = await client.eval(MOVE_MESSAGE_TO_END_SCRIPT, {
        keys: [`session:${sessionId}`, `message:${sessionId}:${messageId}`, `messages:${sessionId}`],
        arguments: [
          messageId,
          JSON.stringify(createdAt),
          ...(options.keptSend ? [JSON.stringify(keptSendMarkToSave(options.keptSend))] : [])
        ]
      })
      // A script answers JSON.GET's raw JSON text; nil when the message or chat is gone.
      return typeof moved === 'string' ? (JSON.parse(moved) as ChatMemoryRow) : null
    })
  }

  async updateMessage(messageId: string, sessionId: string, updates: Partial<ChatMemoryRow>, userId: string,
    options: { browserMutation?: BrowserMessageMutationPolicy; onJsonWriteAcknowledged?: () => void } = {}): Promise<void> {
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
        const acknowledgement = await client.json.set(`message:${sessionId}:${messageId}`, '$', updated)
        // Internal actual-write observation, before unrelated session touching.
        // No body field/readback can supply this same JSON.SET acknowledgement.
        if (acknowledgement === 'OK') options.onJsonWriteAcknowledged?.()
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

        const { readSkillSessionRecord, withoutSkillSessionReads } = await import('$lib/utils/skillSessions')
        const skillRecord = readSkillSessionRecord(await client.json.get(`skill_sessions:${sessionId}`), sessionId, userId)
        const keptSkillRecord = skillRecord ? withoutSkillSessionReads(skillRecord, new Set(zipIdsToDelete)) : null

        // BL-381: the route's running check, again right before the write, inside the lock: a
        // turn that started on this message since the route checked refuses it the same way.
        if (options.stillRunning?.()) throw new MessageStillRunningError()

        // One MULTI (the BL-537 rule for zip state): a lost connection applies none of it.
        const multi = client.multi()
        multi.del(messageKey)
        if (keptSkillRecord) multi.json.set(`skill_sessions:${sessionId}`, '$', keptSkillRecord as any)
        multi.lRem(`messages:${sessionId}`, 0, messageId)
        for (const zipId of zipIdsToDelete) queueZipRemoval(multi, sessionId, zipId)
        await multi.exec()
      })

      // SA-120 P6: a Judge Juice after-reply record annotates exactly one reply and goes with it.
      const { deletePostTurnRecord } = await import('$lib/server/services/postTurnCheckState')
      await deletePostTurnRecord(sessionId, messageId)
      // SA-139 R1: a leftover Codex CLI cleanup warning of this reply goes with it.
      await client.del(`codex_cleanup_warning:${sessionId}:${messageId}`)
      await client.sRem(`codex_cleanup_warnings:${sessionId}`, messageId)
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
    // A human duplicate may carry its source's read-only policy. New agents start without
    // authority; only the dedicated human policy owner can enable it after creation.
    agent = withoutSkillReadSettings(agent) as Partial<AgentRow>
    delete agent.app_action_policy
    const retentionError = validateReasoningRetentionSave(agent)
    if (retentionError) throw new Error(retentionError)
    return withSettingsRecordReplacement(`agent:${agent.id}`, () => this.execute(async (client) => {
      if (agent.id) agentSetupCache.clearAgentRecord(agent.id)
      // A new agent stores no zip row: an absent row inherits the global Tool Grid, then the
      // factory defaults (`toolGridConfig.ts`, `toolRenderMap.ts`). Stamping the defaults here
      // froze every agent at the values of its creation day (SA-126, 2026-10-19).
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
        ...agent,
        agentType: resolvedAgentType,
        show_reasoning,
        preserve_reasoning: resolvedAgentType === 'api' ? preserve_reasoning : show_reasoning ? preserve_reasoning : false,
        id: agent.id!,
        user_id: agent.user_id!,
        displayName: agent.displayName!,
        created_at: agent.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      }) as AgentRow
      const proposedAgentData = normalizeUploadUrlsForStorageInPayload(agentData)
      
      // Prepared defaults stay unchanged; record/index/catalogue revision move together.
      const { record: storageAgentData } = await createSubjectPopulation(client, { userId: agentData.user_id, subjectId: agentData.id, kind: 'primary',
        mode: 'replace-owned', record: proposedAgentData })
      
      // Map database fields to frontend format
      return {
        ...resolveUploadUrlsForBrowserInPayload(storageAgentData),
        displayName: storageAgentData.displayName || '',
        avatar_url: storageAgentData.avatar || storageAgentData.avatar_url || undefined
      }
    }))
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
  async updateAgent(id: string, updates: Omit<Partial<AgentRow>, 'system_prompt' | 'include_global_prompt'> & { system_prompt?: string | null; include_global_prompt?: boolean | null }, options: AgentUpdateOptions = {}): Promise<void> {
    updates = structuredClone(updates)
    // SA-139 R4/R5 (D14): the routes refuse a retired Primary type first; the lower writer never
    // stores one either, so no caller can turn a record into a leftover.
    if (Object.hasOwn(updates, 'agentType') && isRetiredPrimaryAgentType(normalizePrimaryAgentType(undefined, (updates as Record<string, unknown>).agentType))) {
      throw new AgentUpdateRejectedError('A retired Primary Agent type (Claude Code CLI, Codex CLI or n8n) cannot be saved. Nothing was saved.')
    }
    const namesTypedTools = namesTypedFileToolsWrite(updates as Record<string, unknown>)
    if (namesTypedTools || options.expectedTypedFileTools !== undefined) requireTypedToolsExpected(options.expectedTypedFileTools)
    const humanMcpLeaves = mcpSettingsLeaves(updates)
    if (humanMcpLeaves.length || options.expectedMcpSettings !== undefined) { requireMcpSettingsExpected(options.expectedMcpSettings, humanMcpLeaves); options = { ...options, expectedMcpSettings: { ...options.expectedMcpSettings } } }
    const namesVoice = updates.voice_profile !== undefined || options.configuredTtsMutation !== undefined
    if (namesVoice || options.expectedTtsSelection !== undefined) requireConfiguredTtsExpected(options.expectedTtsSelection)
    if (options.configuredTtsMutation && updates.voice_profile !== undefined) throw new ConfiguredTtsConflictError()
    if (options.voiceEngineClearBasis && (updates.voice_profile === undefined || options.configuredTtsMutation)) throw new ConfiguredTtsConflictError()
    const namesCompact = updates.auto_compact_settings !== undefined || options.autoCompactMutation !== undefined
    if (namesCompact || options.expectedAutoCompact !== undefined) requireAutoCompactExpected(options.expectedAutoCompact)
    if (options.autoCompactMutation) {
      if (updates.auto_compact_settings !== undefined) throw new AutoCompactConflictError()
      validateAutoCompactChanges(options.autoCompactMutation.changes)
    }
    const instructions = instructionLeaves(updates as Record<string, unknown>)
    if (options.expectedInstructions !== undefined) requireInstructionsExpected(options.expectedInstructions)
    if (instructions.length) {
      requireInstructionsExpected(options.expectedInstructions, instructions)
      updates = { ...updates }
      options = { ...options, expectedInstructions: { ...options.expectedInstructions } }
    }
    const namesReferences = ['auto_compact_settings', 'memory_window', 'memoryWindow'].some(field => (updates as Record<string, unknown>)[field] !== undefined)
    // Every sparse save retains its actual target incarnation without profile-folder custody.
    const lifecycle = captureSettingsLifecycle([`agent:${id}`])
    const references = namesReferences ? preparePresetReferences('primary', updates, lifecycle) : undefined
    return this.execute(async (client) => {
      let ordinaryClear: ModelSelectionClear | undefined
      if (!options.modelSelectionMutation && isCompleteEmptyModelSelection(updates as Record<string, unknown>)) {
        requireModelSelectionRevision(options.expectedModelSelection)
        const original = await readModelSelectionSnapshot(client, id, 'agent', lifecycle)
        if (original.revision !== options.expectedModelSelection) throw new ModelSelectionConflictError()
        // A combined type change keeps its ordinary owner. This passage only
        // detaches the held selection while preserving the actual existing transport.
        if (normalizePrimaryAgentType(original.record, updates.agentType) === normalizePrimaryAgentType(original.record)) {
          ordinaryClear = prepareModelSelectionClear(original, 'agent').clear
          const sent = updates.provider_specific_settings
          if (sent && typeof sent === 'object' && !Array.isArray(sent)) {
            const stored = original.record.provider_specific_settings
            const patch = Object.fromEntries(Object.entries(sent).filter(([key, value]) => isAgentRuntimeSettingKey(key) || value != null ||
              !!stored && typeof stored === 'object' && Object.hasOwn(stored, key)))
            updates = { ...updates }
            if (Object.keys(patch).length) updates.provider_specific_settings = patch
            else delete updates.provider_specific_settings
          }
          const type = normalizePrimaryAgentType(original.record)
          if (original.record.agentType !== type) updates = { ...updates, agentType: type }
        }
      }
      return this.writeAgentUpdate(client, id, updates as Record<string, unknown>, options, lifecycle, references, ordinaryClear)
    })
  }

  private async writeAgentUpdate(
    client: RedisClientType,
    id: string,
    updates: Record<string, unknown>,
    options: AgentUpdateOptions,
    pairLifecycle: SettingsLifecycleSnapshot = captureSettingsLifecycle([`agent:${id}`]),
    referencePreparation?: PresetReferencePreparation,
    ordinaryClear?: ModelSelectionClear
  ): Promise<void> {
    const key = `agent:${id}`
    updates = structuredClone(updates)
    const plan = planAgentRecordUpdate({ updates, now: new Date().toISOString() })
    // Server-owned model operations touch only their requested leaves. The ordinary
    // human planner's historical null cleanup must not mutate unrelated Voice/Goon state.
    if (options.modelSelectionMutation || ordinaryClear) plan.ops = plan.ops.filter(op => op.op !== 'deleteIfNull' || Object.hasOwn(updates, op.field))
    const namesVoice = updates.voice_profile !== undefined || options.configuredTtsMutation !== undefined
    if (options.configuredTtsMutation) plan.ops.push(...planConfiguredTtsOps(options.configuredTtsMutation.target, options.configuredTtsMutation.selection))
    const namesCompact = updates.auto_compact_settings !== undefined || options.autoCompactMutation !== undefined
    if (options.autoCompactMutation) {
      const changes = validateAutoCompactChanges(options.autoCompactMutation.changes)
      plan.ops.push({ op: 'ensureObject', field: 'auto_compact_settings' }, ...Object.entries(changes).map(([key, value]) => ({ op: 'set' as const, field: 'auto_compact_settings', key, value })))
    }
    const issuedOps = serializeAgentRecordPlan(plan.ops), voicePostimage = capturedAgentVoicePostimage(issuedOps), modelPostimage = capturedModelSelectionUpdates(issuedOps)
    const guardsMemory = options.expectedMemory !== undefined
    const namesModel = namesModelSelection('agent', modelPostimage)
    const typedSnapshot = namesTypedFileToolsWrite(updates) ? await readTypedToolsSnapshot(client, id, 'agent', pairLifecycle) : undefined
    const typedGuard = typedSnapshot ? typedToolsWriteGuard(typedSnapshot, options.expectedTypedFileTools) : undefined
    const mcpLeaves = mcpSettingsLeaves(updates)
    const instructionFields = instructionLeaves(updates)
    const referenceFields = ['auto_compact_settings', 'memory_window', 'memoryWindow'].filter(field => updates[field] !== undefined)
    if (referenceFields.includes('memory_window') && !referenceFields.includes('memoryWindow')) referenceFields.push('memoryWindow')
    if (referenceFields.includes('memoryWindow') && !referenceFields.includes('memory_window')) referenceFields.push('memory_window')
    if (options.expectedModelSelection !== undefined) requireModelSelectionRevision(options.expectedModelSelection)
    const readPaths = (paths: readonly string[]) =>
      Promise.all(paths.map((path) => client.sendCommand<string | null>(['JSON.GET', key, path])))
    let lastAnswer: unknown = null
    for (let attempt = 0; attempt < AGENT_UPDATE_TYPE_TRIES; attempt += 1) {
      const referenceSnapshot = referenceFields.length ? await readPresetReferenceSnapshot(client, key, 'primary', referenceFields) : undefined
      // Each path's raw answer, so the script can compare the very text it reads again. Separate
      // commands in one round trip; a mix of old and new answers cannot match the record as it is.
      const [fields, memory, model, instructions, compact, tts] = await Promise.all([
        readPaths(AGENT_TYPE_SOURCE_PATHS),
        guardsMemory ? readPaths(AGENT_MEMORY_SOURCE_PATHS) : Promise.resolve(null),
        namesModel ? readModelSelectionSnapshot(client, id, 'agent', pairLifecycle) : Promise.resolve(undefined),
        instructionFields.length ? readInstructionsSnapshot(client, id, 'agent', pairLifecycle, instructionFields) : Promise.resolve(undefined),
        namesCompact ? readAutoCompactSnapshot(client, id, String(options.autoCompactMutation?.target.record.user_id ?? ''), pairLifecycle, !!options.autoCompactMutation) : Promise.resolve(undefined),
        namesVoice ? readConfiguredTtsSnapshot(client, id, pairLifecycle) : Promise.resolve(undefined)
      ])
      if (fields.some((field) => field === null) || memory?.some((answer) => answer === null)) {
        throw new Error('Agent not found')
      }
      if (memory && !agentMemoryBaseMatches(agentMemoryFieldsFromAnswers(memory as string[]), options.expectedMemory)) {
        throw new AgentMemorySettingsConflictError()
      }
      const initialArguments = agentUpdateScriptArguments(plan, fields.join('\n'), memory ? memory.join('\n') : null)
      initialArguments[0] = issuedOps
      const resultingType = JSON.parse(initialArguments[2])
      if (model && (normalizePrimaryAgentType(model.record) === 'api' || resultingType === 'api')) requireModelSelectionRevision(options.expectedModelSelection)
      const modelBasis = model ? await modelSelectionWriteBasis(client, model, Object.freeze({ ...modelPostimage, agentType: resultingType }), 'agent', options.modelSelectionMutation, ordinaryClear) : undefined
      if (modelBasis?.expectedRevision !== undefined && options.expectedModelSelection !== undefined && modelBasis.expectedRevision !== options.expectedModelSelection) throw new ModelSelectionConflictError()
      const mcpRead = mcpLeaves.length ? await readModelSelectionSnapshot(client, id, 'agent', pairLifecycle, mcpSettingsReadPaths(mcpLeaves), { typeFenceOnly: true, reportProjection: true }) : undefined
      const mcpSnapshot = mcpRead ? makeMcpSettingsSnapshot(id, mcpSettingsReadPaths(mcpLeaves), mcpRead.extraRaw, pairLifecycle!, mcpLeaves) : undefined
      const mcpGuard = mcpSnapshot ? mcpSettingsWriteGuard(mcpSnapshot, options.expectedMcpSettings, mcpLeaves) : undefined
      const instructionBasis = instructions ? instructionsWriteBasis(instructions, options.expectedInstructions, instructionFields, options.instructionsMutation) : undefined
      const issueKeys = [key]
      const modelGuard = modelBasis ? modelSelectionIssueGuard(modelBasis.issueTarget, modelBasis.source, issueKeys, options.modelSelectionMutation, modelBasis.extraChecks) : undefined
      const instructionGuard = instructions ? instructionsIssueGuard(instructions, issueKeys, options.instructionsMutation) : undefined
      const compactGuard = compact ? autoCompactIssueGuard(compact, options.expectedAutoCompact, issueKeys, options.autoCompactMutation) : undefined
      if (tts && tts.revision !== options.expectedTtsSelection) throw new ConfiguredTtsConflictError()
      const voiceModelSource = tts && !options.configuredTtsMutation && !options.voiceEngineClearBasis && configuredTtsTupleChanges(tts, voicePostimage.voice_profile)
        ? await readAgentVoiceModelLockSource(client, String(tts.record.user_id), id, voicePostimage) : undefined
      if (voiceModelSource?.locked) throw new ConfiguredTtsModelLockedError()
      const voiceSources = [...(voiceModelSource?.guards ?? []), ...(tts && options.voiceEngineClearBasis ? [voiceEngineClearSource(tts, options.voiceEngineClearBasis)] : [])]
      const ttsGuard = tts ? configuredTtsIssueGuard(tts, options.expectedTtsSelection, issueKeys, options.configuredTtsMutation, voiceSources) : undefined
      if (modelGuard && model) { modelGuard.clientBase = modelBasis?.expectedRevision !== undefined && options.expectedModelSelection !== undefined; modelGuard.currentType = normalizePrimaryAgentType(model.record) }
      let lease: ReturnType<typeof acquireSettingsMutation> | undefined
      let referenceLease: Awaited<ReturnType<typeof admitPresetReferences>> | undefined
      let instructionLease: ReturnType<typeof acquireSettingsMutation> | undefined
      let compactLease: ReturnType<typeof acquireSettingsMutation> | undefined
      let ttsLease: ReturnType<typeof acquireSettingsMutation> | undefined
      let typedLease: ReturnType<typeof acquireSettingsMutation> | undefined
      let typedAck: ReturnType<typeof makeTypedToolsSnapshot> | undefined
      let mcpLease: ReturnType<typeof acquireSettingsMutation> | undefined
      let mcpAck: ReturnType<typeof makeMcpSettingsSnapshot> | undefined
      let targetLease: ReturnType<typeof acquireSettingsMutation> | undefined
      let issued = false
      try {
        targetLease = acquireSettingsMutation(pairLifecycle)
        if (typedSnapshot) typedLease = acquireSettingsMutation(typedSnapshot.lifecycle)
        if (mcpSnapshot) mcpLease = acquireSettingsMutation(mcpSnapshot.lifecycle)
        if (referenceSnapshot) {
          const persistedReferences = { ...referenceSnapshot.record }
          for (const op of plan.ops) {
            if (!referenceFields.includes(op.field) || 'key' in op && op.key !== undefined) continue
            if (op.op === 'set') persistedReferences[op.field] = JSON.parse(JSON.stringify(op.value))
            else if (op.op === 'delete' || op.op === 'deleteIfNull' && persistedReferences[op.field] === null) delete persistedReferences[op.field]
          }
          referenceLease = await admitPresetReferences(String(referenceSnapshot.record.user_id), 'primary', referenceSnapshot,
            persistedReferences, referencePreparation!)
        }
        if (modelBasis) lease = acquireSettingsMutation(modelBasis.lifecycle)
        if (instructionBasis) instructionLease = acquireSettingsMutation(instructionBasis)
        if (compact) compactLease = acquireSettingsMutation({ epoch: compact.lifecycle.epoch, records: [...compact.lifecycle.records, ...(options.autoCompactMutation?.authority.lifecycle?.records ?? [])] })
        if (tts) ttsLease = acquireSettingsMutation({ epoch: tts.lifecycle.epoch, records: [...tts.lifecycle.records, ...(options.configuredTtsMutation?.sourceLifecycle.records ?? []), ...(options.configuredTtsMutation?.authority.lifecycle?.records ?? []), ...(voiceModelSource?.lifecycle.records ?? []), ...(options.voiceEngineClearBasis?.target.lifecycle.records ?? [])] })
        if (model) checkModelSelectionIssue(options.modelSelectionMutation)
        if (instructions) checkInstructionsIssue(options.instructionsMutation)
        if (compact) checkAutoCompactIssue(options.autoCompactMutation)
        if (tts) checkConfiguredTtsIssue(options.configuredTtsMutation)
        lease?.check()
        referenceLease?.check()
        instructionLease?.check()
        compactLease?.check()
        ttsLease?.check()
        mcpLease?.check()
        targetLease.check()
        const signal = options.modelSelectionMutation?.signal ?? options.instructionsMutation?.signal ?? options.autoCompactMutation?.signal ?? options.configuredTtsMutation?.signal
        const command = signal ? client.withAbortSignal(signal) : client
        const issuedArguments = agentUpdateScriptArguments(plan, fields.join('\n'), memory ? memory.join('\n') : null, modelGuard, referenceLease?.guard, instructionGuard, compactGuard, ttsGuard, mcpGuard, typedGuard)
        issuedArguments[0] = issuedOps
        typedLease?.check()
        issued = true
        lastAnswer = await command.eval(UPDATE_AGENT_FIELDS_SCRIPT, {
          keys: issueKeys,
          arguments: issuedArguments
        })
        if (Array.isArray(lastAnswer) && lastAnswer.length === 3 && lastAnswer[0] === 'TYPED_TOOLS_SAVED' && typedSnapshot) {
          if (!Array.isArray(lastAnswer[1]) || !Array.isArray(lastAnswer[2])) throw new Error('The saved Typed File Tools receipt is unavailable.')
          typedAck = makeTypedToolsSnapshot(id, 'agent', lastAnswer[1] as string[], typedSnapshot.lifecycle, true)
          if (mcpSnapshot) mcpAck = makeMcpSettingsSnapshot(id, mcpSnapshot.paths, lastAnswer[2] as string[], mcpSnapshot.lifecycle, mcpLeaves, true)
          lastAnswer = 'OK'
        }
        if (Array.isArray(lastAnswer) && lastAnswer[0] === 'MCP_SETTINGS_SAVED' && mcpSnapshot) {
          mcpAck = makeMcpSettingsSnapshot(id, mcpSnapshot.paths, lastAnswer.slice(1) as string[], mcpSnapshot.lifecycle, mcpLeaves, true)
          lastAnswer = 'OK'
        }
        if (typedSnapshot && lastAnswer === 'OK' && !typedAck) throw new Error('The promised Typed File Tools save receipt is missing.')
      } catch (error) {
        if ((options.modelSelectionMutation?.signal?.aborted || options.instructionsMutation?.signal?.aborted || options.autoCompactMutation?.signal?.aborted || options.configuredTtsMutation?.signal?.aborted) && error instanceof AbortError) {
          targetLease?.settle(); typedLease?.settle(); mcpLease?.settle(); lease?.settle(); referenceLease?.settle(); instructionLease?.settle(); compactLease?.settle(); ttsLease?.settle(); if (tts) throw new ConfiguredTtsConflictError(); if (compact) throw new AutoCompactConflictError(); throw instructions ? new InstructionsConflictError() : new ModelSelectionConflictError()
        }
        if (issued) {
          targetLease?.unknown()
          if (typedLease) { typedLease.unknown(); mcpLease?.unknown(); lease?.unknown(); referenceLease?.unknown(); instructionLease?.unknown(); compactLease?.unknown(); ttsLease?.unknown(); throw new TypedToolsSaveUnconfirmedError() }
          if (mcpLease) { mcpLease.unknown(); lease?.unknown(); referenceLease?.unknown(); instructionLease?.unknown(); compactLease?.unknown(); ttsLease?.unknown(); throw new McpSettingsSaveUnconfirmedError() }
          ttsLease?.unknown()
          if (tts) { lease?.unknown(); referenceLease?.unknown(); instructionLease?.unknown(); compactLease?.unknown(); throw new ConfiguredTtsSaveUnconfirmedError() }
          compactLease?.unknown()
          if (compact) { lease?.unknown(); referenceLease?.unknown(); instructionLease?.unknown(); throw new AutoCompactSaveUnconfirmedError() }
          referenceLease?.unknown()
          instructionLease?.unknown()
          if (instructions) { lease?.unknown(); throw new InstructionsSaveUnconfirmedError() }
          if (lease) { lease.unknown(); throw new ModelSelectionSaveUnconfirmedError() }
          if (referenceLease) throw new PresetReferenceWriteError('unknown')
          throw new SubjectSaveUnconfirmedError()
        }
        targetLease?.settle(); typedLease?.settle(); mcpLease?.settle()
        lease?.settle()
        referenceLease?.settle()
        instructionLease?.settle()
        compactLease?.settle()
        ttsLease?.settle()
        throw error
      }
      const known = typeof lastAnswer === 'string' && ['TYPED_TOOLS_BASE_REQUIRED', 'TYPED_TOOLS_CHANGED', 'MCP_SETTINGS_BASE_REQUIRED', 'MCP_SETTINGS_CHANGED', 'OK', 'MISSING', 'TYPE_CHANGED', 'MEMORY_CHANGED', 'MODEL_SELECTION_CHANGED', 'MODEL_SELECTION_EXPIRED', 'MODEL_SELECTION_BASE_REQUIRED', 'PRESET_REFERENCE_CHANGED', 'INSTRUCTIONS_BASE_REQUIRED', 'INSTRUCTIONS_CHANGED', 'INSTRUCTIONS_EXPIRED', 'AUTO_COMPACT_BASE_REQUIRED', 'AUTO_COMPACT_CHANGED', 'AUTO_COMPACT_EXPIRED', 'TTS_SELECTION_BASE_REQUIRED', 'TTS_SELECTION_CHANGED'].includes(lastAnswer)
      if (known) targetLease?.settle(); else targetLease?.unknown()
      if (known) { typedLease?.settle(); mcpLease?.settle() } else { typedLease?.unknown(); mcpLease?.unknown() }
      if (known) lease?.settle(); else lease?.unknown()
      if (known) referenceLease?.settle(); else referenceLease?.unknown()
      if (known) instructionLease?.settle(); else instructionLease?.unknown()
      if (known) compactLease?.settle(); else compactLease?.unknown()
      if (known) ttsLease?.settle(); else ttsLease?.unknown()
      if (lastAnswer === 'TYPED_TOOLS_BASE_REQUIRED') throw new TypedToolsBaseRequiredError()
      if (lastAnswer === 'TYPED_TOOLS_CHANGED') throw new TypedToolsConflictError()
      if (lastAnswer === 'MCP_SETTINGS_BASE_REQUIRED') throw new McpSettingsBaseRequiredError()
      if (lastAnswer === 'MCP_SETTINGS_CHANGED') throw new McpSettingsConflictError()
      if (!known && typedLease) throw new TypedToolsSaveUnconfirmedError()
      if (!known && mcpLease) throw new McpSettingsSaveUnconfirmedError()
      if (lastAnswer === 'TTS_SELECTION_BASE_REQUIRED') throw new ConfiguredTtsBaseRequiredError()
      if (lastAnswer === 'TTS_SELECTION_CHANGED') throw new ConfiguredTtsConflictError()
      if (!known && ttsLease) throw new ConfiguredTtsSaveUnconfirmedError()
      if (lastAnswer === 'AUTO_COMPACT_BASE_REQUIRED') throw new AutoCompactBaseRequiredError()
      if (lastAnswer === 'AUTO_COMPACT_CHANGED' || lastAnswer === 'AUTO_COMPACT_EXPIRED') throw new AutoCompactConflictError()
      if (!known && compactLease) throw new AutoCompactSaveUnconfirmedError()
      if (lastAnswer === 'INSTRUCTIONS_BASE_REQUIRED') throw new InstructionsBaseRequiredError()
      if (lastAnswer === 'INSTRUCTIONS_CHANGED' || lastAnswer === 'INSTRUCTIONS_EXPIRED') throw new InstructionsConflictError()
      if (!known && instructionLease) throw new InstructionsSaveUnconfirmedError()
      if (lastAnswer === 'PRESET_REFERENCE_CHANGED') throw new PresetReferenceWriteError('changed')
      if (lastAnswer === 'MODEL_SELECTION_CHANGED' || lastAnswer === 'MODEL_SELECTION_EXPIRED') throw new ModelSelectionConflictError()
      if (lastAnswer === 'MODEL_SELECTION_BASE_REQUIRED') throw new ModelSelectionBaseRequiredError()
      if (!known && lease) throw new ModelSelectionSaveUnconfirmedError()
      if (!known && referenceLease) throw new PresetReferenceWriteError('unknown')
      if (!known) throw new SubjectSaveUnconfirmedError()
      if (lastAnswer === 'OK') { if (typedAck) options.onTypedFileToolsSaved?.({ revision: typedAck.revision, value: typedAck.value }); if (mcpAck) options.onMcpSettingsSaved?.({ revisions: mcpAck.revisions, values: mcpAck.values }); options.configuredTtsMutation?.onSaved?.(); options.autoCompactMutation?.onSaved?.(); options.instructionsMutation?.onSaved?.(); options.modelSelectionMutation?.onSaved?.(); return }
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
  async updateSubagent(id: string, writes: Record<string, unknown>, options: Pick<AgentUpdateOptions, 'expectedModelSelection' | 'modelSelectionMutation' | 'expectedInstructions' | 'instructionsMutation' | 'expectedTypedFileTools' | 'onTypedFileToolsSaved'> = {}): Promise<boolean> {
    writes = structuredClone(writes)
    // SA-139 R2/R5 (D14): the routes refuse a retired Subagent type first; the lower writer never
    // stores one either.
    if (Object.hasOwn(writes, 'subagentType') && isRetiredSubagentType(normalizeSubagentType(undefined, writes.subagentType))) {
      throw new AgentUpdateRejectedError('A retired Subagent type (Claude Code CLI, Codex CLI or n8n) cannot be saved. Nothing was saved.')
    }
    const namesTypedTools = namesTypedFileToolsWrite(writes)
    if (namesTypedTools || options.expectedTypedFileTools !== undefined) requireTypedToolsExpected(options.expectedTypedFileTools)
    const instructionFields = instructionLeaves(writes)
    if (options.expectedInstructions !== undefined) requireInstructionsExpected(options.expectedInstructions)
    if (instructionFields.length) {
      requireInstructionsExpected(options.expectedInstructions, instructionFields)
      writes = { ...writes }
      options = { ...options, expectedInstructions: { ...options.expectedInstructions } }
    }
    const plan = planSubagentRecordUpdate({ writes, now: new Date().toISOString() })
    const issuedOps = serializeAgentRecordPlan(plan.ops)
    const modelPostimage = capturedModelSelectionUpdates(issuedOps)
    const namesModel = namesModelSelection('subagent', modelPostimage)
    const lifecycle = captureSettingsLifecycle([`subagent:${id}`])
    return this.execute(async (client) => {
      const key = `subagent:${id}`
      const model = namesModel ? await readModelSelectionSnapshot(client, id, 'subagent', lifecycle) : undefined
      const typedSnapshot = namesTypedTools ? await readTypedToolsSnapshot(client, id, 'subagent', lifecycle) : undefined
      const typedGuard = typedSnapshot ? typedToolsWriteGuard(typedSnapshot, options.expectedTypedFileTools) : undefined
      const instructions = instructionFields.length ? await readInstructionsSnapshot(client, id, 'subagent', lifecycle, instructionFields) : undefined
      if (model && (normalizeSubagentType(model.record) === 'api' || normalizeSubagentType(model.record, writes.subagentType) === 'api')) requireModelSelectionRevision(options.expectedModelSelection)
      if (options.expectedModelSelection !== undefined) {
        requireModelSelectionRevision(options.expectedModelSelection)
        if (!model) throw new ModelSelectionConflictError()
      }
      let typedLease: ReturnType<typeof acquireSettingsMutation> | undefined
      let typedAck: ReturnType<typeof makeTypedToolsSnapshot> | undefined
      let lease: ReturnType<typeof acquireSettingsMutation> | undefined
      let instructionLease: ReturnType<typeof acquireSettingsMutation> | undefined
      let targetLease: ReturnType<typeof acquireSettingsMutation> | undefined
      let answer: unknown
      let issued = false
      const modelBasis = model ? await modelSelectionWriteBasis(client, model, modelPostimage, 'subagent', options.modelSelectionMutation) : undefined
      if (modelBasis?.expectedRevision !== undefined && options.expectedModelSelection !== undefined && modelBasis.expectedRevision !== options.expectedModelSelection) throw new ModelSelectionConflictError()
      const instructionBasis = instructions ? instructionsWriteBasis(instructions, options.expectedInstructions, instructionFields, options.instructionsMutation) : undefined
      const issueKeys = [key]
      const modelGuard = modelBasis ? modelSelectionIssueGuard(modelBasis.issueTarget, modelBasis.source, issueKeys, options.modelSelectionMutation) : undefined
      const instructionGuard = instructions ? instructionsIssueGuard(instructions, issueKeys, options.instructionsMutation) : undefined
      if (modelGuard && model) { modelGuard.clientBase = modelBasis?.expectedRevision !== undefined && options.expectedModelSelection !== undefined; modelGuard.currentType = normalizeSubagentType(model.record) }
      try {
      targetLease = acquireSettingsMutation(lifecycle)
      if (typedSnapshot) typedLease = acquireSettingsMutation(typedSnapshot.lifecycle)
      if (modelBasis) lease = acquireSettingsMutation(modelBasis.lifecycle)
      if (instructionBasis) instructionLease = acquireSettingsMutation(instructionBasis)
      if (model) checkModelSelectionIssue(options.modelSelectionMutation)
      if (instructions) checkInstructionsIssue(options.instructionsMutation)
      lease?.check()
      instructionLease?.check()
      targetLease.check()
      const signal = options.modelSelectionMutation?.signal ?? options.instructionsMutation?.signal
      const command = signal ? client.withAbortSignal(signal) : client
      // Positional, as `UPDATE_SUBAGENT_FIELDS_SCRIPT` reads them: ops, model, instructions, Typed File Tools.
      const issuedArguments = [issuedOps, modelGuard ? JSON.stringify(modelGuard) : '', instructionGuard ? JSON.stringify(instructionGuard) : '', typedGuard ? JSON.stringify(typedGuard) : '']
      typedLease?.check()
      issued = true
      answer = await command.eval(UPDATE_SUBAGENT_FIELDS_SCRIPT, { keys: issueKeys, arguments: issuedArguments })
      if (Array.isArray(answer) && answer.length === 2 && answer[0] === 'TYPED_TOOLS_SAVED' && typedSnapshot) {
        if (!Array.isArray(answer[1])) throw new Error('The saved Typed File Tools receipt is unavailable.')
        typedAck = makeTypedToolsSnapshot(id, 'subagent', answer[1] as string[], typedSnapshot.lifecycle, true)
        answer = 'OK'
      }
      if (typedSnapshot && answer === 'OK' && !typedAck) throw new Error('The promised Typed File Tools save receipt is missing.')
      } catch (error) {
        if (!issued || (options.modelSelectionMutation?.signal?.aborted || options.instructionsMutation?.signal?.aborted) && error instanceof AbortError) { targetLease?.settle(); typedLease?.settle(); lease?.settle(); instructionLease?.settle(); throw error }
        targetLease?.unknown()
        if (typedLease) { typedLease.unknown(); instructionLease?.unknown(); lease?.unknown(); throw new TypedToolsSaveUnconfirmedError() }
        if (instructionLease) { instructionLease.unknown(); lease?.unknown(); throw new InstructionsSaveUnconfirmedError() }
        if (lease) { lease.unknown(); throw new ModelSelectionSaveUnconfirmedError() } throw new SubjectSaveUnconfirmedError()
      }
      if (typeof answer === 'string' && ['TYPED_TOOLS_BASE_REQUIRED', 'TYPED_TOOLS_CHANGED', 'OK', 'MISSING', 'INVALID_RECORD', 'MODEL_SELECTION_CHANGED', 'MODEL_SELECTION_EXPIRED', 'MODEL_SELECTION_BASE_REQUIRED', 'INSTRUCTIONS_BASE_REQUIRED', 'INSTRUCTIONS_CHANGED', 'INSTRUCTIONS_EXPIRED'].includes(answer)) { targetLease?.settle(); typedLease?.settle(); lease?.settle(); instructionLease?.settle() }
      else { targetLease?.unknown(); typedLease?.unknown(); lease?.unknown(); instructionLease?.unknown(); if (typedLease) throw new TypedToolsSaveUnconfirmedError(); if (instructionLease) throw new InstructionsSaveUnconfirmedError(); if (lease) throw new ModelSelectionSaveUnconfirmedError(); throw new SubjectSaveUnconfirmedError() }
      if (answer === 'TYPED_TOOLS_BASE_REQUIRED') throw new TypedToolsBaseRequiredError()
      if (answer === 'TYPED_TOOLS_CHANGED') throw new TypedToolsConflictError()
      if (answer === 'INSTRUCTIONS_BASE_REQUIRED') throw new InstructionsBaseRequiredError()
      if (answer === 'INSTRUCTIONS_CHANGED' || answer === 'INSTRUCTIONS_EXPIRED') throw new InstructionsConflictError()
      if (answer === 'MODEL_SELECTION_CHANGED' || answer === 'MODEL_SELECTION_EXPIRED') throw new ModelSelectionConflictError()
      if (answer === 'MODEL_SELECTION_BASE_REQUIRED') throw new ModelSelectionBaseRequiredError()
      if (answer === 'OK') { if (typedAck) options.onTypedFileToolsSaved?.({ revision: typedAck.revision, value: typedAck.value }); options.instructionsMutation?.onSaved?.(); options.modelSelectionMutation?.onSaved?.(); return true }
      if (answer === 'MISSING') return false
      if (answer === 'INVALID_RECORD') throw new Error('Existing key has wrong Redis type or is not an object.')
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
    const originalCatalogueEpoch = captureSettingsLifecycle([])
    return withSettingsRecordReplacement(`agent:${id}`, async () => {
    agentSetupCache.clearAgentRecord(id)
    // BL-608: three sweeps below (wake hooks, schedules, zip holds) find the agent's records
    // through `agent.user_id`, and each reads the record strictly, so a failed read stops the
    // delete there. Read it once here too, before anything is deleted, so a read that fails
    // from the start costs nothing: before, `redis.get` answered a failed read with null, those
    // sweeps found nothing, and the agent was deleted anyway with its hooks, schedules, and
    // holds left behind.
    const settingsOwner = await this.json.get(`agent:${id}`) as AgentRow | null
    assertSettingsLifecycle(originalCatalogueEpoch)
    const commandPreparation = settingsOwner?.user_id ? beginSlashCommandWrite(settingsOwner.user_id) : undefined
    if (settingsOwner?.user_id) {
      const { sweepAppActionsSubjectReferences } = await import('$lib/server/services/appActions/settings/authority')
      await sweepAppActionsSubjectReferences(settingsOwner.user_id, { kind: 'primary', id })
    }
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
      const { deleteAgentSkillSessions } = await import('$lib/server/services/skillSessions')
      releasedHolds = await deleteAgentSkillSessions(id, settingsOwner!.user_id)
      releasedHolds.push(...await releaseDeletedAgentHolds(id))
      await this.execute(async (client) => {
        // Get agent to find user_id
        const agent = await client.json.get(`agent:${id}`)

        // Preserve the existing full Whiteboard preflight, with atomic population removal.
        if (agent !== null) {
          if (!agent || Array.isArray(agent) || typeof agent !== 'object' || typeof (agent as any).user_id !== 'string') {
            throw new Error('The agent deletion owner is unreadable.')
          }
          const userId = (agent as any).user_id as string
          if (!commandPreparation || userId !== settingsOwner?.user_id || (agent as any).id !== id) {
            throw new Error('The agent owner changed before final deletion. The record was retained; earlier cleanup may already have completed.')
          }
          // BL-1621/BL-392: required skill references go before final identity removal.
          // A known refusal leaves a recoverable owner. Only an actual unknown issued
          // command holds its exact replacement lease after this request ends.
          const skillLease = acquireSettingsReplacementMutation(`agent:${id}`)
          try {
            const { captureSlashCommandWriteBasis, captureSkillSourceWriteBasis, removeExplicitSkillSourceAgentAccess } = await import('$lib/server/services/slashCommandRevision')
            const { removeExplicitSlashCommandAgentAccess } = await import('$lib/server/services/agentAccessLists')
            assertSettingsLifecycle(originalCatalogueEpoch)
            // Capture BEFORE the cross-kind read. A concurrent deletion cannot
            // make this request adopt its new catalogue nonce and lose access.
            await captureSlashCommandWriteBasis(commandPreparation, [])
            const sharedWithSubagent = await client.exists(`subagent:${id}`)
            if (!sharedWithSubagent) {
              const { removeAgentPluginAgentReferences } = await import('$lib/server/services/agentPlugins')
              await removeAgentPluginAgentReferences(userId, id, 'primary')
              for (const key of await client.keys(`slash_command:${userId}:*`)) {
                const commandId = key.slice(`slash_command:${userId}:`.length)
                const basis = await captureSlashCommandWriteBasis(commandPreparation, [commandId])
                await removeExplicitSlashCommandAgentAccess(userId, commandId, id, basis)
              }
              for (const key of await client.keys(`skill_source:${userId}:*`)) {
                const sourceId = key.slice(`skill_source:${userId}:`.length)
                const basis = await captureSkillSourceWriteBasis(commandPreparation, sourceId)
                await removeExplicitSkillSourceAgentAccess(userId, sourceId, id, basis)
              }
              const { removeRequiredArtifactAgentReferences } = await import('$lib/server/services/artifactAgentDeletionCleanup')
              await removeRequiredArtifactAgentReferences({ userId, id, kind: 'primary' }, () => {
                skillLease.check()
                assertSettingsLifecycle(originalCatalogueEpoch)
                currentSlashCommandWriteRevision(commandPreparation)
              })
            }
          } catch (error) {
            if (isSlashCommandMutationError(error) && error.outcome === 'unknown') skillLease.unknown()
            else skillLease.settle()
            throw error
          }
          skillLease.settle()
          await deletePrimaryPopulation(client, { subjectId: id, userId, expectedCatalogueRevision: currentSlashCommandWriteRevision(commandPreparation) })
        } else if (await client.exists(`agent:${id}`)) {
          throw new Error('The agent deletion owner is unreadable.')
        }


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
        // SA-137 P4 (D10): this agent's live file read receipts, in every chat (chats can outlive it).
        try {
          const { deleteLiveFileReadOutcomesOfAgent } = await import('$lib/server/services/liveFileReadOutcome.server')
          await deleteLiveFileReadOutcomesOfAgent(client, id)
        } catch (liveReadError) {
          console.error(`[deleteAgent] Error deleting live file read receipts:`, liveReadError)
        }

        // Remove from user's agent list
        const agentObj = agent as any
        if (agentObj?.user_id) {
          const userId = agentObj.user_id as string

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
    })
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
    const payload = JSON.stringify(profile), saved = JSON.parse(payload) as VoiceProfileRecord
    const id = saved.id, userId = saved.user_id, key = `voice_profile:${id}`
    return withSettingsRecordReplacement(key, () => this.execute(async (client) => {
      const lease = acquireSettingsReplacementMutation(key)
      try {
        lease.check()
        const answer = await client.eval(`redis.call('JSON.SET', KEYS[1], '$', ARGV[1]); redis.call('SADD', KEYS[2], ARGV[2]); return 'OK'`,
          { keys: [key, `user:${userId}:voice_profiles`], arguments: [payload, id] })
        if (answer !== 'OK') { lease.unknown(); throw new Error('Voice profile save outcome is unconfirmed.') }
        lease.settle(); return saved
      } catch (error) { lease.unknown(); throw error }
    }))
  }

  async deleteVoiceProfile(id: string, userId: string, beforeDelete?: () => Promise<void>): Promise<void> {
    const key = `voice_profile:${id}`
    return withSettingsRecordReplacement(key, async () => {
      await beforeDelete?.()
      await this.execute(async client => {
        const lease = acquireSettingsReplacementMutation(key)
        try {
          lease.check()
          const answer = await client.eval(`redis.call('DEL', KEYS[1]); redis.call('SREM', KEYS[2], ARGV[1]); return 'OK'`,
            { keys: [key, `user:${userId}:voice_profiles`], arguments: [id] })
          if (answer !== 'OK') { lease.unknown(); throw new Error('Voice profile deletion outcome is unconfirmed.') }
          lease.settle()
        } catch (error) { lease.unknown(); throw error }
      })
    })
  }

  // ===== USER SETTINGS =====

  async getUserSettings(userId: string): Promise<UserSettingsRow | null> {
    try {
      const settings = await this.json.get(`user:${userId}:settings`, '$')
      if (settings == null) return null
      if (typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error('Invalid saved user settings: expected an object.')
      }
      // One public projection serves layout, API reads and whole-settings senders.
      // Retired global values remain inert in Redis; never echo them into a new save.
      const { global_api_reasoning_retention: _retired, ...current } = settings as UserSettingsRow & { global_api_reasoning_retention?: unknown }
      const grid = current.global_tool_grid_settings
      if (grid && typeof grid === 'object' && !Array.isArray(grid)) {
        const { typed_file_tools: _retiredTypedGrant, ...kept } = grid
        return resolveUploadUrlsForBrowserInPayload({ ...current, global_tool_grid_settings: kept })
      }
      return resolveUploadUrlsForBrowserInPayload(current)
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
    appearance_settings?: any,
    ui_settings?: any,
    admin_settings?: any,
    global_custom_system_prompt?: string,
    upload_settings?: any,
    upload_provider?: string,
    voice_settings?: VoiceSettings,
    voice_settings_patch?: unknown,
    goons_settings_patch?: unknown,
    goons_settings?: GoonsSettings,
    onboarding_settings?: UserSettingsRow['onboarding_settings']
  }): Promise<UserSettingsRow> {
    refuseWholeToolOperationsWrite(updates)
    const adminExplicit = updates.admin_settings !== undefined
    const toolLifecycle = captureSettingsLifecycle([`user:${userId}:settings`])
    const referencePreparation = preparePresetReferences('settings', updates, toolLifecycle)
    return this.execute(async (client) => {
      // Get existing or create new with defaults
      const referenceSnapshot = await readPresetReferenceSnapshot(client, `user:${userId}:settings`, 'settings', undefined, undefined, PUBLIC_SETTINGS_PRESERVATION_PATHS)
      const existing = resolveUploadUrlsForBrowserInPayload(referenceSnapshot.record) as UserSettingsRow
      
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
        // The app's look (2026-10-29); the route stores only {look} with a named look.
        appearance_settings:
          updates.appearance_settings !== undefined
            ? updates.appearance_settings
            : (existing as any)?.appearance_settings,
        ui_settings: updates.ui_settings !== undefined ? updates.ui_settings : existing?.ui_settings,
        admin_settings: updates.admin_settings !== undefined ? updates.admin_settings : (existing as any)?.admin_settings,
        global_custom_system_prompt: updates.global_custom_system_prompt !== undefined ? updates.global_custom_system_prompt : existing?.global_custom_system_prompt,
        upload_settings: updates.upload_settings !== undefined ? updates.upload_settings : existing?.upload_settings,
        upload_provider: updates.upload_provider !== undefined ? updates.upload_provider : existing?.upload_provider,
        voice_settings: updates.voice_settings !== undefined || updates.voice_settings_patch !== undefined
          ? mergeVoiceSettingsSave(existing?.voice_settings, updates.voice_settings, updates.voice_settings_patch) : existing?.voice_settings,
        goons_settings: updates.goons_settings_patch !== undefined ? mergeGoonsSettingsPatch((existing as any)?.goons_settings, updates.goons_settings_patch)
          : updates.goons_settings !== undefined ? updates.goons_settings : (existing as any)?.goons_settings,
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
      await storeUserSettingsForClient(client, userId, storageSettingsData, { snapshot: referenceSnapshot, preparation: referencePreparation, toolLifecycle, adminExplicit,
        closetExplicit: !!updates.goons_settings_patch && typeof updates.goons_settings_patch === 'object' && !Array.isArray(updates.goons_settings_patch) && Object.hasOwn(updates.goons_settings_patch, 'globalCloset') })
      
      return resolveUploadUrlsForBrowserInPayload(storageSettingsData)
    })
  }

  async saveUserSettings(userId: string, completeSettings: any): Promise<UserSettingsRow> {
    const toolLifecycle = captureSettingsLifecycle([`user:${userId}:settings`])
    const referencePreparation = preparePresetReferences('settings', {}, toolLifecycle)
    return this.execute(async (client) => {
      const referenceSnapshot = await readPresetReferenceSnapshot(client, `user:${userId}:settings`, 'settings', undefined, undefined, PUBLIC_SETTINGS_PRESERVATION_PATHS)
      const user = resolveUploadUrlsForBrowserInPayload(referenceSnapshot.record) as UserSettingsRow
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
      await storeUserSettingsForClient(client, userId, storageUpdated, { snapshot: referenceSnapshot, preparation: referencePreparation, toolLifecycle, adminExplicit: false, closetExplicit: false })
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
      if (!existing) throw Object.assign(new Error('Project not found'), { status: 404 })
      
      // Merge updates
      const updated = {
        ...(existing as any),
        ...updates,
        updated_at: new Date().toISOString()
      }
      
      // Save back, only while the record still exists (`JSON.SET … XX`, BL-2387): a delete that
      // lands between the read and this write must not be undone by the update making the
      // project again.
      const written = await client.json.set(key, '$', updated as any, { condition: 'XX' })
      if (written !== 'OK') throw Object.assign(new Error('Project not found'), { status: 404 })
      
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
  // Owner admission must distinguish a failed read from absence while retaining
  // the mixed RedisJSON/legacy-string decoding used by existing callers.
  async get(key: string, options: { throwOnError?: boolean } = {}): Promise<any> {
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
        if (options.throwOnError) throw error
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
    setIfUnchanged: async (key: string, path: string, expectedRaw: string, value: any, issue?: { beforeIssue(): void }): Promise<boolean> => {
      return this.execute(async (client) => {
        const serialized = jsonTextOf(value)
        // Fixed server owner check, after actual client acquisition/serialization.
        // No await separates refusal/issue marking from the SAME existing EVAL.
        issue?.beforeIssue()
        const answer = await client.eval(JSON_COMPARE_AND_WRITE_SCRIPT, {
          keys: [key],
          arguments: ['SET', path, expectedRaw, serialized]
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
