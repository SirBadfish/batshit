import { matchesVoiceCatalogSelectionGuard } from '$lib/server/voiceCatalogSelectionGuard'
import { assertSettingsLifecycle, captureSettingsLifecycle, type SettingsLifecycleSnapshot } from '$lib/server/services/appActions/settings/lifecycle'
import { AGENT_TYPE_SOURCE_PATHS } from '$lib/server/agentRecordUpdate'
import { modelSelectionPaths, modelSelectionTypePaths, modelSelectionRevision,
  type ModelSelectionKind, type ModelSelectionSnapshot, type ModelSelectionRawGuard } from '$lib/server/modelSelectionGuard'
import { isAgentRuntimeSettingKey } from '$lib/utils/modelSettingsMapper'
import { instructionsReadPaths, makeInstructionsSnapshot, type InstructionsKind, type InstructionsLeaf, type InstructionsRawGuard } from '$lib/server/instructionsGuard'
import type { ConfiguredTtsRawGuard } from '$lib/server/configuredTtsGuard'
import { createHash } from 'node:crypto'
import { readAgentVoiceModelLockSource } from '$lib/server/modelVoiceSelectionSource'

/**
 * The default lane's twin of `UPDATE_AGENT_FIELDS_SCRIPT` (`redis.ts`; review of wave 2, item 3).
 * It takes the SAME arguments the real script gets (`agentUpdateScriptArguments`) and applies each
 * op by its PATH STRING, read with RedisJSON's rules for the three shapes the plan builds:
 * `$.<name>`, `$.<name>["<key>"]`, and `$.<name>["<key>"]["<field>"]` (a `nativeTools` field,
 * BL-841, or an entry of a `dcmDisplaySettings` map, BL-855), where `\"` and `\\` are the only
 * escapes and every other character is taken as it is. An escape RedisJSON refuses (`\n`, `\t`,
 * `A`) throws here too, so a path-building bug fails on the default lane as well. Before, the
 * fake applied `op.field` and `op.key` and never saw a path. The real-Redis parity test in
 * `agentUpdateByPath.test.ts` runs the real script and this twin on the same arguments and
 * compares the records. BL-914: the Subagent's twin (`runSubagentUpdateScriptTwin`) runs the
 * same ops loop (`applyRecordOpsTwin`); `subagentUpdateByPath.test.ts` compares it with the real
 * `UPDATE_SUBAGENT_FIELDS_SCRIPT` the same way.
 */

/** RedisJSON's error for a JSON command on a key of another type (a string key, say). */
export const REDISJSON_WRONG_TYPE_MESSAGE = 'Existing key has wrong Redis type'

const BACKSLASH = String.fromCharCode(92)
const CANONICAL_TYPES = new Set(['api', 'cli', 'n8n'])

type Record_ = Record<string, unknown>

function isObject(value: unknown): value is Record_ {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Sets an own key, a `__proto__` key included (a plain assignment of that name sets the prototype). */
function setOwn(target: Record_, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, writable: true, enumerable: true, configurable: true })
}

function pathError(path: string, position: number): Error {
  return new Error(`Error occurred at position ${position}: the twin cannot read the path ${JSON.stringify(path)}`)
}

/**
 * Reads one `["<name>"]` at `start` of `path`: the name and the index just past it. A quote ends
 * the name unless a backslash escapes it; a backslash escapes only a quote or a backslash.
 */
function readQuotedName(path: string, start: number): { name: string; end: number } {
  if (!path.startsWith('["', start)) throw pathError(path, start)
  let name = ''
  for (let index = start + 2; index < path.length; index += 1) {
    const character = path[index]
    if (character === BACKSLASH) {
      const next = path[index + 1]
      if (next !== '"' && next !== BACKSLASH) throw pathError(path, start + 1)
      name += next
      index += 1
    } else if (character === '"') {
      if (path[index + 1] !== ']') throw pathError(path, start + 1)
      return { name, end: index + 2 }
    } else {
      name += character
    }
  }
  throw pathError(path, start + 1)
}

/** `$.<field>`, `$.<field>["<key>"]` or `$.<field>["<key>"]["<subkey>"]`, read as RedisJSON reads it. */
export function parseAgentRecordPath(path: string): { field: string; key?: string; subkey?: string } {
  const match = /^\$\.([A-Za-z_][A-Za-z0-9_]*)/.exec(path)
  if (!match) throw pathError(path, 0)
  const field = match[1]
  if (path.length === match[0].length) return { field }
  const key = readQuotedName(path, match[0].length)
  if (key.end === path.length) return { field, key: key.name }
  const subkey = readQuotedName(path, key.end)
  if (subkey.end !== path.length) throw pathError(path, subkey.end)
  return { field, key: key.name, subkey: subkey.name }
}

/**
 * The type-field read of this record, as `updateAgent` sends it and the script makes it again:
 * each path's `JSON.GET` answer (`[value]`, or `[]` when the field is missing), joined by line breaks.
 * The memory read (BL-1294) is the same read of `AGENT_MEMORY_SOURCE_PATHS`.
 */
export function agentTypeSnapshotOf(record: Record_, paths: readonly string[] = AGENT_TYPE_SOURCE_PATHS): string {
  return paths
    .map((path) => {
      if (path === '$') return JSON.stringify([record])
      // Fixed nested snapshot reads introduced by A10; write-path parsing remains unchanged.
      if (/^\$\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(path)) {
        let value: unknown = record
        for (const key of path.slice(2).split('.')) value = isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined
        return JSON.stringify(value === undefined ? [] : [value])
      }
      const { field, key, subkey } = parseAgentRecordPath(path)
      const parent = key === undefined ? record : subkey === undefined ? record[field] : isObject(record[field]) ? record[field][key] : undefined
      const name = subkey ?? key ?? field
      return JSON.stringify(isObject(parent) && Object.hasOwn(parent, name) ? [parent[name]] : [])
    })
    .join('\n')
}

/** The same read with every answer written again by JSON.stringify: equal text means equal values. */
function sameValuesText(snapshot: string): string {
  return snapshot
    .split('\n')
    .map((answer) => JSON.stringify(JSON.parse(answer)))
    .join('\n')
}

/**
 * The ops loop both scripts share (`UPDATE_AGENT_FIELDS_SCRIPT` and `UPDATE_SUBAGENT_FIELDS_SCRIPT`,
 * `redis.ts`): each `['ensure' | 'set' | 'del' | 'delnull', path, valueAsJson?]` entry of the
 * plan, applied to `record` in place by its path string.
 */
export function applyRecordOpsTwin(record: Record_, opsJson: string): void {
  for (const [kind, path, valueJson] of JSON.parse(opsJson) as Array<[string, string, string?]>) {
    const { field, key, subkey } = parseAgentRecordPath(path)
    // RedisJSON: a path under a parent that is not an object reads as nothing, and a write or a
    // removal there changes nothing.
    const block = record[field]
    const parent =
      key === undefined ? record : subkey === undefined ? block : isObject(block) ? (block as Record_)[key] : undefined
    const name = subkey ?? key ?? field
    const present = isObject(parent) && Object.prototype.hasOwnProperty.call(parent, name)
    const current = present ? (parent as Record_)[name] : undefined
    if (kind === 'ensure') {
      if (!isObject(current) && isObject(parent)) setOwn(parent, name, {})
    } else if (kind === 'set') {
      if (isObject(parent)) setOwn(parent, name, JSON.parse(valueJson as string))
    } else if (kind === 'del') {
      if (present) delete (parent as Record_)[name]
    } else if (kind === 'delnull') {
      if (present && current === null) delete (parent as Record_)[name]
    } else {
      throw new Error(`The twin does not know the op ${JSON.stringify(kind)}.`)
    }
  }
}

/**
 * Runs the script's arguments against a copy of `stored` (a JSON record that exists; `MISSING` and
 * the wrong-type error are the caller's, as the real read answers them first). `TYPE_CHANGED`
 * leaves the record as it was. The type-field comparison is by value: the real script compares
 * RedisJSON's text, which is the same text for the same values.
 */
export function runAgentUpdateScriptTwin(
  stored: Record_,
  args: string[],
  preset?: Record_, dependencies?: Readonly<Record<number, Record_>>
): { answer: 'MCP_SETTINGS_BASE_REQUIRED' | 'MCP_SETTINGS_CHANGED' | 'OK' | 'TYPE_CHANGED' | 'MEMORY_CHANGED' | 'TTS_SELECTION_BASE_REQUIRED' | 'TTS_SELECTION_CHANGED' | InstructionsTwinRefusal | ModelSelectionTwinRefusal; record: Record_ } {
  const [opsJson, mode, typeJson, snapshot, memoryGuard, ...paths] = args
  const record = clone(stored)

  const guard = memoryGuard ? JSON.parse(memoryGuard) : {}
  const namesMcp = (JSON.parse(opsJson) as string[][]).some(op => op[0] !== 'delnull' && ['$.defaultMCPGateways', '$.defaultMCPToolSelections', '$.custom_tool_settings'].includes(op[1]))
  if (namesMcp && !guard.mcpSettings) return { answer: 'MCP_SETTINGS_BASE_REQUIRED', record }
  if (guard.mcpSettings && sameValuesText(guard.mcpSettings.raw.join('\n')) !== agentTypeSnapshotOf(record, guard.mcpSettings.paths)) return { answer: 'MCP_SETTINGS_CHANGED', record }
  const voiceRefusal = checkConfiguredTtsTwin(record, opsJson, guard.ttsSelection, dependencies)
  if (voiceRefusal) return { answer: voiceRefusal, record }
  const instructionRefusal = checkInstructionsTwin(record, opsJson, guard.instructions, dependencies)
  if (instructionRefusal) return { answer: instructionRefusal, record }
  const resultingType = mode === 'set' || mode === 'derive' || !CANONICAL_TYPES.has(String(record.agentType)) ? JSON.parse(typeJson) : record.agentType
  const modelRefusal = checkModelSelectionTwin(record, resultingType, guard.modelSelection, dependencies, 'agent')
  if (modelRefusal) return { answer: modelRefusal, record }
  // BL-1294: the memory guard comes after the model check, as in the script.
  if (memoryGuard !== '') {
    const guard = JSON.parse(memoryGuard) as { paths: string[]; snapshot: string }
    if (guard.paths.length && sameValuesText(guard.snapshot) !== agentTypeSnapshotOf(record, guard.paths)) {
      return { answer: 'MEMORY_CHANGED', record: clone(stored) }
    }
  }

  let writeType = mode === 'set'
  if (!writeType) {
    const storedType = record.agentType
    if (mode === 'derive' || !(typeof storedType === 'string' && CANONICAL_TYPES.has(storedType))) {
      if (sameValuesText(snapshot) !== agentTypeSnapshotOf(record, paths)) {
        return { answer: 'TYPE_CHANGED', record: clone(stored) }
      }
      writeType = true
    }
  }
  if (writeType) setOwn(record, 'agentType', JSON.parse(typeJson))
  if (guard.ttsSelection?.removeFishAlias) {
    const profile = record.voice_profile
    const tts = isObject(profile) ? profile.tts : undefined
    const options = isObject(tts) ? tts.providerOptions : undefined
    if (isObject(options) && isObject(options.fish)) delete options.fish.reference_id
  }

  applyRecordOpsTwin(record, opsJson)
  return { answer: 'OK', record }
}

/**
 * BL-914: the default lane's twin of `UPDATE_SUBAGENT_FIELDS_SCRIPT`: the same ops loop over a
 * copy of the stored Subagent record (which exists: `MISSING` and the wrong-type error are the
 * caller's). The arguments are the script's, by position: [0] the plan's ops as JSON
 * (`serializeAgentRecordPlan`), [1] the model selection guard, [2] the instructions guard
 * (each `''` when absent). The Typed File Tools guard ([3]) is not twinned here.
 */
export function runSubagentUpdateScriptTwin(stored: Record_, args: string[], dependencies?: Readonly<Record<number, Record_>>): {
  record: Record_; answer: 'OK' | InstructionsTwinRefusal | ModelSelectionTwinRefusal
} {
  const [opsJson, modelGuardJson, instructionsGuardJson] = args
  const record = clone(stored)
  const instructionRefusal = checkInstructionsTwin(record, opsJson, instructionsGuardJson ? JSON.parse(instructionsGuardJson) : undefined, dependencies)
  if (instructionRefusal) return { answer: instructionRefusal, record }
  const typeOp = (JSON.parse(opsJson) as string[][]).findLast(op => op[1] === '$.subagentType' && op[0] === 'set')
  const modelRefusal = checkModelSelectionTwin(record, typeOp ? JSON.parse(typeOp[2]) : record.subagentType,
    modelGuardJson ? JSON.parse(modelGuardJson) : undefined, dependencies, 'subagent')
  if (modelRefusal) return { answer: modelRefusal, record }
  applyRecordOpsTwin(record, opsJson)
  return { record, answer: 'OK' }
}

type InstructionsTwinRefusal = 'INSTRUCTIONS_BASE_REQUIRED' | 'INSTRUCTIONS_CHANGED' | 'INSTRUCTIONS_EXPIRED'
type ModelSelectionTwinRefusal = 'MODEL_SELECTION_BASE_REQUIRED' | 'MODEL_SELECTION_CHANGED' | 'MODEL_SELECTION_EXPIRED'
/** Existing fixed guard payload. Default precision uses JSON values; owning real Redis still
 * qualifies raw wire parity. */
function checkModelSelectionTwin(record: Record_, resultingType: unknown, guard: ModelSelectionRawGuard | undefined,
  dependencies: Readonly<Record<number, Record_>> | undefined, recordKind: 'agent' | 'subagent'): ModelSelectionTwinRefusal | undefined {
  if (!guard) return
  const types = [recordKind === 'agent' ? record.agentType : record.subagentType, guard.currentType, resultingType]
  // SA-139 R4/R5: a Primary or Subagent needs the base only as the API type (both scripts' rule).
  const needsBase = types.includes('api')
  if (!guard.clientBase && needsBase) return 'MODEL_SELECTION_BASE_REQUIRED'
  if (guard.deadlineAt !== undefined && Date.now() >= guard.deadlineAt) return 'MODEL_SELECTION_EXPIRED'
  for (const member of guard.memberships ?? []) {
    const source = member.keyIndex === 1 ? record : dependencies?.[member.keyIndex]
    if (!source || !Array.isArray(source.__members) || !source.__members.includes(member.member)) return 'MODEL_SELECTION_CHANGED'
  }
  for (const check of guard.checks ?? []) {
    const source = check.keyIndex === 1 ? record : dependencies?.[check.keyIndex]
    if (check.storage === 'string') {
      const raw: unknown = source
      if (typeof raw !== 'string' || check.paths.some(([, expected]) => raw !== expected)) return 'MODEL_SELECTION_CHANGED'
    } else if (!source || check.paths.some(([path, raw]) => sameValuesText(raw) !== agentTypeSnapshotOf(source, [path]))) return 'MODEL_SELECTION_CHANGED'
  }
  if (guard.paths.some((path, index) => sameValuesText(guard.raw[index]) !== agentTypeSnapshotOf(record, [path]))) return 'MODEL_SELECTION_CHANGED'
  const kind = (value: unknown) => value === undefined ? '' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (guard.containers?.some(container => kind(record[container.path.slice(2)]) !== container.type)) return 'MODEL_SELECTION_CHANGED'
  if (guard.providerKeys && (!['', 'null', 'object'].includes(kind(record.provider_specific_settings)) ||
    Object.keys(record.provider_specific_settings ?? {}).some(key => !isAgentRuntimeSettingKey(key) && !guard.providerKeys!.includes(key)))) return 'MODEL_SELECTION_CHANGED'
}
/** Only the three fixed read-only Voice/model source cuts; this is not a generic EVAL fake. */
export function readAgentVoiceModelLockSourceTwin(userId: string, id: string, records: Readonly<Record<string, Record_>>, postimage: Readonly<Record<string, unknown>> = {}) {
  const kind = (value: unknown) => value === undefined ? '' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  return readAgentVoiceModelLockSource({ async eval(script, args) {
    const raw = (key: string, path: string) => agentTypeSnapshotOf(records[key] ?? {}, [path])
    if (script.includes('-- fixed-agent-voice-model-source')) {
      const paths = JSON.parse(args.arguments[0]) as string[]
      return ['OK', ...paths.map(path => raw(args.keys[0], path)), kind(records[args.keys[0]]?.primary_model_connection)]
    }
    if (script.includes('-- fixed-voice-model-index-source')) {
      const members = records[args.keys[0]] ? records[args.keys[0]].__members : []
      if (!Array.isArray(members) || members.length > 256) return ['LIMIT']
      return ['OK', ...[...members].sort()]
    }
    if (script.includes('-- fixed-voice-model-record-source')) {
      const ids = JSON.parse(args.arguments[0]) as string[], paths = JSON.parse(args.arguments[1]) as string[]
      const members = records[args.keys[0]] ? records[args.keys[0]].__members : []
      if (!Array.isArray(members) || ids.some(id => !members.includes(id)) || args.arguments[2] !== '1' && ids.length !== members.length) return ['CHANGED']
      return ['OK', ...ids.flatMap((_, index) => [...paths.map(path => raw(args.keys[index + 1], path)), kind(records[args.keys[index + 1]]?.connection)])]
    }
    throw new Error('Unsupported fixed Voice/model source cut')
  } }, userId, id, postimage)
}
function checkInstructionsTwin(record: Record_, opsJson: string, guard?: InstructionsRawGuard, dependencies?: Readonly<Record<number, Record_>>): InstructionsTwinRefusal | undefined {
  const names = (JSON.parse(opsJson) as string[][]).some(op => op[1] === '$.system_prompt' || op[1] === '$.include_global_prompt')
  if (names && !guard || guard && !guard.clientBase) return 'INSTRUCTIONS_BASE_REQUIRED'
  if (!guard) return
  if (guard.deadlineAt !== undefined && Date.now() >= guard.deadlineAt) return 'INSTRUCTIONS_EXPIRED'
  if (sameValuesText(guard.raw.join('\n')) !== agentTypeSnapshotOf(record, guard.paths)) return 'INSTRUCTIONS_CHANGED'
  if (guard.authority) {
    const source = guard.authority.keyIndex === 1 ? record : dependencies?.[guard.authority.keyIndex]
    if (!source || guard.authority.paths.some(([path, raw]) => sameValuesText(raw) !== agentTypeSnapshotOf(source, [path]))) return 'INSTRUCTIONS_CHANGED'
  }
}

function checkConfiguredTtsTwin(record: Record_, opsJson: string, guard?: ConfiguredTtsRawGuard, dependencies?: Readonly<Record<number, Record_>>): 'TTS_SELECTION_BASE_REQUIRED' | 'TTS_SELECTION_CHANGED' | undefined {
  const names = (JSON.parse(opsJson) as string[][]).some(op => op[1] === '$.voice_profile' && op[0] !== 'delnull' || op[1].startsWith('$.voice_profile['))
  if (names && !guard) return 'TTS_SELECTION_BASE_REQUIRED'
  if (!guard) return
  const kind = (value: unknown) => value === undefined ? '' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const rawAt = (source: Record_, path: string) => agentTypeSnapshotOf(source, [path])
  if (guard.deadlineAt !== undefined && Date.now() >= guard.deadlineAt || kind(record.voice_profile) !== guard.parentType || kind(isObject(record.voice_profile) ? record.voice_profile.tts : undefined) !== guard.ttsType ||
    guard.paths.some((path, index) => sameValuesText(guard.raw[index]) !== rawAt(record, path))) return 'TTS_SELECTION_CHANGED'
  for (const source of guard.sources) {
    const dependency = source.keyIndex === 1 ? record : dependencies?.[source.keyIndex]
    if ('voiceCatalog' in source) {
      const value = dependency && Object.hasOwn(dependency, '__voiceCatalogString') ? dependency.__voiceCatalogString : dependency
      if (!matchesVoiceCatalogSelectionGuard(source.voiceCatalog, value)) return 'TTS_SELECTION_CHANGED'
      continue
    }
    if (!dependency) return 'TTS_SELECTION_CHANGED'
    if ('member' in source) { if ((Array.isArray(dependency.__members) && dependency.__members.includes(source.member)) !== source.present) return 'TTS_SELECTION_CHANGED' }
    else if ('members' in source) { if (!Array.isArray(dependency.__members) || dependency.__members.length !== source.members.length || source.members.some(member => !(dependency.__members as string[]).includes(member))) return 'TTS_SELECTION_CHANGED' }
    else if ('typePath' in source) { const values = JSON.parse(rawAt(dependency, source.typePath)); if (kind(values[0]) !== source.type) return 'TTS_SELECTION_CHANGED' }
    else if ('fingerprint' in source) { const raw = rawAt(dependency, source.path); if (Buffer.byteLength(raw, 'utf8') > source.byteLimit || createHash('sha1').update(raw).digest('hex') !== source.fingerprint) return 'TTS_SELECTION_CHANGED' }
    else if (sameValuesText(source.raw) !== rawAt(dependency, source.path)) return 'TTS_SELECTION_CHANGED'
  }
  if (guard.authority) {
    const source = guard.authority.keyIndex === 1 ? record : dependencies?.[guard.authority.keyIndex]
    if (!source || guard.authority.paths.some(([path, raw]) => sameValuesText(raw || '[]') !== rawAt(source, path))) return 'TTS_SELECTION_CHANGED'
  }
}

export function readInstructionsSnapshotTwin(id: string, kind: InstructionsKind, record: Record_, lifecycle: SettingsLifecycleSnapshot,
  leaves: readonly InstructionsLeaf[]) {
  const paths = instructionsReadPaths(kind, leaves)
  return makeInstructionsSnapshot(id, kind, paths.map(path => [path, agentTypeSnapshotOf(record, [path])]), lifecycle, leaves)
}

/** Component fixture twin only. Real wire/precision/precondition proof uses the DB15 suite. */
export function readModelSelectionSnapshotTwin(id: string, kind: ModelSelectionKind, record: Record_ | null,
  lifecycle = captureSettingsLifecycle([`${kind}:${id}`]), extraPaths: readonly string[] = [], options?: { typeFenceOnly?: true }) {
  assertSettingsLifecycle(lifecycle)
  if (!record) throw Object.assign(new Error('Agent not found'), { status: 404 })
  const providerKeys = kind === 'agent' && !options?.typeFenceOnly ? Object.keys(isObject(record.provider_specific_settings) ? record.provider_specific_settings : {}).filter(key => !isAgentRuntimeSettingKey(key)).sort() : undefined
  const paths = [...options?.typeFenceOnly ? modelSelectionTypePaths(kind) : modelSelectionPaths(kind), ...(providerKeys ?? []).map(key => `$.provider_specific_settings["${key.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`)]
  const guard = { paths, raw: agentTypeSnapshotOf(record, paths).split('\n'), ...(providerKeys ? { providerKeys } : {}) }
  const snapshot: ModelSelectionSnapshot = { ...guard, record: clone(record), lifecycle, extraRaw: extraPaths.length ? agentTypeSnapshotOf(record, extraPaths).split('\n') : [],
    revision: modelSelectionRevision(id, kind, guard, lifecycle) }
  return snapshot
}
