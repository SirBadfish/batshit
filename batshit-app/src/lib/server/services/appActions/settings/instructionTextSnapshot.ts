import { createHash } from 'node:crypto'
import { describeInstructionText, INSTRUCTION_LIMITS, type InstructionTextDescriptor } from '$lib/appActions/settings/instructionPreferences'
import { SETTINGS_REPORT_BYTE_LIMITS, SettingsReportRefusal, type SettingsSubjectRef } from '$lib/appActions/settings/reportContract'
import { isCanonicalAgentId } from '$lib/utils/agentId'
import { assertSettingsLifecycle, captureSettingsLifecycle, type SettingsLifecycleSnapshot } from './lifecycle'

export type InstructionTextReader = (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>
export type BoundedInstructionTextDescriptor = InstructionTextDescriptor | Readonly<{ stored: 'set'; codeUnits: null; utf8Bytes: number; read: 'too_large' }>
export type InstructionTextRead = Readonly<{
  subject: SettingsSubjectRef
  record: Readonly<Record<string, unknown>>
  customPrompt?: BoundedInstructionTextDescriptor
  text?: string
  /** Private report-to-operation preimage only; never a public descriptor or text substitute. */
  promptPreimage?: string
  raw: readonly (readonly [path: string, raw: string])[]
  lifecycle: SettingsLifecycleSnapshot
}>

/** Fixed read only. No root JSON.GET and no caller-selected path enters this script.
 * JSON.STRLEN is UTF-8 byte length, not JavaScript UTF-16 length. The exact pinned
 * Redis/client path is qualified by the integrating owner's actual Redis tests. */
export const INSTRUCTION_TEXT_READ_SCRIPT = `
local key = KEYS[1]
local root = redis.call('JSON.TYPE', key, '$')
if not root or #root ~= 1 or root[1] ~= 'object' then return {'UNAVAILABLE'} end
local function kind(path)
  local result = redis.call('JSON.TYPE', key, path)
  if not result or #result == 0 then return 'absent' end
  if #result ~= 1 then return 'invalid' end
  return result[1]
end
local function scalar(path, nullable)
  local t = kind(path)
  if nullable and t == 'absent' then return '[]' end
  if nullable and t == 'null' then return '[null]' end
  if t ~= 'string' then return false end
  local lengths = redis.call('JSON.STRLEN', key, path)
  if not lengths or #lengths ~= 1 or type(lengths[1]) ~= 'number' or lengths[1] > 1024 then return false end
  return redis.call('JSON.GET', key, path)
end
local id = scalar('$.id', false)
local owner = scalar('$.user_id', false)
local agentType = scalar(ARGV[1], false)
local created = scalar('$.created_at', true)
if not id or not owner or not agentType or not created then return {'UNAVAILABLE'} end
local identity = cjson.decode(id)
local owned = cjson.decode(owner)
local typed = cjson.decode(agentType)
if identity[1] ~= ARGV[2] or owned[1] ~= ARGV[3] then return {'UNAVAILABLE'} end
if typed[1] ~= 'api' then return {'UNAVAILABLE'} end
local inclusionKind = kind('$.include_global_prompt')
local inclusion = ''
if inclusionKind == 'boolean' or inclusionKind == 'null' then inclusion = redis.call('JSON.GET', key, '$.include_global_prompt')
elseif inclusionKind == 'absent' then inclusion = '[]'
else inclusionKind = 'invalid' end
local promptKind = 'disabled'
local promptBytes = 0
local prompt = ''
if ARGV[4] == '1' then
  promptKind = kind('$.system_prompt')
  if promptKind == 'string' then
    local lengths = redis.call('JSON.STRLEN', key, '$.system_prompt')
    if not lengths or #lengths ~= 1 or type(lengths[1]) ~= 'number' then return {'UNAVAILABLE'} end
    promptBytes = lengths[1]
    if promptBytes <= ${INSTRUCTION_LIMITS.readSnapshotBytes} then prompt = redis.call('JSON.GET', key, '$.system_prompt') end
  elseif promptKind == 'absent' then prompt = '[]'
  elseif promptKind == 'null' then prompt = '[null]'
  else promptKind = 'invalid' end
end
return {'OK', id, owner, agentType, created, inclusionKind, inclusion, promptKind, promptBytes, prompt}
`

const refuse = (reason = 'instruction_text_unavailable'): never => { throw new SettingsReportRefusal(reason) }
function parseRaw(raw: unknown, limit: number): { present: boolean; value: unknown; raw: string } {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > limit) return refuse()
  let values: unknown
  try { values = JSON.parse(raw) } catch { return refuse() }
  if (!Array.isArray(values) || values.length > 1) return refuse()
  return { present: values.length === 1, value: values[0], raw }
}
function subjectKey(subject: SettingsSubjectRef): string {
  if ((subject.kind !== 'primary' && subject.kind !== 'subagent') || !isCanonicalAgentId(subject.id)) return refuse('stored_agent_instructions_only')
  return `${subject.kind === 'primary' ? 'agent' : 'subagent'}:${subject.id}`
}

/** Main supplies explicit disclosure admission and the actual client; this leaf
 * supplies only a fixed bounded read and the original lifecycle check. */
export async function readInstructionTextSnapshot(
  subject: SettingsSubjectRef, userId: string, reader: InstructionTextReader, options: { includeText: boolean; prompt?: boolean }
): Promise<InstructionTextRead> {
  const key = subjectKey(subject), capturedSubject = Object.freeze({ ...subject })
  if (typeof userId !== 'string' || !userId || typeof options.includeText !== 'boolean' || options.prompt !== undefined && typeof options.prompt !== 'boolean' ||
    options.includeText && options.prompt === false) return refuse('invalid_instruction_text_read')
  const includeText = options.includeText, prompt = options.prompt !== false
  const lifecycle = captureSettingsLifecycle([key])
  const typePath = capturedSubject.kind === 'primary' ? '$.agentType' : '$.subagentType'
  const reply = await reader(INSTRUCTION_TEXT_READ_SCRIPT, { keys: [key], arguments: [typePath, capturedSubject.id, userId, prompt ? '1' : '0'] })
  assertSettingsLifecycle(lifecycle)
  if (!Array.isArray(reply) || reply[0] !== 'OK' || reply.length !== 10) return refuse()
  const raw: Array<readonly [string, string]> = [], record: Record<string, unknown> = {}
  for (const [index, path, field] of [[1, '$.id', 'id'], [2, '$.user_id', 'user_id'], [3, typePath, capturedSubject.kind === 'primary' ? 'agentType' : 'subagentType'], [4, '$.created_at', 'created_at']] as const) {
    const value = parseRaw(reply[index], 6 * 1024 + 8)
    if ((index !== 4 || value.value !== null && value.present) && (typeof value.value !== 'string' || !value.value.isWellFormed() || Buffer.byteLength(value.value, 'utf8') > 1024)) return refuse()
    if (value.present) record[field] = value.value
    raw.push(Object.freeze([path, value.raw] as const))
  }
  const type = record[capturedSubject.kind === 'primary' ? 'agentType' : 'subagentType']
  // SA-139 R4/R5: a Primary or Subagent must be api; a leftover `cli` record of either kind is retired.
  if (record.id !== capturedSubject.id || record.user_id !== userId || type !== 'api') return refuse()
  if (reply[5] === 'invalid') {
    if (reply[6] !== '') return refuse()
    record.include_global_prompt = Object.freeze({ invalid: true })
  }
  else {
    const value = parseRaw(reply[6], 16)
    if (reply[5] === 'absent' ? value.present : reply[5] === 'null' ? !value.present || value.value !== null : reply[5] !== 'boolean' || !value.present || typeof value.value !== 'boolean') return refuse()
    if (value.present) record.include_global_prompt = value.value
    raw.push(Object.freeze(['$.include_global_prompt', value.raw] as const))
  }
  let customPrompt: BoundedInstructionTextDescriptor | undefined, text: string | undefined, promptPreimage: string | undefined
  if (prompt) {
    const kind = reply[7], length = reply[8]
    if (!Number.isSafeInteger(length) || length < 0) return refuse()
    if (kind === 'string' && length > INSTRUCTION_LIMITS.readSnapshotBytes) {
      if (reply[9] !== '') return refuse()
      customPrompt = Object.freeze({ stored: 'set', codeUnits: null, utf8Bytes: length, read: 'too_large' })
    } else if (kind === 'invalid') {
      if (reply[9] !== '' || length !== 0) return refuse()
      customPrompt = describeInstructionText(false)
    } else {
      const value = parseRaw(reply[9], INSTRUCTION_LIMITS.readSnapshotBytes * 6 + 8)
      if (kind === 'absent' ? value.present || length !== 0 : kind === 'null' ? !value.present || value.value !== null || length !== 0 : kind !== 'string' || !value.present || typeof value.value !== 'string' || Buffer.byteLength(value.value, 'utf8') !== length) return refuse()
      customPrompt = describeInstructionText(value.value)
      if (customPrompt.stored !== 'invalid') {
        promptPreimage = `sha256:${createHash('sha256').update(value.raw).digest('hex')}`
        if (includeText) {
          raw.push(Object.freeze(['$.system_prompt', value.raw] as const))
          if (typeof value.value === 'string') text = value.value
        }
      }
    }
  } else if (reply[7] !== 'disabled' || reply[8] !== 0 || reply[9] !== '') return refuse()
  return Object.freeze({ subject: capturedSubject, record: Object.freeze(record), ...(customPrompt ? { customPrompt } : {}),
    ...(text !== undefined ? { text } : {}), ...(promptPreimage ? { promptPreimage } : {}), raw: Object.freeze(raw), lifecycle })
}

export type InstructionTextPage = Readonly<{
  schemaVersion: 1; basis: 'internal-read-snapshot'; domain: 'agent-settings'; snapshotId: string; observedAt: string; detail: 'values'
  subject: SettingsSubjectRef; customPrompt: BoundedInstructionTextDescriptor; includeGlobalPrompt: Readonly<{ stored: 'absent' | 'null' | 'set' | 'invalid'; value?: boolean }>
  text: string | null
  continuation: Readonly<{ totalCodeUnits: number; offsetCodeUnits: number; returnedCodeUnits: number; remainingCodeUnits: number; nextCursor: string | null }>
}>

/** Immutable text only. The wrapper owns grant, expiry, Stop and current authority
 * on every page handoff; a cursor never starts another source read. */
export function createInstructionTextPages(read: InstructionTextRead, options: { reservedBytes?: number; observedAt?: string } = {}) {
  const reservedBytes = options.reservedBytes ?? 0
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || reservedBytes >= SETTINGS_REPORT_BYTE_LIMITS.values) return refuse('invalid_report_budget')
  const observedAt = options.observedAt ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt || !read.customPrompt || read.customPrompt.read !== 'available') return refuse()
  const text = read.text ?? null, descriptor = Object.freeze({ ...read.customPrompt }), subject = Object.freeze({ ...read.subject })
  if (descriptor.stored === 'set' && (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text, 'utf8') > INSTRUCTION_LIMITS.readSnapshotBytes ||
    text.length !== descriptor.codeUnits || Buffer.byteLength(text, 'utf8') !== descriptor.utf8Bytes) ||
    descriptor.stored === 'unset' && (text !== null || descriptor.codeUnits !== 0 || descriptor.utf8Bytes !== 0)) return refuse()
  const inclusion = read.record.include_global_prompt
  const includeGlobalPrompt = Object.freeze(!Object.hasOwn(read.record, 'include_global_prompt') ? { stored: 'absent' as const } : inclusion === null ? { stored: 'null' as const } : typeof inclusion === 'boolean' ? { stored: 'set' as const, value: inclusion } : { stored: 'invalid' as const })
  const snapshotId = createHash('sha256').update(JSON.stringify([subject, read.record.id, read.record.user_id, read.record.agentType ?? read.record.subagentType, read.record.created_at, read.lifecycle, descriptor, includeGlobalPrompt, text, observedAt])).digest('hex')
  const total = text?.length ?? 0, limit = SETTINGS_REPORT_BYTE_LIMITS.values - reservedBytes
  function page(cursor?: string): InstructionTextPage {
    let offset = 0
    if (cursor !== undefined) {
      if (!/^si1:[a-f0-9]{64}:[0-9]{1,6}$/.test(cursor)) return refuse('invalid_report_cursor')
      const [, hash, raw] = cursor.split(':'); offset = Number(raw)
      if (hash !== snapshotId || offset > total || offset > 0 && offset < total && text!.charCodeAt(offset) >= 0xdc00 && text!.charCodeAt(offset) <= 0xdfff) return refuse('cursor_snapshot_mismatch')
    }
    function build(end: number): InstructionTextPage {
      return Object.freeze({ schemaVersion: 1, basis: 'internal-read-snapshot', domain: 'agent-settings', snapshotId, observedAt, detail: 'values', subject,
        customPrompt: descriptor, includeGlobalPrompt, text: text === null ? null : text.slice(offset, end), continuation: Object.freeze({ totalCodeUnits: total,
          offsetCodeUnits: offset, returnedCodeUnits: end - offset, remainingCodeUnits: total - end, nextCursor: end < total ? `si1:${snapshotId}:${end}` : null }) })
    }
    let low = offset, high = total
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(JSON.stringify(build(middle)), 'utf8') <= limit) low = middle
      else high = middle - 1
    }
    let end = low
    if (end > offset && end < total && text!.charCodeAt(end) >= 0xdc00 && text!.charCodeAt(end) <= 0xdfff) end--
    const result = build(end)
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > limit || end === offset && offset < total) return refuse('report_row_exceeds_budget')
    return result
  }
  return Object.freeze({ snapshotId, page })
}
