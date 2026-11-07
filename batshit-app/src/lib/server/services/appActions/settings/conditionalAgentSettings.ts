import { MEMORY_WINDOW_MODE_PATHS, memoryWindowModes, type MemoryWindowParents } from '$lib/appActions/settings/memoryPreferences'
import { readMemoryEnableReadiness, assertMemoryEnableReadiness, MEMORY_ENABLE_SOURCE_GUARD_LUA, type MemoryEnableReadinessSnapshot } from '../../memory/memoryEnableReadiness'
import { createHash } from 'node:crypto'
import {
  resolveAgentMemoryEnabled, resolveMemoryLaneBudgets, resolveMemoryLingerTurns,
  resolveMemoryRecallLingerTurns
} from '$lib/utils/memoryControl'
import { resolveApiPresentationValues, resolveApiRetentionValues } from '$lib/appActions/settings/apiReasoningPreferences'
import { planRecordFieldOps } from '$lib/server/agentRecordUpdate'
import { acquireSettingsMutation, assertSettingsLifecycle, captureSettingsLifecycle, type SettingsLifecycleSnapshot } from './lifecycle'
import { canonicalToolName, getToolSettings, shouldPreferFieldSettingsForTool, toolCategories } from '$lib/utils/toolRenderMap'
import { parseMcpPrerequisiteTarget, mcpZipStoredChanges, type McpPrerequisiteTarget, type McpTargetReview } from '$lib/appActions/settings/mcpConfiguration'
import type { AdapterContext } from '../managementTypes'
import { joinMcpRawFences, type GatewayRawFence } from '../mcp/gatewayWriteContext'
import {
  refuseSettings, requireOwnActor, validateOwnRead, validateOwnUpdate, validateSettingsUpdate,
  type IdentityPreferenceChanges, type IdentityPreferenceValues, type MemoryPreferenceChanges,
  type MemoryPreferenceValues, type SettingsFamily, type SettingsOwnerContext, type SettingsPreferenceChanges, type SettingsPreferenceValues
} from '$lib/appActions/settings/validation'

// Only these paths can be read or changed. The internal raw budget block never
// leaves this service: its exact bytes are used solely for a conditional write.
export const SETTINGS_SNAPSHOT_PATHS = [
  '$.id', '$.user_id', '$.agentType', '$.displayName', '$.memory_enabled',
  '$.memory_lane_budgets', '$.memoryLaneBudgets', '$.memory_linger_turns',
  '$.memoryLingerTurns', '$.memory_recall_linger_turns', '$.memoryRecallLingerTurns', '$.memoryEnabled',
  '$.show_reasoning', '$.show_whiteboard', '$.api_reasoning_retention', '$.whiteboard_budget_tokens',
  ...MEMORY_WINDOW_MODE_PATHS
] as const

export const READ_SETTINGS_SNAPSHOT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return {'INVALID_RECORD'} end
local out = {'OK'}
for index, path in ipairs(cjson.decode(ARGV[1])) do
  local t = redis.call('JSON.TYPE', KEYS[1], path)
  local shape = t and t[1] or ''
  if index >= 17 and index <= 20 and shape ~= '' and shape ~= 'null' and
    (shape ~= 'string' or redis.call('JSON.STRLEN', KEYS[1], path)[1] > 16) then
    out[#out + 1] = '["invalid_saved_memory_mode"]'
  else out[#out + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
end
for _, path in ipairs({'$.memory_window', '$.memoryWindow'}) do
  local t = redis.call('JSON.TYPE', KEYS[1], path)
  out[#out + 1] = t and t[1] or ''
end
return out
`

// Every ownership/revision/value/container check precedes the first mutation.
// The caller also validates through the existing planner before EVAL. Lua has
// no rollback on an error, so no fallible shape discovery occurs after writes.
export const CONDITIONAL_SETTINGS_WRITE_SCRIPT = `
${MEMORY_ENABLE_SOURCE_GUARD_LUA}
if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING' end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return 'INVALID_RECORD' end
local function value(path)
  local raw = redis.call('JSON.GET', KEYS[1], path)
  if not raw then return nil end
  return cjson.decode(raw)[1]
end
if value('$.id') ~= ARGV[1] or value('$.user_id') ~= ARGV[2] then return 'FORBIDDEN' end
local kind = ARGV[7] or 'primary'
local agentType = value(kind == 'subagent' and '$.subagentType' or '$.agentType')
if agentType ~= 'api' then return 'UNSUPPORTED_PRIMARY' end
local fence = cjson.decode(ARGV[8] or '[]')
if #fence > 0 then
  if not KEYS[2] or redis.call('JSON.TYPE', KEYS[2], '$')[1] ~= 'object' then return 'AUTHORITY_CHANGED' end
  for _, entry in ipairs(fence) do
    if (redis.call('JSON.GET', KEYS[2], entry[1]) or '') ~= entry[2] then return 'AUTHORITY_CHANGED' end
  end
elseif kind ~= 'primary' or (value('$.app_action_policy') ~= nil and value('$.app_action_policy') ~= cjson.null) then return 'AUTHORITY_REQUIRED' end
if ARGV[9] and ARGV[9] ~= '' then
  local now = redis.call('TIME')
  if tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) >= tonumber(ARGV[9]) then return 'EXPIRED' end
end
local expected = cjson.decode(ARGV[3])
for _, entry in ipairs(expected) do
  if (redis.call('JSON.GET', KEYS[1], entry[1]) or '') ~= entry[2] then return 'CONFLICT' end
end
local timestampValid, timestamp = pcall(cjson.decode, ARGV[6])
if not timestampValid or type(timestamp) ~= 'string' or not string.match(timestamp, '^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.%d%d%dZ$') then return 'INVALID_TIMESTAMP' end
local family = ARGV[4]
if family == 'memory' then
  local parents = cjson.decode(ARGV[10] or '["",""]')
  for index, path in ipairs({'$.memory_window', '$.memoryWindow'}) do
    local t = redis.call('JSON.TYPE', KEYS[1], path)
    if (t and t[1] or '') ~= parents[index] then return 'CONFLICT' end
  end
  if ARGV[11] and ARGV[11] ~= '' and not memoryEnableSourceMatches(KEYS[tonumber(ARGV[12])], ARGV[11]) then return 'MEMORY_SOURCE_CHANGED' end
end
if kind == 'subagent' and family ~= 'identity' then return 'UNSUPPORTED_PRIMARY' end
if (family == 'api-presentation' or family == 'api-retention') and agentType ~= 'api' then return 'UNSUPPORTED_PRIMARY' end
local changes = cjson.decode(ARGV[5])
local paths = {
  onMyMind = '$.memory_lane_budgets.on_my_mind',
  triggers = '$.memory_lane_budgets.triggers',
  recalled = '$.memory_lane_budgets.recalled',
  triggerLingerTurns = '$.memory_linger_turns',
  recallLingerTurns = '$.memory_recall_linger_turns'
}
local apiPaths = { displayReasoning = '$.show_reasoning', displayWhiteboard = '$.show_whiteboard', mode = '$.api_reasoning_retention', whiteboardBudgetTokens = '$.whiteboard_budget_tokens' }
local count = 0
local budgets = false
for name, newValue in pairs(changes) do
  count = count + 1
  if family == 'identity' then
    if name ~= 'displayName' or type(newValue) ~= 'string' or #newValue == 0 or #newValue > 600 then return 'INVALID_CHANGES' end
  elseif family == 'memory' then
    if name == 'enabled' then
      if type(newValue) ~= 'boolean' then return 'INVALID_CHANGES' end
      local enabled = value('$.memory_enabled')
      if type(enabled) ~= 'boolean' then enabled = value('$.memoryEnabled') end
      if newValue == true and enabled ~= true and (not ARGV[11] or ARGV[11] == '') then return 'MEMORY_READINESS_REQUIRED' end
    elseif name == 'windowMode' then
      if newValue ~= 'auto' then return 'INVALID_CHANGES' end
      local root = '$.memory_window'
      local t = redis.call('JSON.TYPE', KEYS[1], root)
      if not t[1] or t[1] == 'null' then root = '$.memoryWindow'; t = redis.call('JSON.TYPE', KEYS[1], root) end
      if t[1] ~= 'object' then return 'INVALID_MEMORY_WINDOW' end
      for _, leaf in ipairs({'floor_mode', 'ceiling_headroom_mode'}) do
        local old = value(root..'.'..leaf)
        if old ~= nil and old ~= cjson.null and old ~= 'auto' and old ~= 'custom' then return 'INVALID_MEMORY_WINDOW' end
      end
    else
      if not paths[name] or type(newValue) ~= 'number' or newValue ~= math.floor(newValue) then return 'INVALID_CHANGES' end
      local maximum = (name == 'triggerLingerTurns' or name == 'recallLingerTurns') and 8 or 20000
      if newValue < 0 or newValue > maximum then return 'INVALID_CHANGES' end
    end
    if name == 'onMyMind' or name == 'triggers' or name == 'recalled' then budgets = true end
  elseif family == 'api-presentation' then
    if (name ~= 'displayReasoning' and name ~= 'displayWhiteboard') or (newValue ~= cjson.null and type(newValue) ~= 'boolean') then return 'INVALID_CHANGES' end
  elseif family == 'api-retention' then
    if name == 'mode' then
      if newValue ~= cjson.null and newValue ~= 'whiteboard' and newValue ~= 'preserve' and newValue ~= 'both' and newValue ~= 'neither' then return 'INVALID_CHANGES' end
    elseif name == 'whiteboardBudgetTokens' then
      if newValue ~= cjson.null and (type(newValue) ~= 'number' or newValue ~= math.floor(newValue) or newValue < 250 or newValue > 16000) then return 'INVALID_CHANGES' end
    else return 'INVALID_CHANGES' end
  else return 'INVALID_CHANGES' end
end
if count == 0 then return 'INVALID_CHANGES' end
if budgets then
  local budgetType = redis.call('JSON.TYPE', KEYS[1], '$.memory_lane_budgets')[1]
  if budgetType and budgetType ~= 'null' and budgetType ~= 'object' then return 'INVALID_BUDGET_SHAPE' end
  if (not budgetType or budgetType == 'null') and value('$.memoryLaneBudgets') ~= nil and value('$.memoryLaneBudgets') ~= cjson.null then
    return 'LEGACY_BUDGETS'
  end
end
-- Mutation boundary: every path is fixed and every JSON value prevalidated.
if budgets and redis.call('JSON.TYPE', KEYS[1], '$.memory_lane_budgets')[1] ~= 'object' then
  redis.call('JSON.SET', KEYS[1], '$.memory_lane_budgets', '{}')
end
if family == 'identity' then
  redis.call('JSON.SET', KEYS[1], '$.displayName', cjson.encode(changes.displayName))
elseif family == 'memory' then
  for name, newValue in pairs(changes) do
    if name == 'enabled' then redis.call('JSON.SET', KEYS[1], '$.memory_enabled', cjson.encode(newValue))
    elseif name == 'windowMode' then
      local t = redis.call('JSON.TYPE', KEYS[1], '$.memory_window')
      local root = t[1] and t[1] ~= 'null' and '$.memory_window' or '$.memoryWindow'
      redis.call('JSON.SET', KEYS[1], root..'.floor_mode', '"auto"')
      redis.call('JSON.SET', KEYS[1], root..'.ceiling_headroom_mode', '"auto"')
    else redis.call('JSON.SET', KEYS[1], paths[name], cjson.encode(newValue)) end
  end
else
  for name, newValue in pairs(changes) do
    if newValue == cjson.null then redis.call('JSON.DEL', KEYS[1], apiPaths[name])
    else redis.call('JSON.SET', KEYS[1], apiPaths[name], cjson.encode(newValue)) end
  end
end
redis.call('JSON.SET', KEYS[1], '$.updated_at', cjson.encode(timestamp))
return 'OK'
`

export type SettingsSnapshot = { raw: readonly string[]; memoryWindowParents?: MemoryWindowParents; incarnationRaw?: string; lifecycle?: SettingsLifecycleSnapshot }
type Snapshot = SettingsSnapshot
export type SettingsRead<V> = { subjectAgentId: string; revision: string; values: V; stored?: Record<string, unknown>; memoryEnabled?: boolean }
export type SettingsWriteResult<V, C> = {
  status: 'completed' | 'no_op' | 'blocked' | 'unknown_outcome'
  reason?: string
  saved: 'saved' | 'not_requested' | 'unknown'
  readback: 'verified' | 'unavailable' | 'changed' | 'not_requested'
  visible: 'unknown' | 'unchanged'
  current?: SettingsRead<V>
  inverse?: { subjectAgentId: string; expectedRevision: string; changes: C }
  inverseUnavailable?: string
}
type SettingsEvalClient = {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}
const MCP_TARGET_IDENTITY_PATHS = ['$.id', '$.user_id', '$.agentType', '$.created_at', '$.displayName', '$.defaultMCPGateways', '$.default_mcp_gateways'] as const
const MCP_TARGET_ZIP_PATHS = ['$.custom_tool_settings', '$.buffer_size', '$.zip_threshold', '$.buffer_size_all_other_tools', '$.zip_threshold_all_other_tools',
  '$.auto_zip_all_other_tools', '$.zip_disabled_all_other_tools'] as const
function mcpSettingsIdentity(toolName: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(toolName) || canonicalToolName(toolName) !== toolName || shouldPreferFieldSettingsForTool(toolName) ||
    Object.values(toolCategories).some(names => names.includes(toolName))) throw new Error('This logical MCP tool does not have an independent supported Zip row.')
  return toolName
}
export const READ_MCP_TARGET_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return {'INVALID_RECORD'} end
local out = {'OK'}
for _, path in ipairs(cjson.decode(ARGV[1])) do
  local raw = redis.call('JSON.GET', KEYS[1], path) or ''
  if #raw > 262144 then return {'UNAVAILABLE'} end
  out[#out + 1] = raw
end
if ARGV[2] == 'zip' then
  local raw = redis.call('JSON.GET', KEYS[2], '$.global_zip_settings') or ''
  if #raw > 262144 then return {'UNAVAILABLE'} end
  out[#out + 1] = raw
end
return out
`
/** Fixed two-leaf target mutation. Raw identity/source/key/authority/time checks
 * all precede JSON.SET. The same EVAL returns the actual saved leaf answers. */
export const CONDITIONAL_MCP_TARGET_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return {'MISSING'} end
local cuts = cjson.decode(ARGV[1])
for index, paths in ipairs(cuts) do
  for _, entry in ipairs(paths) do
    if (redis.call('JSON.GET', KEYS[index], entry[1]) or '') ~= entry[2] then return {'CONFLICT'} end
  end
end
local source = cjson.decode(ARGV[6])
local sourceKey = KEYS[#KEYS]
local found = nil
if redis.call('EXISTS', sourceKey) ~= 0 then
  local lengths = redis.pcall('JSON.ARRLEN', sourceKey, '$.gateways')
  if type(lengths) ~= 'table' or type(lengths[1]) ~= 'number' or lengths[1] > 256 then return {'CONFLICT'} end
  for index = 0, lengths[1] - 1 do
    local raw = redis.pcall('JSON.GET', sourceKey, '$.gateways[' .. index .. '].id')
    if type(raw) ~= 'string' then return {'CONFLICT'} end
    local valid, ids = pcall(cjson.decode, raw)
    if not valid or type(ids) ~= 'table' then return {'CONFLICT'} end
    if ids[1] == source.gatewayId then
      if found ~= nil then return {'CONFLICT'} end
      found = index
    end
  end
end
if source.createdAt == cjson.null then
  if found ~= nil then return {'CONFLICT'} end
else
  if found == nil then return {'CONFLICT'} end
  local raw = redis.pcall('JSON.GET', sourceKey, '$.gateways[' .. found .. '].created_at')
  if type(raw) ~= 'string' then return {'CONFLICT'} end
  local valid, created = pcall(cjson.decode, raw)
  if not valid or type(created) ~= 'table' or created[1] ~= source.createdAt then return {'CONFLICT'} end
end
local changes = cjson.decode(ARGV[3])
local count = #changes
local seen = {}
for _, entry in ipairs(changes) do
  local field, serialized = entry[1], entry[2]
  if field ~= 'defaultMCPGateways' and field ~= 'custom_tool_settings' then return {'INVALID_CHANGES'} end
  if seen[field] or type(serialized) ~= 'string' or string.sub(serialized, 1, 1) ~= '[' then return {'INVALID_CHANGES'} end
  local valid, value = pcall(cjson.decode, serialized)
  if not valid or type(value) ~= 'table' then return {'INVALID_CHANGES'} end
  seen[field] = true
end
if count > 2 then return {'INVALID_CHANGES'} end
local timestampValid, timestamp = pcall(cjson.decode, ARGV[4])
if not timestampValid or type(timestamp) ~= 'string' or not string.match(timestamp, '^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.%d%d%dZ$') then return {'INVALID_CHANGES'} end
local now = redis.call('TIME')
if tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) >= tonumber(ARGV[2]) then return {'EXPIRED'} end
for _, entry in ipairs(changes) do redis.call('JSON.SET', KEYS[1], '$.' .. entry[1], entry[2]) end
if count > 0 then redis.call('JSON.SET', KEYS[1], '$.updated_at', ARGV[4]) end
local out = {count > 0 and 'SAVED' or 'UNCHANGED'}
for _, path in ipairs(cjson.decode(ARGV[5])) do
  local raw = redis.pcall('JSON.GET', KEYS[1], path)
  if type(raw) ~= 'string' then return out end
  out[#out + 1] = raw
end
return out
`
declare const mcpTargetAckBrand: unique symbol
export type McpTargetWriteAck = Readonly<{ readonly [mcpTargetAckBrand]: true }>
export type McpTargetSnapshot = Readonly<{
  userId: string; subjectId: string; paths: readonly string[]; raw: readonly string[]; row: Readonly<Record<string, unknown>>
  zipToolName?: string; globalRaw?: string; globalZip?: Readonly<Record<string, unknown>>; lifecycle: SettingsLifecycleSnapshot
}>
export type McpTargetPostimage = Readonly<{
  subject: Readonly<{ kind: 'primary'; id: string }>; before: McpTargetSnapshot; intent: McpPrerequisiteTarget
  settingsIdentity?: string; updates: Readonly<Record<string, unknown>>; review: McpTargetReview
}>
export type McpSourceIdentityGuard = Readonly<{ gatewayId: string; createdAt: string | null }>
function freezeMcpData<T>(input: T): T {
  const todo: Array<[unknown, number]> = [[input, 0]], seen = new Set<object>()
  while (todo.length) {
    const [value, depth] = todo.pop()!
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    if (depth > 64 || seen.size >= 32768) throw new Error('The fixed MCP data projection is unavailable.')
    seen.add(value)
    for (const child of Object.values(value)) todo.push([child, depth + 1])
    Object.freeze(value)
  }
  return input
}
export function planMcpTarget(before: McpTargetSnapshot, intent: McpPrerequisiteTarget, actualSettingsIdentity = intent.zip?.toolName): McpTargetPostimage {
  intent = parseMcpPrerequisiteTarget(intent)
  if (intent.subject.id !== before.subjectId) throw new Error('The intended Primary target changed.')
  const gateways = before.row.defaultMCPGateways ?? before.row.default_mcp_gateways
  if (gateways !== undefined && gateways !== null && (!Array.isArray(gateways) || gateways.length > 256 || gateways.some(id => typeof id !== 'string') || new Set(gateways).size !== gateways.length)) throw new Error('The saved MCP membership is unavailable.')
  const selected = Array.isArray(gateways) ? [...gateways] as string[] : []
  const had = selected.includes(intent.gatewayId), wants = intent.membership === 'enable'
  const updates: Record<string, unknown> = {}
  if (had !== wants) updates.defaultMCPGateways = wants ? [...selected, intent.gatewayId] : selected.filter(id => id !== intent.gatewayId)
  const changes: McpTargetReview['changes'][number][] = [{ field: 'membership', label: `Source ${intent.gatewayId} selected`, before: had, after: wants }]
  let settingsIdentity: string | undefined
  let effectiveZip: McpTargetReview['effectiveZip']
  if (intent.zip) {
    settingsIdentity = mcpSettingsIdentity(actualSettingsIdentity!)
    if (before.zipToolName !== settingsIdentity) throw new Error('The held MCP Zip inheritance belongs to another logical tool.')
    const rawRows = before.row.custom_tool_settings
    if (rawRows !== undefined && rawRows !== null && (!Array.isArray(rawRows) || rawRows.length > 256)) throw new Error('The saved custom tool rows are unavailable.')
    const rows = structuredClone((rawRows ?? []) as Array<Record<string, unknown>>)
    if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || typeof row.tool_name !== 'string') ||
      new Set(rows.map(row => row.tool_name)).size !== rows.length) throw new Error('The saved custom tool identities are unavailable.')
    const found = rows.findIndex(row => row.tool_name === settingsIdentity), prior = found < 0 ? undefined : rows[found]
    const next: Record<string, unknown> = { ...prior, tool_name: settingsIdentity }
    for (const [field, value] of Object.entries(mcpZipStoredChanges(intent.zip))) {
      const previous = prior && Object.hasOwn(prior, field) ? prior[field] : 'unset'
      if (previous !== 'unset' && previous !== null && !['number', 'boolean'].includes(typeof previous)) throw new Error('The saved Zip row is unavailable.')
      changes.push({ field: `zip.${field}`, label: `${settingsIdentity}: ${field}`, before: previous as string | number | boolean | null, after: value! })
      if (value === null) delete next[field]
      else next[field] = value
    }
    const keep = Object.keys(next).some(field => field !== 'tool_name')
    if (found < 0) { if (keep) rows.push(next) }
    else if (keep) rows[found] = next
    else rows.splice(found, 1)
    if (JSON.stringify(rows) !== JSON.stringify(rawRows ?? [])) {
      const index = before.paths.indexOf('$.custom_tool_settings')
      if (Array.isArray(rawRows) && (index < 0 || JSON.stringify([rawRows]) !== before.raw[index])) {
        throw new Error('The custom-tool literal representation cannot be preserved by this automatic edit.')
      }
      updates.custom_tool_settings = rows
    }
    // The complete review includes actual applicable inheritance, from the SAME
    // fixed read; no config/model/media resolver or later global read is used.
    const effective = (row: Readonly<Record<string, unknown>>) => {
      const values = getToolSettings(settingsIdentity!, row, before.globalZip)
      return { ...values, buffer_size: Number.isFinite(values.buffer_size) ? values.buffer_size : 'unlimited' as const,
        zip_threshold: Number.isFinite(values.zip_threshold) ? values.zip_threshold : 'unlimited' as const }
    }
    effectiveZip = { before: effective(before.row), after: effective({ ...before.row, ...updates }) }
  }
  return freezeMcpData({ subject: intent.subject, before, intent: structuredClone(intent), ...(settingsIdentity ? { settingsIdentity } : {}), updates,
    review: { subject: intent.subject, label: typeof before.row.displayName === 'string' && before.row.displayName ? before.row.displayName : before.subjectId, changes,
      ...(settingsIdentity ? { settingsIdentity, effectiveZip } : {}) } })
}
export type SettingsRedisClient = SettingsEvalClient & {
  readonly isOpen: boolean
  readonly isReady: boolean
  withAbortSignal(signal: AbortSignal): SettingsEvalClient
  on(event: 'error' | 'end' | 'reconnecting', listener: () => void): unknown
  removeListener(event: 'error' | 'end' | 'reconnecting', listener: () => void): unknown
}
export type SettingsRedisExecutor = <T>(operation: (client: SettingsRedisClient) => Promise<T>) => Promise<T>
class SettingsSaveAdmissionRefusal extends Error {
  constructor(readonly reason: string) { super(reason) }
}
export type ConditionalSettingsStore = {
  readMcpTarget?(userId: string, subject: Readonly<{ kind: 'primary'; id: string }>, zipToolName?: string): Promise<McpTargetSnapshot>
  writeMcpTarget?(plan: McpTargetPostimage, adapter: AdapterContext, fences: readonly GatewayRawFence[], sourceIdentity: McpSourceIdentityGuard, beforeIssue: () => void,
    onSaved: (ack: McpTargetWriteAck | undefined, saved: 'saved' | 'not_requested') => void, onRefused?: () => void): Promise<McpTargetWriteAck>
  readMcpTargetResult?(ack: McpTargetWriteAck): Readonly<{ plan: McpTargetPostimage; raw: readonly string[]; saved: 'saved' | 'not_requested' }>
  readConfiguredTts?(userId: string, subjectAgentId: string, exactProfileId?: string, catalog?: import('./configuredTtsSources').ConfiguredTtsTarget['catalog']): Promise<import('./configuredTtsSources').ConfiguredTtsTarget>
  readMemoryReadiness?(): Promise<MemoryEnableReadinessSnapshot>
  readAutoCompact?(userId: string, subjectAgentId: string): Promise<import('$lib/server/autoCompactGuard').AutoCompactSnapshot>
  readInstructions?(userId: string, subjectAgentId: string, kind: 'primary' | 'subagent', options: { includeText: boolean; prompt?: boolean }): Promise<import('./instructionTextSnapshot').InstructionTextRead>
  readSelection?(subjectAgentId: string, kind?: 'primary' | 'subagent'): Promise<import('$lib/server/modelSelectionGuard').ModelSelectionSnapshot>
  read(subjectAgentId: string, kind?: 'primary' | 'subagent'): Promise<Snapshot>
  write(subjectAgentId: string, userId: string, family: SettingsFamily, before: Snapshot, changes: SettingsPreferenceChanges, admit?: () => void, signal?: AbortSignal, deadlineAt?: number, context?: Pick<SettingsOwnerContext, 'subjectKind' | 'authorityFence' | 'memoryEnableSource'>): Promise<string>
}

export function createConditionalSettingsStore(execute: SettingsRedisExecutor, isCommandAbortError: (error: unknown) => boolean, options?: { captureIncarnation: true }): ConditionalSettingsStore {
  const mcpReads = new WeakSet<object>()
  const mcpAcks = new WeakMap<object, Readonly<{ plan: McpTargetPostimage; raw: readonly string[]; saved: 'saved' | 'not_requested' }>>()
  return {
    async readMcpTarget(userId, subject, zipToolName) {
      if (subject.kind !== 'primary' || !subject.id || !userId) throw new Error('The exact MCP Primary target is unavailable.')
      const withZip = zipToolName !== undefined
      if (zipToolName !== undefined) mcpSettingsIdentity(zipToolName)
      const key = `agent:${subject.id}`, globalKey = `user:${userId}:settings`
      const lifecycle = captureSettingsLifecycle([key, ...(withZip ? [globalKey] : [])])
      const inheritedFields = withZip ? ['buffer_size', 'zip_threshold', 'auto_zip', 'zip_disabled'].map(prefix => `${prefix}_${zipToolName}`) : []
      const paths = [...MCP_TARGET_IDENTITY_PATHS, ...(withZip ? MCP_TARGET_ZIP_PATHS : []), ...inheritedFields.map(field => `$[${JSON.stringify(field)}]`)]
      const answer = await execute(client => client.eval(READ_MCP_TARGET_SCRIPT, {
        keys: [key, ...(withZip ? [globalKey] : [])], arguments: [JSON.stringify(paths), withZip ? 'zip' : 'membership']
      }))
      assertSettingsLifecycle(lifecycle)
      if (!Array.isArray(answer) || answer[0] !== 'OK' || answer.length !== 1 + paths.length + Number(withZip) ||
        answer.slice(1).some(value => typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 262144)) throw new Error('The fixed MCP target read is unavailable.')
      const raw = answer.slice(1, paths.length + 1) as string[]
      const row = Object.fromEntries(paths.map((path, index) => [path.startsWith('$.') ? path.slice(2) : JSON.parse(path.slice(2, -1)), parseSnapshotValue(raw[index])]))
      if (row.id !== subject.id || row.user_id !== userId || row.agentType !== 'api' ||
        typeof row.created_at !== 'string' || !row.created_at || row.created_at.length > 128 ||
        typeof row.displayName !== 'string' || row.displayName.length > 200) throw new Error('The actual owned MCP Primary incarnation is unavailable.')
      const globalRaw = withZip ? answer.at(-1) as string : undefined
      const globalZip = globalRaw === undefined ? undefined : parseSnapshotValue(globalRaw)
      if (globalZip !== undefined && globalZip !== null && (typeof globalZip !== 'object' || Array.isArray(globalZip))) throw new Error('The saved Zip inheritance is unavailable.')
      const snapshot: McpTargetSnapshot = freezeMcpData({ userId, subjectId: subject.id, paths: Object.freeze(paths), raw: Object.freeze(raw),
        row: Object.freeze(row), lifecycle, ...(zipToolName !== undefined ? { zipToolName } : {}), ...(globalRaw !== undefined ? { globalRaw, globalZip: (globalZip ?? {}) as Record<string, unknown> } : {}) })
      mcpReads.add(snapshot)
      return snapshot
    },
    readMcpTargetResult(ack) {
      const result = mcpAcks.get(ack)
      if (!result) throw new Error('The actual MCP target acknowledgement is unavailable.')
      return result
    },
    async writeMcpTarget(plan, adapter, fences, sourceIdentity, beforeIssue, onSaved, onRefused) {
      const before = plan.before
      if (!mcpReads.has(before) || adapter.admission.actor.userId !== before.userId || plan.subject.id !== before.subjectId ||
        JSON.stringify(planMcpTarget(before, plan.intent, plan.settingsIdentity)) !== JSON.stringify(plan) || sourceIdentity.gatewayId !== plan.intent.gatewayId ||
        sourceIdentity.createdAt !== null && (typeof sourceIdentity.createdAt !== 'string' || !sourceIdentity.createdAt)) throw new Error('The exact held MCP target plan is unavailable.')
      // Claim the actual read once before client acquisition; no late/unknown
      // attempt can turn this captured plan back into write eligibility.
      mcpReads.delete(before)
      const targetKey = `agent:${before.subjectId}`
      const cuts = joinMcpRawFences([{ key: targetKey, paths: before.paths.map((path, index) => [path, before.raw[index]] as const) },
        ...(before.globalRaw !== undefined ? [{ key: `user:${before.userId}:settings`, paths: [['$.global_zip_settings', before.globalRaw] as const] }] : [])],
        [adapter.admission.fence], fences) // target stays the first-seen key: Lua KEYS[1]
      if (!adapter.admission.fence.lifecycle || !adapter.admission.fence.paths.length || cuts.some(cut => !cut.paths.length)) throw new Error('Actual MCP target authority is unavailable.')
      const serialized = Object.entries(plan.updates).map(([field, value]) => [field, JSON.stringify(value)])
      const args = [JSON.stringify(cuts.map(cut => cut.paths)), String(adapter.deadlineAt), JSON.stringify(serialized),
        JSON.stringify(new Date().toISOString()), JSON.stringify(before.paths), JSON.stringify(sourceIdentity)]
      let issued = false, known = false, acknowledged = false
      let lease: ReturnType<typeof acquireSettingsMutation> | undefined
      try {
        const answer: unknown = await execute(async client => {
          const abort = new AbortController(), cancelled = () => abort.abort()
          const signals = [...new Set([adapter.signal, adapter.admission.signal].filter((value): value is AbortSignal => !!value))]
          const events = ['error', 'end', 'reconnecting'] as const
          for (const event of events) client.on(event, cancelled)
          for (const signal of signals) { signal.addEventListener('abort', cancelled, { once: true }); if (signal.aborted) cancelled() }
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const lifetime = { epoch: before.lifecycle.epoch, records: [...before.lifecycle.records, ...adapter.admission.fence.lifecycle!.records] }
            lease = acquireSettingsMutation(lifetime)
            const remaining = Math.min(adapter.deadlineAt, adapter.admission.expiresAt ?? Infinity) - Date.now()
            if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 2147483647) throw new SettingsSaveAdmissionRefusal('operation_no_longer_admitted')
            timer = setTimeout(cancelled, remaining)
            const current = () => {
              adapter.assertCurrent(); lease!.check()
              if (!client.isOpen || !client.isReady || abort.signal.aborted) throw new SettingsSaveAdmissionRefusal('settings_store_not_ready')
            }
            current(); beforeIssue(); current()
            const command = client.withAbortSignal(abort.signal)
            current()
            issued = true
            try { return await command.eval(CONDITIONAL_MCP_TARGET_SCRIPT, { keys: [...cuts.map(cut => cut.key), `mcp_gateways:${before.userId}`], arguments: args }) }
            catch (error) {
              if (abort.signal.aborted && isCommandAbortError(error)) { issued = false; throw new SettingsSaveAdmissionRefusal('operation_no_longer_admitted') }
              throw error
            }
          } finally {
            if (timer) clearTimeout(timer)
            for (const event of events) client.removeListener(event, cancelled)
            for (const signal of signals) signal.removeEventListener('abort', cancelled)
          }
        })
        if (!Array.isArray(answer) || typeof answer[0] !== 'string') throw new Error('The actual MCP target write answer is unavailable.')
        if (['MISSING', 'CONFLICT', 'EXPIRED', 'INVALID_CHANGES'].includes(answer[0])) { known = true; lease?.settle(); throw new SettingsSaveAdmissionRefusal(`mcp_target_${answer[0].toLowerCase()}`) }
        if (!['SAVED', 'UNCHANGED'].includes(answer[0])) throw new Error('The actual MCP target write answer is unavailable.')
        // Preserve KNOWN write truth before parsing postimage evidence or callbacks.
        known = true; lease?.settle()
        acknowledged = true
        const saved = answer[0] === 'SAVED' ? 'saved' as const : 'not_requested' as const
        if (answer.length !== before.paths.length + 1 || answer.slice(1).some(raw => typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 262144)) {
          onSaved(undefined, saved)
          throw new Error('The target write was acknowledged but its postimage is unavailable.')
        }
        const raw = answer.slice(1) as string[]
        try { for (const value of raw) parseSnapshotValue(value) }
        catch (error) { onSaved(undefined, saved); throw error }
        const ack = Object.freeze({}) as McpTargetWriteAck
        mcpAcks.set(ack, Object.freeze({ plan, raw: Object.freeze(raw), saved }))
        onSaved(ack, saved)
        return ack
      } catch (error) {
        if (!known) { if (issued) lease?.unknown(); else lease?.settle() }
        if (!acknowledged && (known || !issued)) {
          try { onRefused?.() } catch { /* preserve the actual refusal/error identity */ }
        }
        throw error
      }
    },
    readMemoryReadiness() { return execute(client => readMemoryEnableReadiness(client)) },
    async read(subjectAgentId, kind = 'primary') {
      const lifecycle = captureSettingsLifecycle([`${kind === 'subagent' ? 'subagent' : 'agent'}:${subjectAgentId}`])
      const paths: string[] = SETTINGS_SNAPSHOT_PATHS.map((path, index) => index === 2 && kind === 'subagent' ? '$.subagentType' : path)
      if (options?.captureIncarnation) paths.push('$.created_at')
      const answer = await execute(client => client.eval(READ_SETTINGS_SNAPSHOT_SCRIPT, {
        keys: [`${kind === 'subagent' ? 'subagent' : 'agent'}:${subjectAgentId}`], arguments: [JSON.stringify(paths)]
      }))
      assertSettingsLifecycle(lifecycle)
      if (!Array.isArray(answer) || answer[0] !== 'OK' || answer.length !== paths.length + 3 || answer.slice(1).some(item => typeof item !== 'string')) {
        if (Array.isArray(answer) && answer[0] === 'MISSING') refuseSettings('agent_not_found')
        refuseSettings('agent_record_unavailable')
      }
      const raw = answer.slice(1, SETTINGS_SNAPSHOT_PATHS.length + 1) as string[]
      // Check RedisJSON's real JSONPath shape (one-element array or []), never
      // assume json.get's root-object answer has the same wire shape.
      for (const item of raw) parseSnapshotValue(item)
      const incarnationRaw = options?.captureIncarnation ? answer[paths.length] as string : undefined
      if (incarnationRaw !== undefined) {
        const value = parseSnapshotValue(incarnationRaw)
        if (typeof value !== 'string' || !value || value.length > 128) refuseSettings('subject_incarnation_unavailable')
      }
      return { raw, memoryWindowParents: [answer[paths.length + 1], answer[paths.length + 2]], lifecycle, ...(incarnationRaw !== undefined ? { incarnationRaw } : {}) }
    },
    async write(subjectAgentId, userId, family, before, changes, admit, signal, deadlineAt, context) {
      if (family === 'identity') planRecordFieldOps('displayName', (changes as IdentityPreferenceChanges).displayName, new Set())
      const parents = before.memoryWindowParents ?? ['', '']
      const activeModeIndex = parents[0] !== '' && parents[0] !== 'null' ? 16 : 18
      const indices = familyIndices(family).filter(index => family !== 'memory' || index < 16 ||
        Object.hasOwn(changes, 'windowMode') && (index === activeModeIndex || index === activeModeIndex + 1))
      const kind = context?.subjectKind ?? 'primary'
      const expected = indices.map(index => [index === 2 && kind === 'subagent' ? '$.subagentType' : SETTINGS_SNAPSHOT_PATHS[index], before.raw[index]])
      if (before.incarnationRaw !== undefined) expected.push(['$.created_at', before.incarnationRaw])
      let issued = false
      let lease: ReturnType<typeof acquireSettingsMutation> | undefined
      let answer: unknown
      try { answer = await execute(async client => {
        // execute awaits getClient/reconnection before calling us. Admission and
        // readiness must therefore be checked here, immediately before issue.
        const abort = new AbortController()
        const disconnected = () => abort.abort()
        const cancelled = () => abort.abort()
        const events = ['error', 'end', 'reconnecting'] as const
        for (const event of events) client.on(event, disconnected)
        signal?.addEventListener('abort', cancelled, { once: true })
        if (signal?.aborted) cancelled()
        let deadline: ReturnType<typeof setTimeout> | undefined
        try {
          const lifecycle = before.lifecycle ?? captureSettingsLifecycle([`${kind === 'subagent' ? 'subagent' : 'agent'}:${subjectAgentId}`])
          if (context?.authorityFence?.lifecycle) assertSettingsLifecycle(context.authorityFence.lifecycle)
          lease = acquireSettingsMutation({ epoch: lifecycle.epoch, records: [...lifecycle.records, ...(context?.authorityFence?.lifecycle?.records ?? [])] })
          const options = {
            keys: [`${kind === 'subagent' ? 'subagent' : 'agent'}:${subjectAgentId}`, ...(context?.authorityFence ? [context.authorityFence.key] : []), ...(context?.memoryEnableSource ? ['batshit:memory_config'] : [])],
            arguments: [subjectAgentId, userId, JSON.stringify(expected), family, JSON.stringify(changes), JSON.stringify(new Date().toISOString()), kind,
              JSON.stringify(context?.authorityFence?.paths ?? []), deadlineAt === undefined ? '' : String(deadlineAt),
              JSON.stringify(before.memoryWindowParents ?? ['', '']), context?.memoryEnableSource?.source ?? '', context?.memoryEnableSource ? String(context.authorityFence ? 3 : 2) : '']
          }
          if (deadlineAt !== undefined) {
            const delay = deadlineAt - Date.now()
            if (!Number.isFinite(delay) || delay <= 0 || delay > 2_147_483_647) throw new SettingsSaveAdmissionRefusal('operation_no_longer_admitted')
            deadline = setTimeout(cancelled, delay)
          }
          try { admit?.(); context?.memoryEnableSource?.check(); lease.check() } catch { throw new SettingsSaveAdmissionRefusal('operation_no_longer_admitted') }
          if (!client.isOpen || !client.isReady || abort.signal.aborted) throw new SettingsSaveAdmissionRefusal('settings_store_not_ready')
          try {
            const command = client.withAbortSignal(abort.signal)
            issued = true
            return await command.eval(CONDITIONAL_SETTINGS_WRITE_SCRIPT, options)
          } catch (error) {
            // Installed node-redis removes the abort listener when a command
            // leaves toWrite. Its AbortError proves this command was not sent.
            if (abort.signal.aborted && isCommandAbortError(error)) { issued = false; throw new SettingsSaveAdmissionRefusal(signal?.aborted || deadlineAt !== undefined && deadlineAt <= Date.now() ? 'operation_no_longer_admitted' : 'settings_store_disconnected_before_write') }
            throw error
          }
        } finally {
          for (const event of events) client.removeListener(event, disconnected)
          signal?.removeEventListener('abort', cancelled)
          if (deadline !== undefined) clearTimeout(deadline)
        }
      }) } catch (error) {
        if (issued) lease?.unknown(); else lease?.settle()
        if (error instanceof SettingsSaveAdmissionRefusal) throw error
        if (!issued) throw new SettingsSaveAdmissionRefusal('settings_store_unavailable_before_write')
        throw error
      }
      if (typeof answer !== 'string') { lease?.unknown(); throw new Error('Invalid conditional Settings save answer.') }
      lease?.settle()
      return answer
    }
  }
}

function parseSnapshotValue(raw: string): unknown {
  if (raw === '') return undefined
  let value: unknown
  try { value = JSON.parse(raw) } catch { refuseSettings('invalid_settings_snapshot') }
  if (!Array.isArray(value) || value.length > 1) refuseSettings('invalid_settings_snapshot')
  return value[0]
}
const FAMILY_INDICES: Readonly<Record<SettingsFamily, readonly number[]>> = Object.freeze({
  memory: [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19], identity: [0, 1, 2, 3],
  'api-presentation': [0, 1, 2, 12, 13], 'api-retention': [0, 1, 2, 14, 15]
})
function familyIndices(family: SettingsFamily): readonly number[] {
  return FAMILY_INDICES[family]
}
function revision(snapshot: Snapshot, family: SettingsFamily): string {
  const values = familyIndices(family).map(index => snapshot.raw[index] ?? '[]')
  if (family === 'memory') values.push(JSON.stringify(snapshot.memoryWindowParents ?? ['', '']))
  if (snapshot.incarnationRaw !== undefined) values.push(snapshot.incarnationRaw)
  if (snapshot.lifecycle !== undefined) values.push(JSON.stringify(snapshot.lifecycle))
  return `sha256:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`
}
function assertOwner(snapshot: Snapshot, context: SettingsOwnerContext, subjectAgentId: string): void {
  if (parseSnapshotValue(snapshot.raw[0]) !== subjectAgentId || parseSnapshotValue(snapshot.raw[1]) !== context.actor.userId) refuseSettings('agent_not_owned')
  const type = parseSnapshotValue(snapshot.raw[2])
  // SA-139 R4/R5: a leftover `cli` Primary or Subagent is retired; only the API type is a subject.
  if (type !== 'api') refuseSettings('unsupported_primary_agent')
}
function memoryValues(snapshot: Snapshot): MemoryPreferenceValues {
  const agent = {
    memory_lane_budgets: parseSnapshotValue(snapshot.raw[5]), memoryLaneBudgets: parseSnapshotValue(snapshot.raw[6]),
    memory_linger_turns: parseSnapshotValue(snapshot.raw[7]), memoryLingerTurns: parseSnapshotValue(snapshot.raw[8]),
    memory_recall_linger_turns: parseSnapshotValue(snapshot.raw[9]), memoryRecallLingerTurns: parseSnapshotValue(snapshot.raw[10])
  }
  const budgets = resolveMemoryLaneBudgets(agent)
  let window: Pick<MemoryPreferenceValues, 'windowMode' | 'floorMode' | 'ceilingHeadroomMode'>
  try { const { floorMode, ceilingHeadroomMode, windowMode } = memoryModes(snapshot); window = { floorMode, ceilingHeadroomMode, windowMode } }
  catch { window = { windowMode: 'unknown', floorMode: 'unknown', ceilingHeadroomMode: 'unknown' } }
  return { ...window, enabled: resolveAgentMemoryEnabled({ memory_enabled: parseSnapshotValue(snapshot.raw[4]), memoryEnabled: parseSnapshotValue(snapshot.raw[11]) }), onMyMind: budgets.onMyMind, triggers: budgets.triggers, recalled: budgets.recalled,
    triggerLingerTurns: resolveMemoryLingerTurns(agent), recallLingerTurns: resolveMemoryRecallLingerTurns(agent) }
}
function identityValues(snapshot: Snapshot): IdentityPreferenceValues {
  const displayName = parseSnapshotValue(snapshot.raw[3])
  if (typeof displayName !== 'string' || displayName.length > 200 || !displayName.isWellFormed()) refuseSettings('display_name_unavailable')
  return { displayName }
}
function memoryModes(snapshot: Snapshot) {
  return memoryWindowModes(snapshot.memoryWindowParents ?? ['', ''], [16,17,18,19].map(index => parseSnapshotValue(snapshot.raw[index] ?? '[]')))
}
function budgetWriteRefusal(snapshot: Snapshot, changes: Record<string, unknown>): string | undefined {
  if (Object.hasOwn(changes, 'windowMode')) { try { memoryModes(snapshot) } catch { return 'invalid_memory_window' } }
  if (!['onMyMind', 'triggers', 'recalled'].some(key => Object.hasOwn(changes, key))) return undefined
  const canonical = parseSnapshotValue(snapshot.raw[5])
  if (canonical !== undefined && canonical !== null && (typeof canonical !== 'object' || Array.isArray(canonical))) return 'invalid_budget_shape'
  const legacy = parseSnapshotValue(snapshot.raw[6])
  if ((canonical === undefined || canonical === null) && legacy !== undefined && legacy !== null) return 'legacy_budget_settings_require_human'
}
function apiRecord(snapshot: Snapshot): Record<string, unknown> {
  return { agentType: parseSnapshotValue(snapshot.raw[2]), show_reasoning: parseSnapshotValue(snapshot.raw[12]),
    show_whiteboard: parseSnapshotValue(snapshot.raw[13]), api_reasoning_retention: parseSnapshotValue(snapshot.raw[14]),
    whiteboard_budget_tokens: parseSnapshotValue(snapshot.raw[15]) }
}
const API_FIELD_INDICES = { displayReasoning: 12, displayWhiteboard: 13, mode: 14, whiteboardBudgetTokens: 15 } as const
const isApiFamily = (family: SettingsFamily) => family === 'api-presentation' || family === 'api-retention'
function apiStoredValue(snapshot: Snapshot, field: string): unknown {
  const index = API_FIELD_INDICES[field as keyof typeof API_FIELD_INDICES]
  if (index === undefined) refuseSettings('invalid_api_preference')
  return parseSnapshotValue(snapshot.raw[index]) ?? null
}
const FAMILY_VALUES: Readonly<Record<SettingsFamily, (snapshot: Snapshot) => SettingsPreferenceValues>> = Object.freeze({
  memory: memoryValues, identity: identityValues,
  'api-presentation': snapshot => resolveApiPresentationValues(apiRecord(snapshot)),
  'api-retention': snapshot => resolveApiRetentionValues(apiRecord(snapshot))
})
function requireFamilyApplicability(snapshot: Snapshot | undefined, family: SettingsFamily, context: SettingsOwnerContext) {
  if (context.subjectKind === 'subagent' && family !== 'identity') refuseSettings(family === 'memory' ? 'memory_is_primary_only' : 'api_primary_only')
  if (snapshot && isApiFamily(family) && parseSnapshotValue(snapshot.raw[2]) !== 'api') refuseSettings('api_primary_only')
}
function effectiveChanges(snapshot: Snapshot, family: SettingsFamily, changes: SettingsPreferenceChanges, current: SettingsPreferenceValues) {
  return Object.fromEntries(Object.entries(changes).filter(([key, value]) =>
    value !== (isApiFamily(family) ? apiStoredValue(snapshot, key) : (current as Record<string, unknown>)[key])))
}
function publicRead(snapshot: Snapshot, subjectAgentId: string, family: 'memory'): SettingsRead<MemoryPreferenceValues>
function publicRead(snapshot: Snapshot, subjectAgentId: string, family: 'identity'): SettingsRead<IdentityPreferenceValues>
function publicRead(snapshot: Snapshot, subjectAgentId: string, family: SettingsFamily): SettingsRead<SettingsPreferenceValues>
function publicRead(snapshot: Snapshot, subjectAgentId: string, family: SettingsFamily) {
  return { subjectAgentId, revision: revision(snapshot, family), values: FAMILY_VALUES[family](snapshot),
    ...(isApiFamily(family) ? { stored: Object.fromEntries(Object.keys(FAMILY_VALUES[family](snapshot)).map(field => [field, apiStoredValue(snapshot, field)])) } : {}),
    ...(family === 'memory' ? { memoryEnabled: resolveAgentMemoryEnabled({ memory_enabled: parseSnapshotValue(snapshot.raw[4]), memoryEnabled: parseSnapshotValue(snapshot.raw[11]) }) } : {}) }
}

export function createAdmittedAgentSettingsExecutors(store: ConditionalSettingsStore, admitSubject: (context: SettingsOwnerContext, subjectAgentId: string) => void) {
  async function preview(family: SettingsFamily, args: unknown, context: SettingsOwnerContext) {
    const request = validateSettingsUpdate(args, family)
    admitSubject(context, request.subjectAgentId)
    requireFamilyApplicability(undefined, family, context)
    const snapshot = await store.read(request.subjectAgentId, context.subjectKind)
    context.check(); assertOwner(snapshot, context, request.subjectAgentId); requireFamilyApplicability(snapshot, family, context)
    if (revision(snapshot, family) !== request.expectedRevision) return { status: 'blocked' as const, reason: 'revision_conflict', saved: 'not_requested' as const, visible: 'unchanged' as const }
    const current = publicRead(snapshot, request.subjectAgentId, family)
    const changes: SettingsPreferenceChanges = effectiveChanges(snapshot, family, request.changes, current.values)
    const reason = family === 'memory' ? budgetWriteRefusal(snapshot, changes) : undefined
    if (reason) return { status: 'blocked' as const, reason, saved: 'not_requested' as const, visible: 'unchanged' as const }
    let memoryReadiness: MemoryEnableReadinessSnapshot | undefined
    if (family === 'memory' && (changes as MemoryPreferenceChanges).enabled === true) {
      try {
        memoryReadiness = await store.readMemoryReadiness?.()
        if (!memoryReadiness) throw new Error('memory_readiness_unavailable')
        assertMemoryEnableReadiness(memoryReadiness); context.check()
        if (snapshot.lifecycle) assertSettingsLifecycle(snapshot.lifecycle)
      } catch { return { status: 'blocked' as const, reason: memoryReadiness?.reason ?? 'memory_readiness_unavailable', saved: 'not_requested' as const, visible: 'unchanged' as const } }
    }
    return { memoryReadiness, status: Object.keys(changes).length ? 'preview' as const : 'no_op' as const, saved: 'not_requested' as const, visible: 'unchanged' as const,
      requiresConfirmation: family === 'memory' || family === 'api-retention', current, changes }
  }
  async function readMemory(args: unknown, context: SettingsOwnerContext) {
    const { subjectAgentId } = validateOwnRead(args)
    admitSubject(context, subjectAgentId)
    if (context.subjectKind === 'subagent') refuseSettings('memory_is_primary_only')
    const snapshot = await store.read(subjectAgentId, context.subjectKind)
    context.check(); assertOwner(snapshot, context, subjectAgentId)
    return publicRead(snapshot, subjectAgentId, 'memory')
  }
  async function readIdentity(args: unknown, context: SettingsOwnerContext) {
    const { subjectAgentId } = validateOwnRead(args)
    admitSubject(context, subjectAgentId)
    const snapshot = await store.read(subjectAgentId, context.subjectKind)
    context.check(); assertOwner(snapshot, context, subjectAgentId)
    return publicRead(snapshot, subjectAgentId, 'identity')
  }
  async function update(family: SettingsFamily, args: unknown, context: SettingsOwnerContext): Promise<SettingsWriteResult<SettingsPreferenceValues, SettingsPreferenceChanges>> {
    const request = validateSettingsUpdate(args, family)
    if (!context.signal) refuseSettings('operation_cancellation_signal_required')
    admitSubject(context, request.subjectAgentId)
    requireFamilyApplicability(undefined, family, context)
    const before = await store.read(request.subjectAgentId, context.subjectKind)
    context.check(); assertOwner(before, context, request.subjectAgentId); requireFamilyApplicability(before, family, context)
    if (revision(before, family) !== request.expectedRevision) return { status: 'blocked', reason: 'revision_conflict', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' }
    const beforeValues = FAMILY_VALUES[family](before)
    const changes = effectiveChanges(before, family, request.changes, beforeValues)
    if (!Object.keys(changes).length) return { status: 'no_op', saved: 'not_requested', readback: 'verified', visible: 'unchanged', current: publicRead(before, request.subjectAgentId, family) }
    const shapeRefusal = family === 'memory' ? budgetWriteRefusal(before, changes) : undefined
    if (shapeRefusal) return { status: 'blocked', reason: shapeRefusal, saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' }
    let writeContext = context
    if (family === 'memory' && (changes as MemoryPreferenceChanges).enabled === true && !context.memoryEnableSource) {
      let readiness: MemoryEnableReadinessSnapshot | undefined
      try {
        readiness = await store.readMemoryReadiness?.()
        if (!readiness) throw new Error('memory_readiness_unavailable')
        assertMemoryEnableReadiness(readiness)
        const captured = readiness
        writeContext = { ...context, memoryEnableSource: { source: captured.source, check() { assertMemoryEnableReadiness(captured) } } }
      } catch { return { status: 'blocked', reason: readiness?.reason ?? 'memory_readiness_unavailable', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' } }
    }
    context.check()
    let answer: string
    try { answer = await store.write(request.subjectAgentId, context.actor.userId, family, before, changes as SettingsPreferenceChanges, () => admitSubject(context, request.subjectAgentId), context.signal, context.deadlineAt, writeContext) }
    catch (error) {
      if (error instanceof SettingsSaveAdmissionRefusal) return { status: 'blocked', reason: error.reason, saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' }
      return { status: 'unknown_outcome', reason: 'save_outcome_unconfirmed', saved: 'unknown', readback: 'unavailable', visible: 'unknown' }
    }
    if (answer !== 'OK') {
      const reasons: Record<string, string> = { AUTHORITY_CHANGED: 'authority_changed', AUTHORITY_REQUIRED: 'authority_required', EXPIRED: 'operation_no_longer_admitted', CONFLICT: 'revision_conflict', MISSING: 'agent_not_found', FORBIDDEN: 'agent_not_owned', UNSUPPORTED_PRIMARY: 'unsupported_primary_agent', INVALID_BUDGET_SHAPE: 'invalid_budget_shape', LEGACY_BUDGETS: 'legacy_budget_settings_require_human', INVALID_RECORD: 'invalid_agent_record', INVALID_CHANGES: 'invalid_changes', INVALID_TIMESTAMP: 'invalid_save_timestamp', INVALID_MEMORY_WINDOW: 'invalid_memory_window', MEMORY_SOURCE_CHANGED: 'memory_source_changed', MEMORY_READINESS_REQUIRED: 'memory_readiness_required' }
      const reason = reasons[answer]
      if (!reason) return { status: 'unknown_outcome', reason: 'unexpected_save_answer', saved: 'unknown', readback: 'unavailable', visible: 'unknown' }
      return { status: 'blocked', reason, saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' }
    }
    // OK proves the save. A later outage never takes that evidence away.
    // This remains true when Stop/deadline fired while the issued write settled.
    context.onSaved?.()
    let after: Snapshot
    try { after = await store.read(request.subjectAgentId, context.subjectKind); assertOwner(after, context, request.subjectAgentId) }
    catch { return { status: 'completed', reason: 'saved_readback_unavailable', saved: 'saved', readback: 'unavailable', visible: 'unknown', inverseUnavailable: 'readback_unavailable' } }
    if (JSON.stringify(before.lifecycle) !== JSON.stringify(after.lifecycle)) return { status: 'completed', reason: 'subject_replaced_after_save', saved: 'saved', readback: 'changed', visible: 'unknown', inverseUnavailable: 'subject_replaced_after_save' }
    let current: SettingsRead<SettingsPreferenceValues>
    try { current = publicRead(after, request.subjectAgentId, family) }
    catch { return { status: 'completed', reason: 'saved_readback_unavailable', saved: 'saved', readback: 'unavailable', visible: 'unknown', inverseUnavailable: 'readback_unavailable' } }
    if (Object.entries(changes).some(([key, value]) => (isApiFamily(family) ? apiStoredValue(after, key) : (current.values as Record<string, unknown>)[key]) !== value)) {
      return { status: 'completed', reason: 'saved_then_changed', saved: 'saved', readback: 'changed', visible: 'unknown', current, inverseUnavailable: 'settings_changed_after_save' }
    }
    const inverseChanges: Record<string, unknown> = {}
    const canonical = parseSnapshotValue(before.raw[5])
    for (const key of Object.keys(changes)) {
      if (family === 'memory' && key === 'windowMode') return { status: 'completed', saved: 'saved', readback: 'verified', visible: 'unknown', current, inverseUnavailable: 'previous_window_modes_require_human' }
      if (family === 'memory' && key === 'enabled') {
        const previous = parseSnapshotValue(before.raw[4])
        if (typeof previous !== 'boolean') return { status: 'completed', saved: 'saved', readback: 'verified', visible: 'unknown', current, inverseUnavailable: 'previous_values_cannot_be_restored_losslessly' }
        inverseChanges.enabled = previous; continue
      }
      if (isApiFamily(family)) { inverseChanges[key] = apiStoredValue(before, key); continue }
      const previous = family === 'identity' ? parseSnapshotValue(before.raw[3]) :
        key === 'triggerLingerTurns' ? parseSnapshotValue(before.raw[7]) : key === 'recallLingerTurns' ? parseSnapshotValue(before.raw[9]) :
          canonical && typeof canonical === 'object' && !Array.isArray(canonical) ? (canonical as Record<string, unknown>)[key === 'onMyMind' ? 'on_my_mind' : key] : undefined
      const max = key.endsWith('LingerTurns') ? 8 : 20_000
      if (family === 'identity' ? typeof previous !== 'string' || !previous.trim() || previous.trim() !== previous || previous.length > 200 || !previous.isWellFormed() : typeof previous !== 'number' || !Number.isInteger(previous) || previous < 0 || previous > max) {
        return { status: 'completed', saved: 'saved', readback: 'verified', visible: 'unknown', current, inverseUnavailable: 'previous_values_cannot_be_restored_losslessly' }
      }
      inverseChanges[key] = previous
    }
    return { status: 'completed', saved: 'saved', readback: 'verified', visible: 'unknown', current,
      inverse: { subjectAgentId: request.subjectAgentId, expectedRevision: current.revision, changes: inverseChanges as SettingsPreferenceChanges } }
  }
  return { readMemory, readIdentity,
    previewFamily: preview, updateFamily: update,
    previewMemory: (args: unknown, context: SettingsOwnerContext) => preview('memory', args, context),
    previewIdentity: (args: unknown, context: SettingsOwnerContext) => preview('identity', args, context),
    updateMemory: (args: unknown, context: SettingsOwnerContext) => update('memory', args, context) as Promise<SettingsWriteResult<MemoryPreferenceValues, MemoryPreferenceChanges>>,
    updateIdentity: (args: unknown, context: SettingsOwnerContext) => update('identity', args, context) as Promise<SettingsWriteResult<IdentityPreferenceValues, IdentityPreferenceChanges>> }
}
/** Shipped own-Primary entrypoints retain their exact actor restriction. */
export function createOwnAgentSettingsExecutors(store: ConditionalSettingsStore) {
  const owner = createAdmittedAgentSettingsExecutors(store, requireOwnActor)
  return { ...owner,
    previewMemory: (args: unknown, context: SettingsOwnerContext) => owner.previewMemory(validateOwnUpdate(args, 'memory'), context),
    updateMemory: (args: unknown, context: SettingsOwnerContext) => owner.updateMemory(validateOwnUpdate(args, 'memory'), context) }
}
export { revision as settingsFamilyRevision }
