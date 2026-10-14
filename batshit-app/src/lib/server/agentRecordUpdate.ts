import { normalizeUploadUrlsForStorageInPayload } from '$lib/server/services/batshitServerUrls'
import {
  AgentBlockShapeError,
  isAgentFieldByFieldBlock,
  planAgentBlockWrite,
  sameJsonValue,
  type AgentBlockStep,
  type AgentFieldByFieldBlock
} from '$lib/utils/agentBlockFieldSettings'
import { buildAgentMemoryRecordFields, resolveAgentMemorySettingsDraft } from '$lib/utils/memoryControl'
import { AGENT_MEMORY_STORED_FIELDS } from '$lib/utils/agentSettingsSavePatch'
import { NATIVE_TOOLS_SETTING_KEY } from '$lib/utils/agentProviderSettings'
import {
  LEGACY_PRIMARY_AGENT_FIELDS,
  PRIMARY_AGENT_TYPE_SOURCE_FIELDS,
  normalizePrimaryAgentType,
  type PrimaryAgentLike,
  type StoredPrimaryAgentType
} from '$lib/utils/primaryAgentType'

/**
 * BL-768: an agent record update is a list of by-path writes, run in one step inside Redis
 * (`UPDATE_AGENT_FIELDS_SCRIPT` in `redis.ts`; the default lane's twin runs the same arguments,
 * `test-utils/agentUpdateScriptTwin.ts`). `updateAgent` used to read the whole record, lay the
 * update over it, and write the whole record back, so two saves at the same moment (Agent Settings
 * and the chat bar's model picker, two tabs, a by-path writer such as `memoryRecall.ts`) took back
 * each other's fields with no word.
 *
 * The rules, the same as the old whole-record write for every field a caller passes:
 * - each passed top-level field is written at `$.<field>`; `undefined` is skipped;
 * - `null` on a field of `NULLABLE_AGENT_FIELDS` removes the field (any other field stores null),
 *   and a nullable field already stored as null is removed too;
 * - `agentType` (review of wave 2, item 1) is written only when the caller passes it or the type
 *   stored when the script runs is legacy or not canonical, and the SCRIPT decides that: a type
 *   worked out from an earlier read wrote an old type back over an API to CLI change made after
 *   the read. A worked-out type is written only while the stored type fields are still the ones it
 *   was worked out from (the script answers `TYPE_CHANGED` otherwise, before any write, and
 *   `updateAgent` tries again). The legacy type fields are always removed
 *   (`canonicalizePrimaryAgentRecord`'s rule);
 * - `provider_specific_settings` is written KEY BY KEY under `$.provider_specific_settings` (made an
 *   object first); a key passed as `null` is removed; a key not passed stays as stored. The whole
 *   block passed as `null` removes the block;
 * - its `nativeTools` (BL-841: the Work mode, the never-allow list, the command location, the web
 *   search choice) is written FIELD BY FIELD under `$.provider_specific_settings["nativeTools"]`
 *   (made an object first when a field is set); a field passed as `null` is removed, a field not
 *   passed stays, so a save of one field never writes back an older copy of the others;
 *   `nativeTools: null` removes the block, and one that is neither an object nor null is refused;
 * - `codex_settings` and `claude_settings` (BL-848) are written KEY BY KEY under `$.<field>`, and
 *   `dcmDisplaySettings` (BL-855) key by key with each ENTRY of its maps under
 *   `$.dcmDisplaySettings["<map>"]["<id>"]` (`planAgentBlockWrite`, `agentBlockFieldSettings.ts`
 *   owns the rules): the block, and a map, are made objects first only when something in them is
 *   set; a key or entry passed as `null` is removed, one not passed stays. The whole block passed
 *   as `null` is a whole write of `null`, and one that is neither an object nor null is refused.
 *   Every other field is written whole, a list such as `defaultMCPGateways` included;
 * - upload URLs are stored in their storage form; `updated_at` is stamped last.
 *
 * Everything is checked BEFORE the script (review item 2), because a Lua script does not roll back:
 * a command that fails halfway leaves the writes before it in place. `AgentUpdateRejectedError`
 * (a 400) names what to change.
 *
 * BL-914: the Subagent update shares the per-field rules above (`planRecordFieldOps`: the
 * `provider_specific_settings` and block writes, the checks, the storage form of upload URLs) and
 * the ops loop of the script; its plan is `planSubagentRecordUpdate` (`subagentRecordUpdate.ts`).
 */

export const AGENT_PROVIDER_SETTINGS_FIELD = 'provider_specific_settings'

/** Fields a `null` removes (the old whole-record write deleted them the same way). */
export const NULLABLE_AGENT_FIELDS: ReadonlySet<string> = new Set([
  'buffer_size',
  'buffer_size_image',
  // BL-1484: the parked permission's hidden key can be cleared with null; the retired
  // zip_control_mode and zip_agent_control_enabled are removed by the startup sweep instead.
  'zip_agent_control_experiment',
  'zip_ai_view_mode',
  'zip_tool_notes_enabled',
  'zip_threshold_error',
  'zip_threshold_image',
  'zip_threshold_subagent',
  'buffer_size_error',
  'buffer_size_subagent',
  'buffer_size_read_file',
  'zip_threshold_read_file',
  'buffer_size_write_file',
  'zip_threshold_write_file',
  'buffer_size_edit_file',
  'zip_threshold_edit_file',
  'buffer_size_execute_command',
  'zip_threshold_execute_command',
  'buffer_size_list_files',
  'zip_threshold_list_files',
  'buffer_size_all_other_tools',
  'zip_threshold_all_other_tools',
  'default_project_id',
  AGENT_PROVIDER_SETTINGS_FIELD,
  'primary_model_temperature',
  'primary_model_preset_id',
  'primary_model_max_tokens',
  'primary_model_top_p',
  'primary_model_top_k',
  'primary_model_frequency_penalty',
  'primary_model_presence_penalty',
  'primary_model_seed',
  'primary_model_stop_sequences',
  'primary_model_reasoning_effort',
  'tool_approval_mode',
  'voice_profile',
  'goon_id',
  'defaultTools'
])

/**
 * A top-level agent (or Subagent) field name: the record's own snake_case and camelCase names,
 * nothing else.
 */
export const AGENT_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The deepest a passed value may nest (containers inside containers). RedisJSON keeps a record at
 * most 128 levels deep, measured on Redis 8.10.1: a value at `$.<field>` may nest 126 levels and
 * one in `provider_specific_settings` 125; one level more is skipped with no error, and 128 is
 * refused halfway through the script. 64 leaves room and is far above any real setting.
 */
export const MAX_AGENT_VALUE_DEPTH = 64

/**
 * A save refused before anything was written; the message says what to change. `status` 400 is
 * what `PUT /api/agents/[id]` answers (its catch passes an error's `status` on).
 */
export class AgentUpdateRejectedError extends Error {
  readonly status = 400

  constructor(message: string) {
    super(message)
    this.name = 'AgentUpdateRejectedError'
  }
}

/**
 * A save whose type fields changed before each of its tries (`TYPE_CHANGED` from the script every
 * time): another save is changing the agent right now, not a server fault, so `status` is 409.
 * Nothing was written.
 */
export class AgentUpdateConflictError extends Error {
  readonly status = 409

  constructor(message: string) {
    super(message)
    this.name = 'AgentUpdateConflictError'
  }
}

/**
 * BL-1294: a save of the memory settings whose saved values are no longer the ones the save started
 * from (`expectedMemory`): the agent changed its own memory settings meanwhile (App Actions,
 * `conditionalAgentSettings.ts`), or another window saved them. Nothing was written. Agent Settings
 * reads the agent again, keeps the user's edits, and sends them once more.
 */
export class AgentMemorySettingsConflictError extends Error {
  readonly status = 409
  readonly code = 'memory_settings_changed'

  constructor() {
    super('The memory settings changed after Settings read them, so nothing was saved.')
    this.name = 'AgentMemorySettingsConflictError'
  }
}

/**
 * Every stored name of the memory settings, each a top-level field (`AGENT_MEMORY_STORED_FIELDS`:
 * the five the Settings save writes and the older camelCase names the resolvers still read). A save
 * that names any of them must carry `expectedMemory` (`PUT /api/agents/[id]`).
 */
export const AGENT_MEMORY_SOURCE_FIELDS: readonly string[] = AGENT_MEMORY_STORED_FIELDS

export const AGENT_MEMORY_SOURCE_PATHS: readonly string[] = AGENT_MEMORY_SOURCE_FIELDS.map((field) => `$.${field}`)

/** `redis.updateAgent`'s options. `expectedMemory`: the memory settings a save of them started from. */
export interface AgentUpdateOptions {
  expectedMemory?: Record<string, unknown>
}

/** Whether a save names a memory setting, by any of its stored names. */
export function namesAgentMemorySetting(updates: Record<string, unknown>): boolean {
  return AGENT_MEMORY_SOURCE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(updates, field))
}

/** The memory fields a memory read stands for: each path's `JSON.GET` answer, `[]` when missing. */
export function agentMemoryFieldsFromAnswers(answers: readonly string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  AGENT_MEMORY_SOURCE_FIELDS.forEach((field, index) => {
    const answer = JSON.parse(answers[index] ?? '[]') as unknown[]
    if (answer.length > 0) fields[field] = answer[0]
  })
  return fields
}

/**
 * Whether the stored memory settings still equal a save's base. Both sides go through the same
 * resolvers and the same writer as the Settings form (`resolveAgentMemorySettingsDraft`, then
 * `buildAgentMemoryRecordFields`), so an older camelCase name or an absent field compares by the
 * value it means, never by its text.
 */
export function agentMemoryBaseMatches(stored: unknown, expectedMemory: unknown): boolean {
  return sameJsonValue(
    buildAgentMemoryRecordFields(resolveAgentMemorySettingsDraft(stored)),
    buildAgentMemoryRecordFields(resolveAgentMemorySettingsDraft(expectedMemory))
  )
}

/**
 * `key` is a settings key under `field`; `subkey` a field of that key's block (`nativeTools`, BL-841)
 * or an entry of one of its maps (`dcmDisplaySettings`, BL-855).
 */
export type AgentRecordOp =
  | { op: 'ensureObject'; field: string; key?: string }
  | { op: 'set'; field: string; key?: string; subkey?: string; value: unknown }
  | { op: 'delete'; field: string; key?: string; subkey?: string }
  | { op: 'deleteIfNull'; field: string }

export type AgentTypeSourceFields = Partial<Record<(typeof PRIMARY_AGENT_TYPE_SOURCE_FIELDS)[number], unknown>>

/**
 * How the script treats `agentType`:
 * - `set`: the caller passed a canonical type; it is written as it is;
 * - `auto`: the caller passed no `agentType`; a canonical stored type stays, and only a legacy or
 *   non-canonical one is replaced by the type worked out from the stored fields with the passed
 *   type fields laid over them;
 * - `derive`: the caller passed a non-canonical `agentType` (null, a legacy word); the worked-out
 *   type is written.
 */
export type AgentTypeRule =
  | { mode: 'set'; value: StoredPrimaryAgentType }
  | { mode: 'auto' | 'derive'; passedSources: Record<string, unknown> }

export type AgentRecordPlan = { ops: AgentRecordOp[]; type: AgentTypeRule }

const CANONICAL_AGENT_TYPES: ReadonlySet<string> = new Set(['api', 'cli', 'n8n'])

/** The paths of the stored type fields, read before the script and compared inside it. */
export const AGENT_TYPE_SOURCE_PATHS: readonly string[] = PRIMARY_AGENT_TYPE_SOURCE_FIELDS.map((field) => `$.${field}`)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** The first thing in a value RedisJSON cannot store as it is: a broken character, or too deep. */
function findValueProblem(value: unknown, depth: number): 'broken' | 'depth' | null {
  if (typeof value === 'string') return value.isWellFormed() ? null : 'broken'
  if (!value || typeof value !== 'object') return null
  if (depth >= MAX_AGENT_VALUE_DEPTH) return 'depth'
  for (const [key, child] of Object.entries(value)) {
    if (!key.isWellFormed()) return 'broken'
    const problem = findValueProblem(child, depth + 1)
    if (problem) return problem
  }
  return null
}

function checkValue(name: string, value: unknown): void {
  const problem = findValueProblem(value, 0)
  if (problem === 'broken') {
    throw new AgentUpdateRejectedError(
      `The value of the setting ${JSON.stringify(name)} has a broken character in it (half of an emoji or other symbol), so nothing was saved. Retype that value and save again.`
    )
  }
  if (problem === 'depth') {
    throw new AgentUpdateRejectedError(
      `The value of the setting ${JSON.stringify(name)} is nested more than ${MAX_AGENT_VALUE_DEPTH} levels deep, so nothing was saved. Use a flatter value (for a Custom Parameter, less deeply nested JSON) and save again.`
    )
  }
}

function refuseBrokenSettingName(name: string, what: string): void {
  if (!name.isWellFormed()) {
    throw new AgentUpdateRejectedError(
      `The setting name ${JSON.stringify(name)} has a broken character in it (half of an emoji or other symbol), so nothing was saved. Retype that ${what} and save again.`
    )
  }
}

/**
 * BL-841: the by-path writes of a `nativeTools` a save sent: each named field at its own path,
 * `null` removing it; the block is made an object first only when a field is set.
 */
function planNativeToolsOps(field: string, value: unknown): AgentRecordOp[] {
  const key = NATIVE_TOOLS_SETTING_KEY
  if (value === null) return [{ op: 'delete', field, key }]
  if (!isPlainObject(value)) {
    throw new AgentUpdateRejectedError(
      `The setting ${JSON.stringify(key)} (the Bash and web search settings) must be an object or null, so nothing was saved.`
    )
  }
  const fieldOps: AgentRecordOp[] = []
  for (const [subkey, subValue] of Object.entries(value)) {
    refuseBrokenSettingName(subkey, 'setting name')
    if (subValue === undefined) continue
    if (subValue === null) {
      fieldOps.push({ op: 'delete', field, key, subkey })
      continue
    }
    checkValue(subkey, subValue)
    fieldOps.push({ op: 'set', field, key, subkey, value: normalizeUploadUrlsForStorageInPayload(subValue) })
  }
  return fieldOps.some((op) => op.op === 'set') ? [{ op: 'ensureObject', field, key }, ...fieldOps] : fieldOps
}

/**
 * BL-848, BL-855: the by-path writes of a `codex_settings`, `claude_settings` or `dcmDisplaySettings`
 * a save sent: the steps `planAgentBlockWrite` gives, each checked the way a settings key is (names
 * with a broken character, a value with one or nested too deep) before anything is written.
 */
function planFieldByFieldBlockOps(field: AgentFieldByFieldBlock, value: unknown): AgentRecordOp[] {
  let steps: AgentBlockStep[]
  try {
    const write = planAgentBlockWrite(field, value)
    if (write.kind === 'whole') return [{ op: 'set', field, value: write.value }]
    steps = write.steps
  } catch (error) {
    if (error instanceof AgentBlockShapeError) throw new AgentUpdateRejectedError(error.message)
    throw error
  }
  return steps.map((step): AgentRecordOp => {
    const [key, subkey] = step.path
    for (const name of step.path) refuseBrokenSettingName(name, 'setting name')
    const named = key === undefined ? { field } : subkey === undefined ? { field, key } : { field, key, subkey }
    if (step.step === 'ensure') return { op: 'ensureObject', ...named }
    if (step.step === 'delete') return { op: 'delete', ...named }
    checkValue(subkey ?? key, step.value)
    return { op: 'set', ...named, value: normalizeUploadUrlsForStorageInPayload(step.value) }
  })
}

/** Refuses a `provider_specific_settings` that is neither an object nor null (the PUT route asks first). */
export function assertAgentProviderSettingsBlock(value: unknown): void {
  if (value !== undefined && value !== null && !isPlainObject(value)) {
    throw new AgentUpdateRejectedError('provider_specific_settings must be an object or null')
  }
}

/**
 * BL-914: the by-path writes of ONE top-level field an update names, under the rules every
 * record update shares (the agent's, `planAgentRecordUpdate`, and the Subagent's,
 * `planSubagentRecordUpdate` in `subagentRecordUpdate.ts`); the caller skips `undefined` and
 * checks the field name:
 * - `provider_specific_settings` key by key (`nativeTools` field by field): a key passed as `null`
 *   is removed, a key not passed stays, the whole block passed as `null` removes the block, and a
 *   block that is neither an object nor null is refused;
 * - `codex_settings`, `claude_settings` and `dcmDisplaySettings` key by key (`planAgentBlockWrite`);
 * - any other field is written whole, and removed when it is passed as `null` and named in
 *   `removesOnNull` (every other field stores the null).
 * Throws `AgentUpdateRejectedError` before anything is written.
 */
export function planRecordFieldOps(field: string, value: unknown, removesOnNull: ReadonlySet<string>): AgentRecordOp[] {
  if (field === AGENT_PROVIDER_SETTINGS_FIELD) {
    if (value === null) return [{ op: 'delete', field }]
    assertAgentProviderSettingsBlock(value)
    const keyOps: AgentRecordOp[] = []
    for (const [key, keyValue] of Object.entries(value as Record<string, unknown>)) {
      refuseBrokenSettingName(key, 'Custom Parameter name')
      if (keyValue === undefined) continue
      if (key === NATIVE_TOOLS_SETTING_KEY) {
        keyOps.push(...planNativeToolsOps(field, keyValue))
        continue
      }
      if (keyValue === null) {
        keyOps.push({ op: 'delete', field, key })
        continue
      }
      checkValue(key, keyValue)
      keyOps.push({ op: 'set', field, key, value: normalizeUploadUrlsForStorageInPayload(keyValue) })
    }
    return keyOps.length > 0 ? [{ op: 'ensureObject', field }, ...keyOps] : []
  }

  if (isAgentFieldByFieldBlock(field)) return planFieldByFieldBlockOps(field, value)

  if (value === null && removesOnNull.has(field)) return [{ op: 'delete', field }]
  checkValue(field, value)
  return [{ op: 'set', field, value: normalizeUploadUrlsForStorageInPayload(value) }]
}

function planAgentTypeRule(updates: Record<string, unknown>, passedSources: Record<string, unknown>): AgentTypeRule {
  if (updates.agentType === undefined) return { mode: 'auto', passedSources }
  const named = typeof updates.agentType === 'string' ? updates.agentType.trim().toLowerCase() : ''
  return CANONICAL_AGENT_TYPES.has(named)
    ? { mode: 'set', value: named as StoredPrimaryAgentType }
    : { mode: 'derive', passedSources }
}

/**
 * The by-path writes of one agent update and its `agentType` rule; `now` is the stamp. Throws
 * `AgentUpdateRejectedError`, before anything is written, for a field name that is not an agent
 * field name, a `provider_specific_settings` that is neither an object nor null, a settings key or
 * value with a broken character (a lone half of a surrogate pair: RedisJSON refuses it halfway
 * through the script), or a value nested deeper than `MAX_AGENT_VALUE_DEPTH`.
 */
export function planAgentRecordUpdate({
  updates,
  now
}: {
  updates: Record<string, unknown>
  now: string
}): AgentRecordPlan {
  const ops: AgentRecordOp[] = []
  const passedSources: Record<string, unknown> = {}
  const legacy = new Set<string>(LEGACY_PRIMARY_AGENT_FIELDS)
  const typeSourceNames = new Set<string>(PRIMARY_AGENT_TYPE_SOURCE_FIELDS)

  for (const [field, value] of Object.entries(updates)) {
    if (!AGENT_FIELD_NAME.test(field)) throw new AgentUpdateRejectedError(`Not an agent field name: ${field}`)
    if (value === undefined) continue
    if (typeSourceNames.has(field)) passedSources[field] = value
    if (field === 'updated_at' || field === 'agentType' || legacy.has(field)) continue
    ops.push(...planRecordFieldOps(field, value, NULLABLE_AGENT_FIELDS))
  }

  for (const field of LEGACY_PRIMARY_AGENT_FIELDS) ops.push({ op: 'delete', field })
  for (const field of NULLABLE_AGENT_FIELDS) {
    if (!(field in updates)) ops.push({ op: 'deleteIfNull', field })
  }
  ops.push({ op: 'set', field: 'updated_at', value: now })
  return { ops, type: planAgentTypeRule(updates, passedSources) }
}

/** A quoted JSONPath member name: only backslashes and quotes are escaped (see `agentRecordOpPath`). */
function quotedPathName(name: string): string {
  return `["${name.replace(/[\\"]/g, (character) => `\\${character}`)}"]`
}

/**
 * The JSONPath of one op: `$.<field>`, `$.<field>["<key>"]` for a settings key (any key text), or
 * `$.<field>["<key>"]["<subkey>"]` for a field of that key's block (`nativeTools`, BL-841) or an
 * entry of one of its maps (`dcmDisplaySettings`, BL-855).
 * RedisJSON's quoted path names know two escapes, `\"` and `\\`, and take every other character
 * as it is, a control character included. Measured on Redis 8.10.1: `JSON.stringify`'s `\n`, `\t`,
 * `\uXXXX` are refused ("expected one of the following"), so only backslashes and quotes are escaped.
 */
export function agentRecordOpPath(op: { field: string; key?: string; subkey?: string }): string {
  if (op.key === undefined) return `$.${op.field}`
  const keyPath = `$.${op.field}${quotedPathName(op.key)}`
  return op.subkey === undefined ? keyPath : `${keyPath}${quotedPathName(op.subkey)}`
}

/**
 * The stored type fields in a type-field read: the raw answers of `JSON.GET <key> <path>` for each
 * of `AGENT_TYPE_SOURCE_PATHS`, in that order, joined by line breaks (RedisJSON's compact text has
 * none of its own). One `JSON.GET` of all the paths answers them in a random order, so its text
 * cannot be compared.
 */
export function parseAgentTypeSnapshot(snapshot: string): AgentTypeSourceFields {
  // Raw replies of raw commands, parsed once (what node-redis's `json.get` does to its reply); the
  // same text goes to the script, which compares it with a fresh read.
  const answers = snapshot.split('\n').map((answer) => JSON.parse(answer) as unknown[])
  return Object.fromEntries(PRIMARY_AGENT_TYPE_SOURCE_FIELDS.map((field, index) => [field, answers[index]?.[0]]))
}

/**
 * `UPDATE_AGENT_FIELDS_SCRIPT`'s arguments: the ops, the type rule's mode, the type to write as JSON
 * (the passed one, or the one worked out from `snapshot`, the type-field read
 * (`parseAgentTypeSnapshot`), with the passed type fields laid over it), `snapshot` itself, the
 * memory guard, then `AGENT_TYPE_SOURCE_PATHS`.
 *
 * The memory guard (BL-1294) is `''` for a save that names no memory setting. Otherwise it is JSON
 * `{ paths, snapshot }`: `AGENT_MEMORY_SOURCE_PATHS` and their raw answers as `updateAgent` read
 * them when it compared the save's base, joined by line breaks. The script reads them again before
 * its first write and answers `MEMORY_CHANGED`, writing nothing, when any answer moved.
 */
export function agentUpdateScriptArguments(
  plan: AgentRecordPlan,
  snapshot: string,
  memorySnapshot: string | null = null
): string[] {
  const type =
    plan.type.mode === 'set'
      ? plan.type.value
      : normalizePrimaryAgentType({ ...parseAgentTypeSnapshot(snapshot), ...plan.type.passedSources } as PrimaryAgentLike)
  const memoryGuard =
    memorySnapshot === null ? '' : JSON.stringify({ paths: AGENT_MEMORY_SOURCE_PATHS, snapshot: memorySnapshot })
  return [serializeAgentRecordPlan(plan.ops), plan.type.mode, JSON.stringify(type), snapshot, memoryGuard, ...AGENT_TYPE_SOURCE_PATHS]
}

/** The plan as `UPDATE_AGENT_FIELDS_SCRIPT` reads it: `[kind, path, valueAsJson?]` entries. */
export function serializeAgentRecordPlan(ops: AgentRecordOp[]): string {
  return JSON.stringify(
    ops.map((op) => {
      const path = agentRecordOpPath(op)
      switch (op.op) {
        case 'ensureObject':
          return ['ensure', path]
        case 'set':
          return ['set', path, JSON.stringify(op.value)]
        case 'delete':
          return ['del', path]
        case 'deleteIfNull':
          return ['delnull', path]
      }
    })
  )
}
