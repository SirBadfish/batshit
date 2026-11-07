import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'
import { createHmac } from 'node:crypto'
import { captureSettingsLifecycle, assertSettingsLifecycle, acquireSettingsMutation, type SettingsLifecycleSnapshot } from './appActions/settings/lifecycle'
/**
 * MCP Gateway Service
 *
 * Manages MCP gateway configurations with unified CRUD operations.
 * Supports multiple gateway types: docker-catalog, n8n-mcp-trigger, n8n-instance-mcp, custom
 *
 * ⚠️ CRITICAL REDIS 8 PATTERN WARNINGS:
 * - NEVER use JSON.stringify before redis.json.set
 * - NEVER use JSON.parse after redis.json.get
 * - RedisJSON handles serialization automatically
 * - Pass objects DIRECTLY to json.set
 * - Retrieved data is ALREADY parsed from json.get
 *
 * Risk Profile: DATA-001 (Critical) - Double stringification will corrupt data
 * Test Coverage: P0 tests verify no double stringification
 *
 * BL-1371: every registry write is a compare-and-set on the raw RedisJSON text
 * (`redis.json.getRaw` / `setIfUnchanged` / `delIfUnchanged`), so a write that lands between
 * another writer's read and its write is never overwritten. The value goes to Redis once, as the
 * JSON text `json.set` sends (raw `JSON.SET` inside the script), never stringified twice.
 */

import { redis } from '$lib/server/redis'
import { cloneIconRef, isIconRef } from '$lib/icons/iconTypes'
import type {
  MCPGateway,
  MCPGatewayRegistry,
  MCPGatewayStdioConfig,
  MCPToolGrouping
} from '$lib/types/database'
import { logger } from '$lib/utils/logger'
import { getBlockedBatshitServerGatewayReason, isBlockedBatshitServerGatewayUrl } from './mcpGatewayPolicy'
import {
  collectGatewayToolNames,
  sweepGatewayReferencesForUser
} from './mcpGatewayReferenceCleanup'
import {
  assertSavedInstalledStdioConfig, resolveInstalledStdioLaunch, assertInstalledStdioLaunchCurrent, type InstalledStdioLaunch, type ResolvedStdioGatewayProcessConfig,
  sanitizeStdioGatewayConfig,
  validateStdioGatewayConfig
} from './mcpGatewayStdio'
import {
  STDIO_RECORD_KEEPING_FIELDS,
  gatewayToolSettingsChanged,
  mcpToolListCache
} from './mcpToolListCache'
import { GatewayManagementWriteUnconfirmed, assertGatewayManagementDestination, assertGatewayManagementWriteContext, createGatewayManagementWriteContext, writeManagedGateway, joinMcpRawFences, type GatewayManagementWriteContext, type GatewayRawFence } from './appActions/mcp/gatewayWriteContext'
import { randomBytes } from 'node:crypto'
import { apiKeyService, normalizeApiKeyServiceName, INFRA_API_KEY_SERVICES } from '$lib/services/apiKey.server'
import { hasMcpSecretArgument, isMcpGatewayDisclosure, MCP_CONFIGURATION_STAGES, type McpGatewayDisclosure, type McpGatewaySaveReview } from '$lib/appActions/settings/mcpConfiguration'
import type { AdapterContext } from './appActions/managementTypes'
import type { McpSourceIdentityGuard } from './appActions/settings/conditionalAgentSettings'

/** What a Refresh or a Test learned about a STDIO gateway (its record keeping). */
export type StdioCheckResult = Pick<
  MCPGatewayStdioConfig,
  'lastTestStatus' | 'lastTestAt' | 'lastError' | 'toolCount'
>

/**
 * BL-550: a Refresh or a Test writes back what it learned, and nothing else, into the gateway as
 * it is when the check ENDS. The check takes seconds (a process start), and the user can save a
 * new argument meanwhile; writing the launch read before the check put the old one back.
 *
 * One step inside Redis: find the gateway by id, refuse when it is gone (`MISSING`) or is no
 * longer a STDIO gateway with a launch (`NOT_STDIO`), then set each named field at its own path
 * under `stdioConfig`. Nothing else in the registry is read into the write.
 *
 * KEYS[1] the user's registry; ARGV[1] the gateway id; then pairs of field name and its value as
 * JSON text.
 */
export const RECORD_STDIO_CHECK_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'MISSING' end
local count = redis.call('JSON.ARRLEN', KEYS[1], '$.gateways')[1]
if type(count) ~= 'number' then return 'MISSING' end
local index = nil
for position = 0, count - 1 do
  local ids = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.gateways[' .. position .. '].id'))
  if ids[1] == ARGV[1] then
    index = position
    break
  end
end
if index == nil then return 'MISSING' end
local at = '$.gateways[' .. index .. ']'
local kind = cjson.decode(redis.call('JSON.GET', KEYS[1], at .. '.type'))[1]
if kind ~= 'stdio' or redis.call('JSON.TYPE', KEYS[1], at .. '.stdioConfig')[1] ~= 'object' then
  return 'NOT_STDIO'
end
for position = 2, #ARGV, 2 do
  redis.call('JSON.SET', KEYS[1], at .. '.stdioConfig.' .. ARGV[position], ARGV[position + 1])
end
return 'OK'
`

/** The text with each lone UTF-16 surrogate replaced by U+FFFD. */
function wellFormedText(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
}

/**
 * BL-550: the record keeping belongs to the check. A settings save that sends the STDIO launch
 * keeps what is stored at the moment of the write, whatever the sender's copy says, so a save
 * built before a Refresh answered cannot put the old result back.
 */
function keepStoredStdioRecordKeeping(
  incoming: MCPGatewayStdioConfig,
  stored: MCPGatewayStdioConfig | undefined
): MCPGatewayStdioConfig {
  const next: Record<string, unknown> = { ...incoming }
  const current: Record<string, unknown> = stored && typeof stored === 'object' ? { ...stored } : {}
  for (const field of STDIO_RECORD_KEEPING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(current, field)) {
      next[field] = current[field]
    } else {
      delete next[field]
    }
  }
  return next as unknown as MCPGatewayStdioConfig
}

/**
 * BL-1371: a registry write reads again and rebuilds from fresh objects at most this many times
 * (the first try and two more), with no wait between, then gives up. Each refused try proves that
 * another write was stored, so the tries always make progress.
 */
const REGISTRY_WRITE_TRIES = 3

/**
 * BL-1371: a registry write found the stored gateways changed by another write at every one of
 * its tries. Nothing of it was stored. The gateway routes answer 409.
 */
export class GatewayRegistryConflictError extends Error {
  constructor() {
    super(
      `The MCP gateways kept changing while this was being saved (${REGISTRY_WRITE_TRIES} tries), so nothing was saved. Try again.`
    )
    this.name = 'GatewayRegistryConflictError'
  }
}

/**
 * What `update` writes: the fields to change, or a SYNCHRONOUS function of the gateway as it is
 * stored at the try's compare-and-set that answers them (BL-1371). The function runs again on
 * every try, so it must only compute: no I/O, no `await`.
 */
export type GatewayUpdate =
  | Partial<MCPGateway>
  | ((stored: Readonly<MCPGateway>) => Partial<MCPGateway>)

declare const preparedGatewayBrand: unique symbol
/** Process-only identity. Clones/JSON cannot carry its saved normalization/source authority. */
export type PreparedGatewaySave = Readonly<{ readonly [preparedGatewayBrand]: true }>
type PreparedGatewayState = {
  userId: string; key: string; gatewayId: string; mode: 'create' | 'update'; path: string; raw: string
  serialized: string; gateway: MCPGateway; before: MCPGateway | null; review: McpGatewaySaveReview
  phase: 'prepared' | 'claimed'
  sourceEvidence?: { saved: 'saved' | 'not_requested'; raw?: string; gateway?: MCPGateway }
  httpAuthSource?: { keyName: string | null; reference?: { key: string; raw: string } }
  httpHeaders?: Readonly<Record<string, string>>
  stdioLaunch?: InstalledStdioLaunch
  stdioReferences?: readonly { name: string; key: string; raw: string }[]
  stdioResolved?: ResolvedStdioGatewayProcessConfig
}
/** Immutable original-A DATA; only originalTask membership can authorize use. */
export type OriginalMcpStdioSource = Readonly<{ userId: string; agentId: string; gatewayId: string; sourceRaw: string;
  actorIdentityRaw: string; gateway: MCPGateway; launch: InstalledStdioLaunch; lifecycle: SettingsLifecycleSnapshot;
  references: readonly Readonly<{ name: string; key: string; raw: string }>[] }>
function freezeMcpOriginalData<T>(value: T): T {
  const todo: Array<[unknown, number]> = [[value, 0]], seen = new Set<object>()
  while (todo.length) {
    const [next, depth] = todo.pop()!
    if (!next || typeof next !== 'object' || seen.has(next)) continue
    if (depth > 64 || seen.size >= 32768) throw new Error('The bounded original MCP source projection is unavailable.')
    seen.add(next)
    for (const child of Object.values(next)) todo.push([child, depth + 1])
    Object.freeze(next)
  }
  return value
}
export type McpPreparedSourceEvidence = Readonly<{ userId: string; gatewayId: string; saved: 'saved' | 'not_requested'; raw: string; gateway: MCPGateway }>
export type McpPrerequisiteIssueCut = Readonly<{ gateway: MCPGateway | null; sourceRaw: string; sourceIdentity: McpSourceIdentityGuard;
  sourceFence?: GatewayRawFence; actor: Record<string, unknown>; actorIdentityRaw: string }>
/** Bounded private raw cut; no normalization, discovery, secret resolution or mutation. */
export const READ_MCP_GATEWAY_PLAN_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'', '', '-1'} end
local counts = redis.call('JSON.ARRLEN', KEYS[1], '$.gateways')
if type(counts[1]) ~= 'number' or counts[1] > 256 then return redis.error_reply('MCP_SOURCE_CAPACITY') end
local raw = redis.call('JSON.GET', KEYS[1], '$')
if #raw > 1048576 then return redis.error_reply('MCP_SOURCE_BYTES') end
if ARGV[1] == '' then return {raw, '', '-1'} end
for position = 0, counts[1] - 1 do
  local at = '$.gateways[' .. position .. ']'
  local lengths = redis.call('JSON.STRLEN', KEYS[1], at .. '.id')
  if type(lengths[1]) ~= 'number' or lengths[1] > 128 then return redis.error_reply('MCP_SOURCE_ID') end
  local ids = cjson.decode(redis.call('JSON.GET', KEYS[1], at .. '.id'))
  if ids[1] == ARGV[1] then return {raw, redis.call('JSON.GET', KEYS[1], at), tostring(position)} end
end
return {raw, '', '-1'}
`
/** Only fixed nonsecret metadata is read into reports. Secret/configuration subtrees are never fetched. */
export const READ_MCP_GATEWAY_SOURCES_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return '[]' end
local counts = redis.call('JSON.ARRLEN', KEYS[1], '$.gateways')
if type(counts[1]) ~= 'number' or counts[1] > 256 then return redis.error_reply('MCP_SOURCE_CAPACITY') end
local rows = {}
for position = 0, counts[1] - 1 do
  local at = '$.gateways[' .. position .. ']'
  local row = {}
  for _, field in ipairs({'id', 'slug', 'name', 'type', 'created_at'}) do
    local lengths = redis.call('JSON.STRLEN', KEYS[1], at .. '.' .. field)
    if type(lengths[1]) ~= 'number' or lengths[1] > 200 then return redis.error_reply('MCP_SOURCE_METADATA') end
    row[field] = cjson.decode(redis.call('JSON.GET', KEYS[1], at .. '.' .. field))[1]
  end
  if redis.call('JSON.TYPE', KEYS[1], at .. '.enabled')[1] ~= 'boolean' then return redis.error_reply('MCP_SOURCE_METADATA') end
  row.enabled = cjson.decode(redis.call('JSON.GET', KEYS[1], at .. '.enabled'))[1]
  table.insert(rows, row)
end
local encoded = cjson.encode(rows)
if counts[1] == 0 then return '[]' end
if #encoded > 262144 then return redis.error_reply('MCP_SOURCE_BYTES') end
return encoded
`
/** Fixed read-only original-API issue cut. No paths, write authority or ready flag
 * come from a request. Each JSONPath keeps absent [] distinct from present null. */
export const READ_MCP_HTTP_ISSUE_CUT_SCRIPT = `
local count = redis.call('EXISTS', KEYS[1])
if count == 0 then return redis.error_reply('MCP_SOURCE_MISSING') end
local sizes = redis.call('JSON.ARRLEN', KEYS[1], '$.gateways')
if type(sizes[1]) ~= 'number' or sizes[1] > 256 then return redis.error_reply('MCP_SOURCE_CAPACITY') end
local registry = redis.call('JSON.GET', KEYS[1], '$')
if #registry > 1048576 then return redis.error_reply('MCP_SOURCE_BYTES') end
local at = nil
for position = 0, sizes[1] - 1 do
  local ids = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.gateways[' .. position .. '].id'))
  if ids[1] == ARGV[1] then
    if at ~= nil then return redis.error_reply('MCP_SOURCE_DUPLICATE') end
    at = '$.gateways[' .. position .. ']'
  end
end
if at == nil then return redis.error_reply('MCP_SOURCE_MISSING') end
local result = {}
for _, field in ipairs({'id','slug','name','type','created_at','enabled','url','authKeyName','metadata.authToken','stdioConfig','toolGroupings','dcmDisplayDefaults'}) do
  local raw = redis.call('JSON.GET', KEYS[1], at .. '.' .. field)
  if #raw > 262144 then return redis.error_reply('MCP_SOURCE_BYTES') end
  table.insert(result, raw)
end
local keyRaw = redis.call('JSON.GET', KEYS[2], '$') or '[]'
if #keyRaw > 16384 then return redis.error_reply('MCP_KEY_REFERENCE_BYTES') end
table.insert(result, keyRaw)
for _, field in ipairs({'id','user_id','agentType','created_at','dcmDisplaySettings','dcm_display_settings'}) do
  local raw = redis.call('JSON.GET', KEYS[3], '$.' .. field) or '[]'
  if #raw > 262144 then return redis.error_reply('MCP_ACTOR_BYTES') end
  table.insert(result, raw)
end
return result
`
export type McpHttpIssueCut = Readonly<{ gateway: Record<string, unknown>; actor: Record<string, unknown>; sourceRaw: string; actorIdentityRaw: string; keyRaw: string }>

/** Fixed read-only setup/removal cut. All fences are retained SERVER facts; no
 * posted path/value or remote response can create authority. Redis TIME is read
 * in this SAME observation. The synchronous caller owns the final issue cut. */
export const READ_MCP_PREREQUISITE_CUT_SCRIPT = `
local checks = cjson.decode(ARGV[2])
for index, paths in ipairs(checks) do
  for _, entry in ipairs(paths) do
    if (redis.call('JSON.GET', KEYS[index + 2], entry[1]) or '') ~= entry[2] then return {'REFUSED'} end
  end
end
local now = redis.call('TIME')
if tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) >= tonumber(ARGV[3]) then return {'REFUSED'} end
local at = nil
if redis.call('EXISTS', KEYS[1]) ~= 0 then
  local size = redis.call('JSON.ARRLEN', KEYS[1], '$.gateways')
  if type(size[1]) ~= 'number' or size[1] > 256 then return {'REFUSED'} end
  for position = 0, size[1] - 1 do
    local ids = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.gateways[' .. position .. '].id'))
    if ids[1] == ARGV[1] then
      if at ~= nil then return {'REFUSED'} end
      at = position
    end
  end
end
local raw = ''
if at ~= nil then raw = redis.call('JSON.GET', KEYS[1], '$.gateways[' .. at .. ']') end
if #raw > 1048576 then return {'REFUSED'} end
local out = {'OK', raw, at == nil and '-1' or tostring(at)}
for _, field in ipairs({'id','user_id','agentType','created_at','dcmDisplaySettings','dcm_display_settings'}) do
  local value = redis.call('JSON.GET', KEYS[2], '$.' .. field) or ''
  if #value > 262144 then return {'REFUSED'} end
  out[#out + 1] = value
end
return out
`

export type GatewayManagementSource = Readonly<{ id: string; slug: string; name: string; type: string; enabled: boolean; created_at: string }>

/** The JSONPath of one gateway in the registry. */
function gatewayPath(index: number): string {
  return `$.gateways[${index}]`
}

/** The registry from `JSON.GET key $` (a one-entry array), or null for a missing key. */
function parseRegistryText(raw: string | null): MCPGatewayRegistry | null {
  if (raw === null) return null
  const matches = JSON.parse(raw)
  if (!Array.isArray(matches) || matches.length !== 1) {
    throw new Error('The MCP gateway registry read answered an unexpected shape.')
  }
  return matches[0] as MCPGatewayRegistry
}

export class MCPGatewayService {
  /** Private finite source/reference/DCM observation, immediately before actual
   * HTTP issue. This read is not a management grant or an atomic remote transaction. */
  async readMcpHttpIssueCut(userId: string, agentId: string, gatewayId: string, savedReference: string): Promise<McpHttpIssueCut> {
    for (const id of [userId, agentId, gatewayId]) {
      if (!id || !id.isWellFormed() || Buffer.byteLength(id, 'utf8') > 128) throw new Error('The actual MCP issue identity is unavailable.')
    }
    const reference = normalizeApiKeyServiceName(savedReference)
    if (!reference || !reference.isWellFormed() || Buffer.byteLength(reference, 'utf8') > 128 || INFRA_API_KEY_SERVICES.has(reference)) throw new Error('The held saved-key reference is unavailable.')
    const answer: unknown = await redis.execute(client => client.eval(READ_MCP_HTTP_ISSUE_CUT_SCRIPT, {
      keys: [`mcp_gateways:${userId}`, apiKeyService.storedKeyName(reference, userId), `agent:${agentId}`], arguments: [gatewayId]
    }))
    if (!Array.isArray(answer) || answer.length !== 19 || answer.some(raw => typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 262144) || Buffer.byteLength(answer[12], 'utf8') > 16384) throw new Error('The actual MCP issue cut is unavailable.')
    const read = (raw: string): unknown[] => {
      const values: unknown = JSON.parse(raw)
      if (!Array.isArray(values) || values.length > 1) throw new Error('The actual MCP issue cut is unreadable.')
      return values
    }
    const gateway: Record<string, unknown> = {}, actor: Record<string, unknown> = {}
    const fields = ['id','slug','name','type','created_at','enabled','url','authKeyName','metadata.authToken','stdioConfig','toolGroupings','dcmDisplayDefaults']
    fields.forEach((field, index) => {
      const values = read(answer[index])
      if (!values.length) return
      if (field === 'metadata.authToken') gateway.metadata = { authToken: values[0] }
      else gateway[field] = values[0]
    })
    ;['id','user_id','agentType','created_at','dcmDisplaySettings','dcm_display_settings'].forEach((field, index) => {
      const values = read(answer[index + 13]); if (values.length) actor[field] = values[0]
    })
    if (gateway.id !== gatewayId || gateway.type !== 'custom' || typeof gateway.enabled !== 'boolean' || typeof gateway.url !== 'string' || typeof gateway.authKeyName !== 'string' ||
        actor.id !== agentId || actor.user_id !== userId || actor.agentType !== 'api') throw new Error('The actual MCP source or API actor is unavailable.')
    // The remaining concrete cohort and source/reference equality live in the
    // actual private client owner. No normalizing registry get or write is used.
    return { gateway, actor, sourceRaw: JSON.stringify(answer.slice(0, 11)), actorIdentityRaw: JSON.stringify(answer.slice(13, 17)), keyRaw: answer[12] }
  }
  private readonly preparedManagementSaves = new WeakMap<PreparedGatewaySave, PreparedGatewayState>()
  private readonly VALID_GROUP_MODES = new Set([
    'group+tools+hints',
    'group+tools+names',
    'group-only',
    'hidden'
  ])

  private readonly VALID_TOOL_MODES = new Set([
    'inherit',
    'name+hint',
    'name-only',
    'hidden'
  ])

  private mapLegacyGroupMode(value: unknown): string | null {
    if (typeof value !== 'string') return null
    if (value === 'group+tools') return 'group+tools+hints'
    if (this.VALID_GROUP_MODES.has(value)) return value
    return null
  }

  private mapLegacyToolMode(value: unknown): string | null {
    if (typeof value !== 'string') return null
    if (value === 'group+tools') return 'name+hint'
    if (this.VALID_TOOL_MODES.has(value)) return value
    return null
  }

  private sanitizeToolGroupings(input: unknown): MCPGateway['toolGroupings'] {
    if (!Array.isArray(input)) return undefined

    const normalized = input
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null
        const raw = entry as Record<string, unknown>
        const rawName = raw.mcpName
        const name = typeof rawName === 'string' ? rawName.trim() : ''
        if (!name) return null

        const rawToolIds = raw.toolIds
        const toolIds = Array.isArray(rawToolIds)
          ? Array.from(
              new Set(
                rawToolIds
                  .map((toolId) => (typeof toolId === 'string' ? toolId.trim() : ''))
                  .filter((toolId) => toolId.length > 0)
              )
            )
          : []

        const grouping: MCPToolGrouping = {
          mcpName: name,
          toolIds
        }

        const rawIconRef = Object.prototype.hasOwnProperty.call(raw, 'icon_ref')
          ? raw.icon_ref
          : raw.iconRef
        if (rawIconRef !== undefined) {
          if (rawIconRef === null) {
            grouping.icon_ref = null
          } else if (isIconRef(rawIconRef)) {
            grouping.icon_ref = cloneIconRef(rawIconRef)
          } else {
            throw new Error('toolGroupings.icon_ref must be a valid icon picker reference')
          }
        }

        return grouping
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))

    return normalized.length > 0 ? normalized : []
  }

  private sanitizeDcmDisplayDefaults(input: unknown): MCPGateway['dcmDisplayDefaults'] {
    if (!input || typeof input !== 'object') return undefined

    const raw = input as Record<string, unknown>
    const groupsRaw = raw.groups
    const toolsRaw = raw.tools

    const groups: Record<string, any> = {}
    if (groupsRaw && typeof groupsRaw === 'object') {
      for (const [key, value] of Object.entries(groupsRaw)) {
        const mapped = this.mapLegacyGroupMode(value)
        if (mapped && typeof key === 'string' && key.trim().length > 0) {
          groups[key] = mapped
        }
      }
    }

    const tools: Record<string, any> = {}
    if (toolsRaw && typeof toolsRaw === 'object') {
      for (const [key, value] of Object.entries(toolsRaw)) {
        const mapped = this.mapLegacyToolMode(value)
        if (mapped && typeof key === 'string' && key.trim().length > 0) {
          tools[key] = mapped
        }
      }
    }

    return {
      version: 1,
      groups,
      tools
    }
  }

  private sanitizeIconRef(input: unknown): MCPGateway['icon_ref'] {
    if (input === undefined) return undefined
    if (input === null) return null
    if (!isIconRef(input)) {
      throw new Error('icon_ref must be a valid icon picker reference')
    }
    return cloneIconRef(input)
  }

  private normalizeGatewayForStorage<T extends Partial<MCPGateway>>(gateway: T): T {
    const normalized = { ...gateway }
    if ('icon_ref' in normalized) {
      normalized.icon_ref = this.sanitizeIconRef(normalized.icon_ref)
    }
    if ('toolGroupings' in normalized) {
      normalized.toolGroupings = this.sanitizeToolGroupings(normalized.toolGroupings)
    }
    if ('dcmDisplayDefaults' in normalized) {
      normalized.dcmDisplayDefaults = this.sanitizeDcmDisplayDefaults(
        normalized.dcmDisplayDefaults
      )
    }
    if ('stdioConfig' in normalized) {
      normalized.stdioConfig = sanitizeStdioGatewayConfig(normalized.stdioConfig)
    }
    return normalized
  }

  private slugify(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '')
  }

  private assignSlug(gateway: MCPGateway, existing: MCPGateway[]) {
    if (gateway.slug?.trim()) {
      return gateway
    }
    const existingSlugs = new Set(
      existing
        .map((entry) => entry.slug)
        .filter((slug): slug is string => typeof slug === 'string' && slug.trim().length > 0)
        .map((slug) => slug.trim())
    )

    const baseName = gateway.name?.trim() || gateway.id || 'gateway'
    const baseSlug = this.slugify(baseName) || 'gateway'
    let attempt = baseSlug
    let counter = 1
    // The slug is Batshit's hidden id for the gateway (the name the user typed is kept as typed).
    // BL-271's skip of the CLI Subagent bridge's server names went in SA-139 P7: the managed CLI
    // profiles those names lived in were removed in R5.
    while (existingSlugs.has(attempt)) {
      attempt = `${baseSlug}_${counter++}`
    }
    gateway.slug = attempt
    existingSlugs.add(attempt)
    return gateway
  }

  /**
   * Brings a registry read up to the stored shape (groupings, display defaults, slugs), in place.
   * Answers null when nothing changed, else the warnings to log once the write is stored. Only
   * computes: `list` writes the result with a compare-and-set (BL-1371).
   */
  private normalizeRegistry(registry: MCPGatewayRegistry): string[] | null {
    const warnings: string[] = []
    let needsSave = false
    for (const gateway of registry.gateways) {
      const normalizedGroupings = this.sanitizeToolGroupings(gateway.toolGroupings)
      const existingGroupings = gateway.toolGroupings
      if (JSON.stringify(existingGroupings ?? null) !== JSON.stringify(normalizedGroupings ?? null)) {
        gateway.toolGroupings = normalizedGroupings
        needsSave = true
      }
      const normalizedDcmDefaults = this.sanitizeDcmDisplayDefaults(gateway.dcmDisplayDefaults)
      if (
        JSON.stringify(gateway.dcmDisplayDefaults ?? null) !==
        JSON.stringify(normalizedDcmDefaults ?? null)
      ) {
        gateway.dcmDisplayDefaults = normalizedDcmDefaults
        needsSave = true
      }
      if (!gateway.slug) {
        this.assignSlug(gateway, registry.gateways)
        needsSave = true
      }
    }
    return needsSave ? warnings : null
  }

  /** The registry as stored now, with its raw text for a compare-and-set (BL-1371). */
  private async readRegistry(key: string): Promise<{ raw: string | null; registry: MCPGatewayRegistry | null }> {
    const raw = await redis.json.getRaw(key, '$')
    return { raw, registry: parseRegistryText(raw) }
  }

  /**
   * BL-1371: the gateway at `index` as stored now, with its raw text, or null when that element is
   * no longer this gateway (another write deleted it or shifted the list between the two reads):
   * the try is refused before anything is computed from a sibling.
   */
  private async readGatewayAt(
    key: string,
    index: number,
    gatewayId: string
  ): Promise<{ raw: string; gateway: MCPGateway } | null> {
    const raw = await redis.json.getRaw(key, gatewayPath(index))
    if (raw === null) return null
    const matches = JSON.parse(raw)
    if (!Array.isArray(matches) || matches.length > 1) {
      throw new Error('The MCP gateway read answered an unexpected shape.')
    }
    const gateway = matches[0]
    if (!gateway || typeof gateway !== 'object' || gateway.id !== gatewayId) return null
    return { raw, gateway: gateway as MCPGateway }
  }

  private assertValid(gateway: Partial<MCPGateway>) {
    const validation = this.validateGateway(gateway)
    if (!validation.valid) {
      throw new Error(validation.error)
    }
  }

  private buildCreatedGateway(gateway: MCPGateway, existing: MCPGateway[]): MCPGateway {
    const normalized = this.normalizeGatewayForStorage({ ...gateway })
    if (existing.some(row => row.id === normalized.id)) throw new Error(`Gateway with ID ${normalized.id} already exists`)
    return this.assignSlug(normalized, existing)
  }

  private buildUpdatedGateway(stored: MCPGateway, requested: Partial<MCPGateway>): MCPGateway {
    const updates = this.normalizeGatewayForStorage({ ...requested })
    delete updates.slug
    if (updates.stdioConfig) updates.stdioConfig = keepStoredStdioRecordKeeping(updates.stdioConfig, stored.stdioConfig)
    return { ...stored, ...updates, updated_at: new Date().toISOString() }
  }

  private managementDisclosure(gateway: MCPGateway): McpGatewayDisclosure {
    const source = gateway.metadata?.appActionsSource
    const launch = gateway.stdioConfig
    if (gateway.type === 'stdio' && Array.isArray(launch?.args) && launch.args.some(hasMcpSecretArgument)) {
      throw new Error('The exact nonsecret gateway disclosure is unavailable.')
    }
    const result = { id: gateway.id, slug: gateway.slug, name: gateway.name, type: gateway.type, enabled: gateway.enabled,
      ...(gateway.type === 'stdio' ? { stdio: { command: launch?.command, args: launch?.args ?? [],
        allowedLocations: source?.allowedLocations ?? [], cwdPolicy: launch?.cwdPolicy ?? 'none',
        ...(launch?.cwdValue ? { cwdValue: launch.cwdValue } : {}), envRefs: launch?.envRefs ?? [],
        startupTimeoutMs: launch?.startupTimeoutMs ?? 10_000, toolCallTimeoutMs: launch?.toolCallTimeoutMs ?? 60_000 } } :
        { url: gateway.url, ...(gateway.authKeyName ? { savedKeyRef: gateway.authKeyName } : {}) }),
      ...(gateway.type === 'docker-catalog' && gateway.metadata?.dockerProfile ? { dockerProfile: gateway.metadata.dockerProfile } : {}),
      ...(source?.evidence ? { evidence: source.evidence } : {}) }
    if (!isMcpGatewayDisclosure(result)) throw new Error('The exact nonsecret gateway disclosure is unavailable.')
    return result
  }

  async readManagementSources(userId: string): Promise<readonly GatewayManagementSource[]> {
    const answer = await redis.execute(client => client.eval(READ_MCP_GATEWAY_SOURCES_SCRIPT, { keys: [this.getKey(userId)], arguments: [] }))
    if (typeof answer !== 'string' || Buffer.byteLength(answer, 'utf8') > 262_144) throw new Error('MCP source metadata is unavailable.')
    const rows: unknown = JSON.parse(answer)
    if (!Array.isArray(rows) || rows.length > 256 || rows.some(row => !row || typeof row !== 'object' ||
      ['id', 'slug', 'name', 'type', 'created_at'].some(field => typeof row[field] !== 'string' || !row[field] || Buffer.byteLength(row[field], 'utf8') > (field === 'name' ? 200 : 128)) ||
      typeof row.enabled !== 'boolean') || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('MCP source metadata is unavailable.')
    return rows as GatewayManagementSource[]
  }

  private async managementRawCut(userId: string, gatewayId = '') {
    const answer = await redis.execute(client => client.eval(READ_MCP_GATEWAY_PLAN_SCRIPT, { keys: [this.getKey(userId)], arguments: [gatewayId] }))
    if (!Array.isArray(answer) || answer.length !== 3 || typeof answer[0] !== 'string' || typeof answer[1] !== 'string' || typeof answer[2] !== 'string' ||
      Buffer.byteLength(answer[0], 'utf8') > 1_048_576 || Buffer.byteLength(answer[1], 'utf8') > 1_048_576 || !/^-1$|^(?:0|[1-9][0-9]{0,2})$/.test(answer[2])) {
      throw new Error('The exact MCP source cut is unavailable.')
    }
    const raw = answer[0], targetRaw = answer[1], index = Number(answer[2])
    // Automatic preparation must not round/reorder an unreviewed stored source while
    // serializing its postimage. Refuse unsupported literal representations; ordinary
    // human CAS behavior remains with its existing owner. No raw source leaves this service.
    const compared = gatewayId ? targetRaw : raw
    if (compared && JSON.stringify(JSON.parse(compared)) !== compared) throw new Error('The MCP source literal representation is unavailable.')
    const registry = raw ? parseRegistryText(raw) : null
    if (registry && (!Array.isArray(registry.gateways) || registry.gateways.length > 256)) throw new Error('The MCP source capacity is unavailable.')
    if (gatewayId && (index < 0 || !targetRaw || registry?.gateways[index]?.id !== gatewayId)) throw new Error('The exact MCP gateway is unavailable.')
    const matches = targetRaw ? JSON.parse(targetRaw) : []
    if (gatewayId && (!Array.isArray(matches) || matches.length !== 1 || matches[0]?.id !== gatewayId)) throw new Error('The exact MCP gateway cut is unavailable.')
    return { raw, targetRaw, index, registry, gateway: gatewayId ? matches[0] as MCPGateway : null }
  }

  /** Same normalizers as ordinary create/update, run once before human review. No side effect. */
  async prepareGatewaySave(userId: string, input: { mode: 'create'; gateway: Omit<MCPGateway, 'id' | 'created_at' | 'updated_at'> } |
    { mode: 'update'; gatewayId: string; updates: GatewayUpdate }): Promise<{ plan: PreparedGatewaySave; review: McpGatewaySaveReview }> {
    const captured = input.mode === 'create' ? { ...input, gateway: structuredClone(input.gateway) } :
      { ...input, updates: typeof input.updates === 'function' ? input.updates : structuredClone(input.updates) }
    const cut = await this.managementRawCut(userId, captured.mode === 'update' ? captured.gatewayId : '')
    const key = this.getKey(userId), mode = captured.mode
    let gateway: MCPGateway, before: MCPGateway | null = null, value: MCPGateway | MCPGatewayRegistry, path: string, raw: string
    if (captured.mode === 'create') {
      if ((cut.registry?.gateways.length ?? 0) >= 256) throw new Error('MCP source capacity is full.')
      const timestamp = new Date().toISOString()
      const assigned = { ...captured.gateway, id: crypto.randomUUID(), created_at: timestamp, updated_at: timestamp }
      this.assertValid(assigned)
      const registry = cut.registry ?? { gateways: [] }
      gateway = this.buildCreatedGateway(assigned, registry.gateways)
      registry.gateways.push(gateway); value = registry; path = '$'; raw = cut.raw
    } else {
      before = cut.gateway!
      const requested = typeof captured.updates === 'function' ? this.runMerge(captured.updates, structuredClone(before)) : captured.updates
      this.assertValid(requested)
      gateway = this.buildUpdatedGateway(before, requested)
      if (gateway.id !== before.id || gateway.created_at !== before.created_at) throw new Error('A prepared update cannot replace gateway identity.')
      value = gateway; path = gatewayPath(cut.index); raw = cut.targetRaw
    }
    const review: McpGatewaySaveReview = { kind: 'mcp-configuration', planId: `mcpp_${randomBytes(16).toString('hex')}`, candidateId: `mcpc_${randomBytes(16).toString('hex')}`, mode,
      resource: { kind: 'mcp-gateway', gatewayId: gateway.id }, before: before ? this.managementDisclosure(before) : null,
      after: this.managementDisclosure(gateway), stages: [...MCP_CONFIGURATION_STAGES] }
    if (Buffer.byteLength(JSON.stringify(review), 'utf8') > 65_536) throw new Error('The complete MCP disclosure exceeds its budget.')
    const plan = Object.freeze({}) as PreparedGatewaySave
    this.preparedManagementSaves.set(plan, { userId, key, gatewayId: gateway.id, mode, path, raw, serialized: JSON.stringify(value),
      gateway: structuredClone(gateway), before: before ? structuredClone(before) : null, review: structuredClone(review), phase: 'prepared' })
    return { plan, review: structuredClone(review) }
  }

  private preparedGateway(plan: PreparedGatewaySave): PreparedGatewayState {
    const state = this.preparedManagementSaves.get(plan)
    if (!state) throw new Error('The original prepared gateway save is unavailable.')
    return state
  }

  async assertPreparedGatewayCurrent(plan: PreparedGatewaySave): Promise<void> {
    const state = this.preparedGateway(plan)
    const cut = await this.managementRawCut(state.userId, state.mode === 'update' ? state.gatewayId : '')
    if (state.raw !== (state.mode === 'create' ? cut.raw : cut.targetRaw) || state.mode === 'update' && state.path !== gatewayPath(cut.index)) {
      throw new Error('The approved MCP gateway source changed. Request a fresh plan.')
    }
  }

  /** Called only inside the genuine existing operation execution closure after consumed consent. */
  async commitPreparedGatewaySave(plan: PreparedGatewaySave, input: { adapter: AdapterContext; fences: readonly GatewayRawFence[]; beforeIssue(): void; onSaved(): void; onRefused?(): void; additionalLifecycle?: SettingsLifecycleSnapshot }): Promise<void> {
    const state = this.preparedGateway(plan)
    if (state.phase !== 'prepared' || input.adapter.admission.actor.userId !== state.userId) throw new Error('The original prepared gateway save cannot issue again.')
    input.adapter.assertCurrent()
    state.phase = 'claimed'
    const value = JSON.parse(state.serialized)
    if (state.mode === 'update') value.updated_at = new Date().toISOString()
    const context = createGatewayManagementWriteContext({ mode: state.mode, gatewayId: state.gatewayId, expectedRaw: state.raw,
      approvedPostimage: value, adapter: input.adapter, fences: input.fences, additionalLifecycle: input.additionalLifecycle, beforeIssue: input.beforeIssue,
      onSaved(raw) {
        // This is the SAME physical script's ACK, before any publication/read.
        state.sourceEvidence = { saved: 'saved' }
        if (raw) {
          try {
            const parsed: unknown = JSON.parse(raw)
            if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] && typeof parsed[0] === 'object' &&
              parsed[0].id === state.gatewayId && parsed[0].created_at === state.gateway.created_at &&
              sameJsonValue(parsed[0], state.mode === 'create' ? value.gateways.find((row: MCPGateway) => row.id === state.gatewayId) : value)) {
              state.sourceEvidence = { saved: 'saved', raw, gateway: structuredClone(parsed[0]) }
            }
          } catch { /* known write remains known; no usable setup evidence */ }
        }
        try { input.onSaved() }
        finally { if (state.mode === 'create' || gatewayToolSettingsChanged(state.before!, state.gateway)) mcpToolListCache.clearGateway(state.userId, state.gatewayId) }
      } })
    try {
      await redis.execute(client => writeManagedGateway(client, context, { mode: state.mode, gatewayId: state.gatewayId, key: state.key,
        path: state.path, raw: state.raw, value }))
    } catch (error) {
      // This actual writer wraps every unknown issued command and known-save
      // observer failure. Everything else is proven before issue/known refusal.
      if (!(error instanceof GatewayManagementWriteUnconfirmed)) {
        try { input.onRefused?.() } catch { /* retain the original failure identity */ }
      }
      throw error
    }
  }

  /** Group only equal facts; conflicts/capacity refuse rather than dropping an owner. */
  joinMcpPrerequisiteFences(...groups: readonly (readonly GatewayRawFence[])[]): GatewayRawFence[] {
    return joinMcpRawFences(...groups)
  }

  async captureOriginalMcpStdioSource(userId: string, agentId: string, gatewayId: string, deadlineAt: number): Promise<OriginalMcpStdioSource | undefined> {
    const lifecycle = captureSettingsLifecycle([this.getKey(userId), `agent:${agentId}`])
    const before = await this.readMcpPrerequisiteIssueCut(userId, agentId, gatewayId, deadlineAt, [])
    assertSettingsLifecycle(lifecycle)
    if (before.gateway?.type !== 'stdio') return undefined
    const gateway = before.gateway
    if (!gateway.enabled) throw new Error('Original STDIO A is disabled.')
    this.managementDisclosure(gateway) // SAME known nonsecret argv/disclosure guard as C; no original snapshot on refusal
    assertSavedInstalledStdioConfig(gateway)
    const launch = await resolveInstalledStdioLaunch(gateway)
    assertSettingsLifecycle(lifecycle)
    const names = [...new Set((gateway.stdioConfig?.envRefs ?? []).map(row => row.savedKeyRef))]
    const keyLife = captureSettingsLifecycle(names.map(name => apiKeyService.storedKeyName(name, userId)))
    const references: Array<{ name: string; key: string; raw: string }> = []
    for (const name of names) {
      const key = await apiKeyService.readReferenceState(name, userId)
      assertSettingsLifecycle(lifecycle); assertSettingsLifecycle(keyLife)
      if (!key.present || !key.shapeValid) throw new Error('An original STDIO A reference is unavailable.')
      references.push({ name, key: key.key, raw: key.raw })
    }
    const heldLife = { epoch: lifecycle.epoch, records: [...lifecycle.records, ...keyLife.records] }
    if (keyLife.epoch !== lifecycle.epoch) throw new Error('Original STDIO A lifecycle changed during capture.')
    const fences = references.map(ref => ({ key: ref.key, paths: [['$', ref.raw] as const] }))
    const final = await this.readMcpPrerequisiteIssueCut(userId, agentId, gatewayId, deadlineAt, fences)
    assertSettingsLifecycle(heldLife); assertInstalledStdioLaunchCurrent(launch)
    if (final.sourceRaw !== before.sourceRaw || final.actorIdentityRaw !== before.actorIdentityRaw) throw new Error('Original STDIO A changed during capture.')
    return freezeMcpOriginalData({ userId, agentId, gatewayId, sourceRaw: before.sourceRaw, actorIdentityRaw: before.actorIdentityRaw,
      gateway: structuredClone(gateway), launch, references, lifecycle: heldLife })
  }

  async readOriginalMcpStdioCut(source: OriginalMcpStdioSource, deadlineAt: number, extra: readonly GatewayRawFence[] = []) {
    assertSettingsLifecycle(source.lifecycle)
    // Only the locator is stable: expected raw/id/incarnation remain the frozen
    // original. Zero/multiple matches refuse the same one-row raw; no rebase.
    const sourceFence: GatewayRawFence = { key: this.getKey(source.userId),
      paths: [[`$.gateways[?(@.id==${JSON.stringify(source.gatewayId)})]`, source.sourceRaw]] }
    const fences = this.joinMcpPrerequisiteFences(source.references.map(ref => ({ key: ref.key, paths: [['$', ref.raw] as const] })), [sourceFence], extra)
    const cut = await this.readMcpPrerequisiteIssueCut(source.userId, source.agentId, source.gatewayId, deadlineAt, fences)
    assertSettingsLifecycle(source.lifecycle); assertInstalledStdioLaunchCurrent(source.launch)
    if (cut.sourceRaw !== source.sourceRaw || cut.actorIdentityRaw !== source.actorIdentityRaw || !cut.gateway?.enabled) throw new Error('The frozen original STDIO A source/actor changed.')
    return { cut: { ...cut, sourceFence }, fences }
  }

  /** No retained plaintext. The actual produced legacy config is compared, never repaired. */
  async matchOriginalMcpStdioLaunch(source: OriginalMcpStdioSource, produced: ResolvedStdioGatewayProcessConfig, deadlineAt: number): Promise<void> {
    return this.withOriginalMcpStdioLaunch(source, deadlineAt, async expected => {
      if (produced.command !== expected.command || JSON.stringify(produced.args) !== JSON.stringify(expected.args) || produced.cwd !== expected.cwd ||
        produced.startupTimeoutMs !== expected.startupTimeoutMs || produced.toolCallTimeoutMs !== expected.toolCallTimeoutMs ||
        JSON.stringify(Object.keys(produced.env).sort()) !== JSON.stringify(Object.keys(expected.env).sort()) ||
        Object.keys(expected.env).some(name => !Object.hasOwn(produced.env, name) || produced.env[name] !== expected.env[name])) throw new Error('The actual legacy STDIO A handoff differs from its frozen original.')
    })
  }
  /** Shared original raw/value closure for A and verified C. No value is retained. */
  private async withRetainedMcpStdioLaunch<T>(userId: string, gateway: MCPGateway, launch: InstalledStdioLaunch,
    refs: readonly Readonly<{ name: string; key: string; raw: string }>[], beforeUse: () => Promise<unknown>,
    use: (resolved: ResolvedStdioGatewayProcessConfig) => Promise<T>): Promise<T> {
    const env: Record<string, string> = Object.create(null)
    const acquire = async (index: number): Promise<T> => {
      if (index === refs.length) {
        await beforeUse(); assertInstalledStdioLaunchCurrent(launch)
        return use({ ...launch, args: [...launch.args], env })
      }
      const ref = refs[index]
      return apiKeyService.withConfiguredValue(ref.name, userId, async key => {
        if (key.state !== 'readable' || !key.value || key.value.includes('\0') || key.key !== ref.key || key.raw !== ref.raw) throw new Error('The original STDIO saved reference changed or is unreadable.')
        for (const entry of gateway.stdioConfig?.envRefs ?? []) if (entry.savedKeyRef === ref.name) env[entry.envVar] = key.value
        try { return await acquire(index + 1) } finally { for (const entry of gateway.stdioConfig?.envRefs ?? []) if (entry.savedKeyRef === ref.name) delete env[entry.envVar] }
      })
    }
    return acquire(0)
  }
  async withOriginalMcpStdioLaunch<T>(source: OriginalMcpStdioSource, deadlineAt: number, use: (resolved: ResolvedStdioGatewayProcessConfig) => Promise<T>): Promise<T> {
    return this.withRetainedMcpStdioLaunch(source.userId, source.gateway, source.launch, source.references,
      () => this.readOriginalMcpStdioCut(source, deadlineAt), use)
  }

  /** Pure first-cohort check on THIS actual normalized prepared source. */
  assertPreparedMcpHttpCohort(plan: PreparedGatewaySave): void {
    const state = this.preparedGateway(plan), gateway = state.gateway
    const url = new URL(gateway.url ?? '')
    if (gateway.type !== 'custom' || gateway.enabled !== true || gateway.stdioConfig != null ||
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      isBlockedBatshitServerGatewayUrl(url.href) || gateway.metadata && Object.hasOwn(gateway.metadata, 'authToken')) {
      throw new Error('This actual source is outside the custom HTTP prerequisite cohort.')
    }
    if (Object.hasOwn(gateway, 'authKeyName') && (typeof gateway.authKeyName !== 'string' ||
      !gateway.authKeyName || normalizeApiKeyServiceName(gateway.authKeyName) !== gateway.authKeyName || INFRA_API_KEY_SERVICES.has(gateway.authKeyName))) {
      throw new Error('The exact saved-key reference is unavailable.')
    }
  }

  /** The same saved-only transport plan; no new command or environment input. */
  assertPreparedMcpPrerequisiteCohort(plan: PreparedGatewaySave): void {
    const state = this.preparedGateway(plan)
    if (state.gateway.type !== 'stdio') return this.assertPreparedMcpHttpCohort(plan)
    assertSavedInstalledStdioConfig(state.gateway)
    if (state.mode !== 'update' || !state.before || !state.gateway.enabled || state.before.type !== 'stdio' || !sameJsonValue(state.before.stdioConfig, state.gateway.stdioConfig) ||
      !sameJsonValue({ ...state.review.before, enabled: true }, state.review.after)) throw new Error('Only the unchanged saved STDIO launch and disclosed enablement are available.')
  }

  async withPreparedMcpSourceAuth<T>(plan: PreparedGatewaySave, fences: readonly GatewayRawFence[], use: () => Promise<T>): Promise<T> {
    this.assertPreparedMcpPrerequisiteCohort(plan)
    const state = this.preparedGateway(plan)
    if (state.gateway.type !== 'stdio') return this.withPreparedMcpHttpAuth(plan, fences, use)
    if (state.stdioLaunch || state.stdioReferences) throw new Error('The original saved STDIO launch was already acquired.')
    const launch = await resolveInstalledStdioLaunch(state.gateway)
    const references: Array<{ name: string; key: string; raw: string }> = []
    const names = [...new Set((state.gateway.stdioConfig?.envRefs ?? []).map(row => row.savedKeyRef))]
    const env: Record<string, string> = Object.create(null)
    const acquire = async (index: number): Promise<T> => {
      if (index === names.length) {
        assertInstalledStdioLaunchCurrent(launch)
        state.stdioLaunch = launch; state.stdioReferences = Object.freeze(references)
        state.stdioResolved = { ...launch, args: [...launch.args], env }
        try { return await use() } finally { state.stdioResolved = undefined }
      }
      return apiKeyService.withConfiguredValue(names[index], state.userId, async key => {
        const expected = fences.find(row => row.key === key.key)
        if (key.state !== 'readable' || !key.value || key.value.includes('\0') || !expected || expected.paths.length !== 1 || expected.paths[0][0] !== '$' || expected.paths[0][1] !== key.raw) throw new Error('The exact required STDIO saved reference is unavailable.')
        references.push(Object.freeze({ name: names[index], key: key.key, raw: key.raw }))
        for (const entry of state.gateway.stdioConfig?.envRefs ?? []) if (entry.savedKeyRef === names[index]) env[entry.envVar] = key.value
        try { return await acquire(index + 1) } finally { for (const entry of state.gateway.stdioConfig?.envRefs ?? []) if (entry.savedKeyRef === names[index]) delete env[entry.envVar] }
      })
    }
    return acquire(0)
  }

  readPreparedMcpStdioLaunch(plan: PreparedGatewaySave): ResolvedStdioGatewayProcessConfig {
    const state = this.preparedGateway(plan)
    this.assertPreparedMcpPrerequisiteCohort(plan)
    if (!state.stdioLaunch || !state.stdioResolved) throw new Error('The actual saved STDIO value lifetime ended.')
    assertInstalledStdioLaunchCurrent(state.stdioLaunch)
    return { ...state.stdioResolved, args: [...state.stdioResolved.args], env: { ...state.stdioResolved.env } }
  }
  assertVerifiedMcpStdioFiles(plan: PreparedGatewaySave): void {
    const state = this.preparedGateway(plan)
    if (!state.stdioLaunch) throw new Error('The original installed STDIO launch is unavailable.')
    assertInstalledStdioLaunchCurrent(state.stdioLaunch)
  }
  /** Reopens only original encrypted references. Plaintext never enters the
   * retained plan/reference data, public result, review or cache key. */
  async withVerifiedMcpStdioLaunch<T>(plan: PreparedGatewaySave, use: (resolved: ResolvedStdioGatewayProcessConfig) => Promise<T>): Promise<T> {
    const state = this.preparedGateway(plan)
    this.readPreparedMcpSource(plan); this.assertPreparedMcpPrerequisiteCohort(plan)
    if (!state.stdioLaunch || !state.stdioReferences) throw new Error('The original verified STDIO source is unavailable.')
    return this.withRetainedMcpStdioLaunch(state.userId, state.gateway, state.stdioLaunch, state.stdioReferences,
      async () => { this.assertVerifiedMcpStdioFiles(plan) }, use)
  }

  /** Resolve the actual required value BEFORE source/connection/target effects.
   * Plaintext stays inside this private callback and the actual HTTP owner. */
  async withPreparedMcpHttpAuth<T>(plan: PreparedGatewaySave, fences: readonly GatewayRawFence[], use: () => Promise<T>): Promise<T> {
    this.assertPreparedMcpHttpCohort(plan)
    const state = this.preparedGateway(plan), name = state.gateway.authKeyName
    if (state.httpAuthSource || state.httpHeaders) throw new Error('The original setup authentication was already acquired.')
    if (name === undefined) {
      state.httpAuthSource = { keyName: null }; state.httpHeaders = Object.freeze({})
      try { return await use() } finally { state.httpHeaders = undefined }
    }
    return apiKeyService.withConfiguredValue(name, state.userId, async key => {
      const expected = fences.find(fence => fence.key === key.key)
      if (key.state !== 'readable' || !key.value || !expected || expected.paths.length !== 1 ||
        expected.paths[0][0] !== '$' || expected.paths[0][1] !== key.raw || /[\r\n]/.test(key.value)) {
        throw new Error('The exact required saved-key value is unavailable. No unauthenticated fallback was used.')
      }
      const authorization = `Bearer ${key.value}`
      if (new Headers({ Authorization: authorization }).get('authorization') !== authorization) throw new Error('The exact saved value cannot be used as the required HTTP header.')
      state.httpAuthSource = { keyName: name, reference: { key: key.key, raw: key.raw } }
      state.httpHeaders = Object.freeze({ Authorization: authorization })
      try { return await use() } finally { state.httpHeaders = undefined }
    })
  }

  assertPreparedMcpSourceReview(plan: PreparedGatewaySave, review: import('$lib/appActions/settings/mcpConfiguration').McpPrerequisiteReview): void {
    const state = this.preparedGateway(plan)
    if (review.resource.gatewayId !== state.gatewayId || review.candidateId !== state.review.candidateId ||
      review.planId !== state.review.planId || JSON.stringify(review.after) !== JSON.stringify(state.review.after) ||
      review.mode !== 'configure' || !state.sourceEvidence ||
      (review.sourceAction === 'save') !== (state.sourceEvidence.saved === 'saved')) throw new Error('The genuine retained source recipe changed.')
  }

  readPreparedMcpHttpAuth(plan: PreparedGatewaySave) {
    const state = this.preparedGateway(plan)
    this.assertPreparedMcpHttpCohort(plan)
    if (!state.httpAuthSource || !state.httpHeaders) throw new Error('The actual setup authentication lifetime ended.')
    return { headers: { ...state.httpHeaders }, reference: state.httpAuthSource.reference, keyName: state.httpAuthSource.keyName }
  }

  readPreparedMcpSource(plan: PreparedGatewaySave): McpPreparedSourceEvidence {
    const state = this.preparedGateway(plan), evidence = state.sourceEvidence
    if (!evidence?.raw || !evidence.gateway) throw new Error('The actual source ACK postimage is unavailable.')
    return Object.freeze({ userId: state.userId, gatewayId: state.gatewayId, saved: evidence.saved, raw: evidence.raw, gateway: structuredClone(evidence.gateway) })
  }

  /** Original consumed setup reference DATA only. Actual value use still joins
   * withConfiguredValue and the SAME encrypted raw at every physical issue. */
  readVerifiedMcpHttpReference(plan: PreparedGatewaySave) {
    const state = this.preparedGateway(plan)
    this.readPreparedMcpSource(plan); this.assertPreparedMcpHttpCohort(plan)
    if (!state.httpAuthSource) throw new Error('The original verified authentication source is unavailable.')
    return Object.freeze({ keyName: state.httpAuthSource.keyName, ...(state.httpAuthSource.reference ? { reference: Object.freeze({ ...state.httpAuthSource.reference }) } : {}) })
  }
  async withVerifiedMcpHttpAuth<T>(plan: PreparedGatewaySave, use: (auth: Readonly<{ headers: Record<string, string>; keyName: string | null; reference?: { key: string; raw: string } }>) => Promise<T>): Promise<T> {
    const state = this.preparedGateway(plan), held = this.readVerifiedMcpHttpReference(plan)
    if (held.keyName === null) return use({ ...held, headers: {} })
    return apiKeyService.withConfiguredValue(held.keyName, state.userId, async key => {
      if (key.state !== 'readable' || !key.value || key.key !== held.reference?.key || key.raw !== held.reference.raw || /[\r\n]/.test(key.value)) throw new Error('The original verified required saved-key source changed or is unreadable.')
      const authorization = `Bearer ${key.value}`
      if (new Headers({ Authorization: authorization }).get('authorization') !== authorization) throw new Error('The original verified HTTP header is unavailable.')
      return use({ ...held, headers: { Authorization: authorization } })
    })
  }

  /** No-op source plans never issue a dummy write or borrow a later get as ACK. */
  async retainUnchangedMcpSource(plan: PreparedGatewaySave, actorId: string, adapter: AdapterContext, fences: readonly GatewayRawFence[]): Promise<void> {
    const state = this.preparedGateway(plan)
    if (state.phase !== 'prepared' || state.mode !== 'update') throw new Error('The actual unchanged source plan is unavailable.')
    const cut = await this.readMcpPrerequisiteIssueCut(state.userId, actorId, state.gatewayId, adapter.deadlineAt, [adapter.admission.fence, ...fences])
    adapter.assertCurrent()
    if (cut.sourceRaw !== state.raw || !cut.gateway || cut.gateway.created_at !== state.gateway.created_at) throw new Error('The exact unchanged source changed before setup.')
    state.phase = 'claimed'
    state.sourceEvidence = { saved: 'not_requested', raw: cut.sourceRaw, gateway: structuredClone(cut.gateway) }
  }

  async readMcpPrerequisiteIssueCut(userId: string, agentId: string, gatewayId: string, deadlineAt: number, fences: readonly GatewayRawFence[]): Promise<McpPrerequisiteIssueCut> {
    const completeFences = this.joinMcpPrerequisiteFences(fences)
    if (![userId, agentId, gatewayId].every(id => id && id.isWellFormed() && Buffer.byteLength(id, 'utf8') <= 128) ||
      !Number.isFinite(deadlineAt) || completeFences.length > 16 || completeFences.some(fence => !fence.key || !fence.paths.length || fence.paths.length > 64)) throw new Error('The actual prerequisite cut is unavailable.')
    const answer: unknown = await redis.execute(client => client.eval(READ_MCP_PREREQUISITE_CUT_SCRIPT, {
      keys: [this.getKey(userId), `agent:${agentId}`, ...completeFences.map(fence => fence.key)],
      arguments: [gatewayId, JSON.stringify(completeFences.map(fence => fence.paths)), String(deadlineAt)]
    }))
    if (!Array.isArray(answer) || answer.length !== 9 || answer[0] !== 'OK' || answer.some(value => typeof value !== 'string') ||
      Buffer.byteLength(answer[1], 'utf8') > 1048576 || !/^-1$|^(?:0|[1-9][0-9]{0,2})$/.test(answer[2])) throw new Error('The exact prerequisite observation was refused.')
    const actor: Record<string, unknown> = {}
    const parse = (raw: string): unknown => {
      const values: unknown = raw ? JSON.parse(raw) : []
      if (!Array.isArray(values) || values.length > 1) throw new Error('The actual prerequisite observation is unreadable.')
      return values[0]
    }
    const gateway = parse(answer[1]) as MCPGateway | undefined
    ;['id','user_id','agentType','created_at','dcmDisplaySettings','dcm_display_settings'].forEach((field, index) => {
      if (Buffer.byteLength(answer[index + 3], 'utf8') > 262144) throw new Error('The actual prerequisite actor is unavailable.')
      const value = parse(answer[index + 3]); if (value !== undefined) actor[field] = value
    })
    if (actor.id !== agentId || actor.user_id !== userId || actor.agentType !== 'api' || typeof actor.created_at !== 'string' ||
      gateway && (gateway.id !== gatewayId || typeof gateway.created_at !== 'string')) throw new Error('The actual prerequisite identity changed.')
    return { gateway: gateway ?? null, sourceRaw: answer[1], sourceIdentity: { gatewayId, createdAt: gateway?.created_at ?? null },
      ...(gateway ? { sourceFence: { key: this.getKey(userId), paths: [[gatewayPath(Number(answer[2])), answer[1]]] } } : {}), actor,
      actorIdentityRaw: JSON.stringify(answer.slice(3, 7)) }
  }

  /** A merge function's answer, refused when it is not a plain synchronous result (BL-1371). */
  private runMerge(
    merge: (stored: Readonly<MCPGateway>) => Partial<MCPGateway>,
    stored: MCPGateway
  ): Partial<MCPGateway> {
    const answer = merge(stored) as unknown
    if (
      !answer ||
      typeof answer !== 'object' ||
      Array.isArray(answer) ||
      typeof (answer as { then?: unknown }).then === 'function'
    ) {
      throw new Error('A gateway update function must answer the fields to write, synchronously.')
    }
    return answer as Partial<MCPGateway>
  }

  /**
   * Get Redis key for user's gateway registry
   */
  private getKey(userId: string): string {
    return `mcp_gateways:${userId}`
  }

  /**
   * Validate gateway type
   */
  private isValidGatewayType(type: string): type is 'docker-catalog' | 'n8n-mcp-trigger' | 'n8n-instance-mcp' | 'custom' | 'stdio' | 'n8n-mcp-client' {
    return ['docker-catalog', 'n8n-mcp-trigger', 'n8n-instance-mcp', 'custom', 'stdio', 'n8n-mcp-client'].includes(type)
  }

  /**
   * Validate gateway URL format
   */
  private isValidUrl(url: string): boolean {
    try {
      const parsedUrl = new URL(url)
      // Only allow http and https schemes
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * Validate gateway data before operations
   */
  private validateGateway(gateway: Partial<MCPGateway>): { valid: boolean; error?: string } {
    if (gateway.type && !this.isValidGatewayType(gateway.type)) {
      return { valid: false, error: `Invalid gateway type: ${gateway.type}` }
    }

    const gatewayType = gateway.type

    if (gatewayType !== 'stdio' && gateway.url && !this.isValidUrl(gateway.url)) {
      return { valid: false, error: `Invalid gateway URL: ${gateway.url}` }
    }

    if (gatewayType !== 'stdio' && gateway.url && isBlockedBatshitServerGatewayUrl(gateway.url)) {
      return { valid: false, error: getBlockedBatshitServerGatewayReason() }
    }

    if (gateway.name && gateway.name.trim().length === 0) {
      return { valid: false, error: 'Gateway name cannot be empty' }
    }

    if (gatewayType === 'stdio' || gateway.stdioConfig !== undefined) {
      const validation = validateStdioGatewayConfig(sanitizeStdioGatewayConfig(gateway.stdioConfig))
      if (!validation.valid) {
        return validation
      }
    }

    return { valid: true }
  }

  /**
   * Create a new gateway.
   *
   * BL-1371: a compare-and-set on the whole registry (`$`, '' when there is none yet), because the
   * slug depends on every other gateway. Each try builds the gateway again from the caller's input,
   * so a slug picked by a refused try is never kept or answered.
   */
  async create(userId: string, gateway: Omit<MCPGateway, 'id'> | MCPGateway, management?: GatewayManagementWriteContext): Promise<MCPGateway> {
    this.assertValid(gateway)

    const key = this.getKey(userId)
    const id = 'id' in gateway && gateway.id ? gateway.id : crypto.randomUUID()
    if (management) assertGatewayManagementDestination(management, 'create', id, userId, key)

    for (let attempt = 0; attempt < REGISTRY_WRITE_TRIES; attempt += 1) {
      const { raw, registry: stored } = await this.readRegistry(key)
      if (management) assertGatewayManagementWriteContext(management, 'create', id, raw ?? '', key)
      const registry = stored ?? { gateways: [] }
      const newGateway = this.buildCreatedGateway({ ...gateway, id } as MCPGateway, registry.gateways)
      registry.gateways.push(newGateway)

      if (management) {
        await redis.execute(client => writeManagedGateway(client, management, { mode: 'create', gatewayId: id, key, path: '$', raw: raw ?? '', value: registry }))
      } else if (!(await redis.json.setIfUnchanged(key, '$', raw ?? '', registry))) continue

      // Saved tool lists are kept until the user changes the tool settings (mcpToolListCache.ts).
      mcpToolListCache.clearGateway(userId, id)
      return newGateway
    }
    throw new GatewayRegistryConflictError()
  }

  /**
   * Get all gateways for a user.
   *
   * A read that needs normalizing (a missing slug, an older grouping or display shape) writes the
   * normalized registry with a compare-and-set on `$` (BL-1371). When another write landed first it
   * reads and normalizes again; it answers only a registry it stored, or a read that needed no
   * write, never a copy whose write was refused (its slugs might never be stored).
   */
  async list(userId: string): Promise<MCPGateway[]> {
    const key = this.getKey(userId)

    for (let attempt = 0; attempt < REGISTRY_WRITE_TRIES; attempt += 1) {
      const { raw, registry } = await this.readRegistry(key)
      if (!registry) return []

      const warnings = this.normalizeRegistry(registry)
      if (warnings === null) return registry.gateways || []

      if (!(await redis.json.setIfUnchanged(key, '$', raw!, registry))) continue

      for (const warning of warnings) logger.warn(warning)
      return registry.gateways
    }
    throw new GatewayRegistryConflictError()
  }

  /**
   * Get a specific gateway by ID
   */
  async get(userId: string, gatewayId: string): Promise<MCPGateway | null> {
    const gateways = await this.list(userId)
    return gateways.find(g => g.id === gatewayId) || null
  }

  /**
   * Update an existing gateway.
   *
   * BL-1371: a compare-and-set on THIS gateway's raw text (`$.gateways[i]`), so a write to another
   * gateway never conflicts. Each try finds the gateway, reads its element again and checks the id
   * (a delete can shift the list between the two reads), builds the next copy from that stored
   * element (`updates` may be a synchronous function of it), and writes only while the element is
   * still that text. A gateway deleted meanwhile is "not found" and is never written again. Only the
   * stored try clears saved tool lists, and it is the copy answered (a function that answers no
   * fields writes nothing and answers the gateway as read).
   */
  async update(userId: string, gatewayId: string, updates: GatewayUpdate, management?: GatewayManagementWriteContext, human?: Readonly<{ expectedGatewaySource: string; onSaved?(ack: { gateway: MCPGateway; sourceRevision: string }): void }>): Promise<MCPGateway> {
    const humanLifecycle = human ? captureSettingsLifecycle([`mcp_gateways:${userId}`]) : undefined
    if (human) requireHumanGatewaySource(human.expectedGatewaySource)
    if (typeof updates !== 'function') this.assertValid(updates)

    const key = this.getKey(userId)
    if (management) assertGatewayManagementDestination(management, 'update', gatewayId, userId, key)

    for (let attempt = 0; attempt < REGISTRY_WRITE_TRIES; attempt += 1) {
      const { registry } = await this.readRegistry(key)
      if (!registry) {
        throw new Error('No gateways found for user')
      }

      const index = registry.gateways.findIndex((g: MCPGateway) => g.id === gatewayId)
      if (index === -1) {
        throw new Error(`Gateway with ID ${gatewayId} not found`)
      }

      const snapshot = await this.readGatewayAt(key, index, gatewayId)
      if (!snapshot) continue
      if (management) assertGatewayManagementWriteContext(management, 'update', gatewayId, snapshot.raw, key)
      const stored = snapshot.gateway
      if (human) { assertSettingsLifecycle(humanLifecycle!); assertHumanGatewaySource(userId, stored, human.expectedGatewaySource, humanLifecycle!) }

      let requested: Partial<MCPGateway>
      if (typeof updates === 'function') {
        // The function gets its own copy; `stored` stays the element as read.
        requested = this.runMerge(updates, JSON.parse(JSON.stringify(stored)))
        // Nothing to change for the gateway as stored (the token migration found another token):
        // no write, so nothing for a concurrent save to retry over. It answers the stored copy.
        if (Object.keys(requested).length === 0) return stored
        this.assertValid(requested)
      } else {
        requested = updates
      }

      const updatedGateway = this.buildUpdatedGateway(stored, requested)

      if (management) {
        await redis.execute(client => writeManagedGateway(client, management, { mode: 'update', gatewayId, key, path: gatewayPath(index), raw: snapshot.raw, value: updatedGateway }))
      } else if (human) {
        // SAME existing raw CAS, with the original human base retained on every retry.
        const path = gatewayPath(index)
        const lease = acquireSettingsMutation(humanLifecycle!)
        let issued = false, matched: boolean | undefined
        try {
          matched = await redis.json.setIfUnchanged(key, path, snapshot.raw, updatedGateway, { beforeIssue() {
            lease.check(); assertHumanGatewaySource(userId, stored, human.expectedGatewaySource, humanLifecycle!)
            issued = true
          } })
          if (matched) {
            // SAME actual CAS acknowledgement and its original lifecycle, before
            // cache/profile/token work or any later registry get can intervene.
            const sourceRevision = humanGatewaySourceRevision(userId, updatedGateway, humanLifecycle!)
            human.onSaved?.({ gateway: structuredClone(updatedGateway), sourceRevision })
          }
          lease.settle()
        } catch (error) {
          if (matched === true) { lease.settle(); throw new HumanGatewaySourceWriteUnconfirmed(true, error) }
          if (issued) { lease.unknown(); throw new HumanGatewaySourceWriteUnconfirmed(false, error) }
          lease.settle(); throw error
        }
        if (!matched) continue
      } else if (!(await redis.json.setIfUnchanged(key, gatewayPath(index), snapshot.raw, updatedGateway))) continue

      // Any edit but the record keeping a lookup or a Test writes back is the user changing the
      // tool settings, so the next send asks the tool server again (mcpToolListCache.ts).
      if (gatewayToolSettingsChanged(stored, updatedGateway)) {
        mcpToolListCache.clearGateway(userId, gatewayId)
      }
      return updatedGateway
    }
    throw new GatewayRegistryConflictError()
  }

  /**
   * Delete a gateway.
   *
   * BL-1371: a compare-and-set delete of THIS gateway's element, found and id-checked as in
   * `update`. The saved tool lists and the reference sweep follow only the stored delete, with the
   * tool names of the gateway as it was removed.
   *
   * SA-096 DL-8: a delete also sweeps every agent and subagent reference to the
   * gateway, so no record is left pointing at an ID that resolves to nothing.
   */
  async delete(userId: string, gatewayId: string): Promise<void> {
    const key = this.getKey(userId)

    for (let attempt = 0; attempt < REGISTRY_WRITE_TRIES; attempt += 1) {
      const { registry } = await this.readRegistry(key)
      if (!registry) {
        return // Nothing to delete
      }

      const index = registry.gateways.findIndex((g: MCPGateway) => g.id === gatewayId)
      if (index === -1) {
        throw new Error(`Gateway with ID ${gatewayId} not found`)
      }

      const snapshot = await this.readGatewayAt(key, index, gatewayId)
      if (!snapshot) continue
      if (!(await redis.json.delIfUnchanged(key, gatewayPath(index), snapshot.raw))) continue

      mcpToolListCache.clearGateway(userId, gatewayId)

      // Reference sweep runs after the registry write so it compares against the
      // post-delete live set. A sweep failure must not leave the caller believing
      // the gateway is still present.
      // BL-1396: every tool name of the gateway as it was removed is a candidate. The sweep keeps
      // a name that a gateway in the registry as it reads it still serves, and its compare-and-set
      // refuses a write when the registry changed. This try's earlier read must not decide: a
      // sibling deleted meanwhile is still in it, so two overlapping deletes of gateways that serve
      // the same tool would each keep that tool's selection.
      try {
        await sweepGatewayReferencesForUser({
          userId,
          orphanToolNames: collectGatewayToolNames(snapshot.gateway)
        })
      } catch (error) {
        logger.error(
          `[MCP Gateway] Deleted gateway ${gatewayId} but failed to sweep references:`,
          error
        )
      }
      return
    }
    throw new GatewayRegistryConflictError()
  }

  /**
   * Enable or disable a gateway
   */
  async setEnabled(userId: string, gatewayId: string, enabled: boolean): Promise<void> {
    await this.update(userId, gatewayId, { enabled })
  }

  /**
   * BL-550: write what a Refresh or a Test learned about a STDIO gateway (`RECORD_STDIO_CHECK_SCRIPT`).
   * Only the fields given are written, each at its own path, into the record as it is now; a
   * field left out keeps its stored value. Answers `NOT_STDIO` (nothing written) when the gateway
   * is no longer a STDIO gateway, and throws "not found" (like `update`) when it was deleted.
   * The saved tool lists stay: this is record keeping, not the user changing the tool settings.
   */
  async recordStdioCheckResult(
    userId: string,
    gatewayId: string,
    result: StdioCheckResult
  ): Promise<'OK' | 'NOT_STDIO'> {
    for (const field of Object.keys(result)) {
      if (!STDIO_RECORD_KEEPING_FIELDS.has(field)) {
        throw new Error(`${field} is not a STDIO check field`)
      }
    }
    // The error is stored as `sanitizeStdioGatewayConfig` stored it (trimmed; empty is none), with
    // any lone UTF-16 half replaced, because RedisJSON refuses the escape `JSON.stringify` writes
    // for one. It goes first: a refused value then stops the script before anything is written.
    const fields: Array<[string, unknown]> = []
    if (result.lastError !== undefined) {
      const lastError =
        typeof result.lastError === 'string' ? wellFormedText(result.lastError).trim() || null : null
      fields.push(['lastError', lastError])
    }
    for (const field of ['lastTestStatus', 'lastTestAt', 'toolCount'] as const) {
      if (result[field] !== undefined) fields.push([field, result[field]])
    }
    const fieldArguments = fields.flatMap(([field, value]) => [field, JSON.stringify(value)])

    const answer = await redis.execute((client) =>
      client.eval(RECORD_STDIO_CHECK_SCRIPT, {
        keys: [this.getKey(userId)],
        arguments: [gatewayId, ...fieldArguments]
      })
    )
    if (answer === 'OK' || answer === 'NOT_STDIO') return answer
    if (answer === 'MISSING') throw new Error(`Gateway with ID ${gatewayId} not found`)
    throw new Error(`The STDIO check result of gateway ${gatewayId} answered ${String(answer)}.`)
  }

  /**
   * Update discovered tools for a gateway
   */
  async updateDiscoveredTools(userId: string, gatewayId: string, tools: string[]): Promise<void> {
    await this.update(userId, gatewayId, {
      discoveredTools: tools,
      lastDiscovery: Date.now()
    })
  }

  /**
   * Get all enabled gateways for a user
   */
  async listEnabled(userId: string): Promise<MCPGateway[]> {
    const gateways = await this.list(userId)
    return gateways.filter(g => g.enabled)
  }

  /**
   * Get gateways by type
   */
  async listByType(
    userId: string,
    type: 'docker-catalog' | 'n8n-mcp-trigger' | 'n8n-instance-mcp' | 'custom' | 'stdio'
  ): Promise<MCPGateway[]> {
    const gateways = await this.list(userId)
    return gateways.filter(g => g.type === type)
  }

  /**
   * Check if a gateway exists
   */
  async exists(userId: string, gatewayId: string): Promise<boolean> {
    const gateway = await this.get(userId, gatewayId)
    return gateway !== null
  }
}

// Export singleton instance
export const mcpGatewayService = new MCPGatewayService()


// Request-only staleness data, never a policy/grant. HMAC avoids public digests of legacy secrets.
const humanSourceKey = randomBytes(32)
export const HUMAN_GATEWAY_SOURCE_FIELDS = ['name', 'description', 'type', 'url', 'enabled', 'authKeyName', 'stdioConfig', 'metadata'] as const
function sourceOrdered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sourceOrdered)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sourceOrdered(item)]))
  return value
}
function humanGatewaySource(gateway: MCPGateway) {
  const row = gateway as unknown as Record<string, unknown>
  const source = Object.fromEntries(['id', 'created_at', ...HUMAN_GATEWAY_SOURCE_FIELDS].map(field => [field, row[field]]))
  if (source.stdioConfig && typeof source.stdioConfig === 'object') source.stdioConfig = Object.fromEntries(Object.entries(source.stdioConfig).filter(([field]) => !['lastTestStatus', 'lastTestAt', 'lastError', 'toolCount'].includes(field)))
  if (source.metadata && typeof source.metadata === 'object') source.metadata = Object.fromEntries(Object.entries(source.metadata).filter(([field]) => !['runtimeManagedUrl', 'runtimeManagedProfile', 'storedUrl', 'runtimeManagedUrlReason', 'toolGrouping', 'lastCheckedAt', 'lastError', 'toolCount'].includes(field)))
  return sourceOrdered(source)
}
export function humanGatewaySourceRevision(userId: string, gateway: MCPGateway, lifecycle = captureSettingsLifecycle([`mcp_gateways:${userId}`])): string {
  assertSettingsLifecycle(lifecycle)
  return `source1:${createHmac('sha256', humanSourceKey).update(JSON.stringify({ userId, lifecycle, source: humanGatewaySource(gateway) })).digest('hex')}`
}
/** The real source CAS was issued; only its actual answer may make it saved.
 * The flag never certifies connect/verification/subject completion. */
export class HumanGatewaySourceWriteUnconfirmed extends Error {
  readonly status = 503; readonly code = 'gateway_source_save_unconfirmed'
  constructor(readonly gatewaySaved: boolean, cause: unknown) { super(gatewaySaved ? 'The gateway source was saved, but its acknowledgement follow-up is unconfirmed.' : 'The gateway source save was issued but its outcome is unconfirmed. Check saved source; do not repeat it automatically.', { cause }) }
}
export class HumanGatewaySourceRequiredError extends Error { readonly status = 400; readonly code = 'gateway_source_base_required'; constructor() { super('Read the saved gateway source before changing it. Nothing was saved.') } }
export class HumanGatewaySourceConflictError extends Error { readonly status = 409; readonly code = 'gateway_source_changed'; constructor() { super('The saved gateway source changed. Your draft is kept; deliberately read the saved source before another choice. Nothing was saved.') } }
export function namesHumanGatewaySource(body: Record<string, unknown>) { return HUMAN_GATEWAY_SOURCE_FIELDS.some(field => Object.hasOwn(body, field) && body[field] !== undefined) }
export function requireHumanGatewaySource(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^source1:[a-f0-9]{64}$/.test(value)) throw new HumanGatewaySourceRequiredError() }
export function assertHumanGatewaySource(userId: string, gateway: MCPGateway, expected: string, lifecycle: SettingsLifecycleSnapshot) {
  if (humanGatewaySourceRevision(userId, gateway, lifecycle) !== expected) throw new HumanGatewaySourceConflictError()
}
