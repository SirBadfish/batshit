import { AGENT_TYPE_SOURCE_PATHS } from '$lib/server/agentRecordUpdate'

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
      const { field } = parseAgentRecordPath(path)
      return JSON.stringify(Object.prototype.hasOwnProperty.call(record, field) ? [record[field]] : [])
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
  args: string[]
): { answer: 'OK' | 'TYPE_CHANGED' | 'MEMORY_CHANGED'; record: Record_ } {
  const [opsJson, mode, typeJson, snapshot, memoryGuard, ...paths] = args
  const record = clone(stored)

  // BL-1294: the memory guard comes first, as in the script.
  if (memoryGuard !== '') {
    const guard = JSON.parse(memoryGuard) as { paths: string[]; snapshot: string }
    if (sameValuesText(guard.snapshot) !== agentTypeSnapshotOf(record, guard.paths)) {
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

  applyRecordOpsTwin(record, opsJson)
  return { answer: 'OK', record }
}

/**
 * BL-914: the default lane's twin of `UPDATE_SUBAGENT_FIELDS_SCRIPT`: the same ops loop over a
 * copy of the stored Subagent record (which exists: `MISSING` and the wrong-type error are the
 * caller's). The script's one argument is the plan's ops as JSON (`serializeAgentRecordPlan`).
 */
export function runSubagentUpdateScriptTwin(stored: Record_, args: string[]): { record: Record_ } {
  const [opsJson] = args
  const record = clone(stored)
  applyRecordOpsTwin(record, opsJson)
  return { record }
}
