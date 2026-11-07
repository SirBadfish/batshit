import { createHash } from 'node:crypto'
import type { InstructionsRevisions } from '$lib/appActions/settings/instructionsBaseline'
import { PRIMARY_AGENT_TYPE_SOURCE_FIELDS } from '$lib/utils/primaryAgentType'
import { captureSettingsLifecycle, assertSettingsLifecycle, type SettingsLifecycleSnapshot } from './services/appActions/settings/lifecycle'

export type InstructionsKind = 'agent' | 'subagent'
export type InstructionsLeaf = keyof InstructionsRevisions
export const INSTRUCTIONS_FIELDS = { customPrompt: 'system_prompt', includeGlobalPrompt: 'include_global_prompt' } as const
export const INSTRUCTIONS_PATHS = ['$.system_prompt', '$.include_global_prompt'] as const
const SUBAGENT_TYPES = ['subagentType', 'subagent_type', 'workflowName', 'workflow_name', 'webhookUrl', 'webhook_url'] as const
export function instructionsReadPaths(kind: InstructionsKind, leaves: readonly InstructionsLeaf[] = ['customPrompt', 'includeGlobalPrompt']): string[] {
  return [...new Set(['id', 'user_id', 'created_at', ...(kind === 'agent' ? PRIMARY_AGENT_TYPE_SOURCE_FIELDS : SUBAGENT_TYPES),
    ...leaves.map(leaf => INSTRUCTIONS_FIELDS[leaf])])].map(field => `$.${field}`)
}
export function instructionLeaves(updates: Record<string, unknown>): InstructionsLeaf[] {
  return (Object.keys(INSTRUCTIONS_FIELDS) as InstructionsLeaf[]).filter(leaf => Object.hasOwn(updates, INSTRUCTIONS_FIELDS[leaf]) && updates[INSTRUCTIONS_FIELDS[leaf]] !== undefined)
}
export class InstructionsBaseRequiredError extends Error {
  readonly status = 400; readonly code = 'instructions_base_required'
  constructor() { super('Read these saved instructions before changing them. Nothing was saved.') }
}
export class InstructionsConflictError extends Error {
  readonly status = 409; readonly code = 'instructions_settings_changed'
  constructor() { super('The saved instructions changed. Your draft is kept; deliberately read the current instructions before another choice. Nothing was saved.') }
}
export class InstructionsSaveUnconfirmedError extends Error {
  readonly status = 503; readonly code = 'instructions_save_unconfirmed'
  constructor() { super('The instruction save was issued but its outcome is unconfirmed. Check current values; do not automatically repeat this save.') }
}
export function requireInstructionsExpected(value: unknown, leaves: readonly InstructionsLeaf[] = []): asserts value is Partial<InstructionsRevisions> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some(key => !Object.hasOwn(INSTRUCTIONS_FIELDS, key)) || !Object.keys(value).length ||
    Object.values(value).some(token => typeof token !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(token)) ||
    leaves.some(leaf => !Object.hasOwn(value, leaf))) throw new InstructionsBaseRequiredError()
}
function stored(raw: string): unknown {
  const values = JSON.parse(raw || '[]')
  if (!Array.isArray(values) || values.length > 1) throw new InstructionsConflictError()
  return values[0]
}
export type InstructionsSnapshot = Readonly<{
  id: string; kind: InstructionsKind; paths: readonly string[]; raw: readonly string[]; record: Readonly<Record<string, unknown>>
  lifecycle: SettingsLifecycleSnapshot; revisions: Readonly<Partial<InstructionsRevisions>>
}>
/** Facts from one actual atomic read. Tokens carry no write/read authority. */
export function makeInstructionsSnapshot(id: string, kind: InstructionsKind, pairs: readonly (readonly [string, string])[], lifecycle: SettingsLifecycleSnapshot,
  leaves: readonly InstructionsLeaf[] = ['customPrompt', 'includeGlobalPrompt']): InstructionsSnapshot {
  assertSettingsLifecycle(lifecycle)
  const values = new Map(pairs)
  const record = Object.fromEntries(pairs.map(([path, raw]) => [path.slice(2), stored(raw)]))
  if (record.id !== id || typeof record.user_id !== 'string') throw new InstructionsConflictError()
  const typeField = kind === 'agent' ? 'agentType' : 'subagentType'
  const canonical = record[typeField] === 'api' || record[typeField] === 'cli'
  const identity = ['$.id', '$.user_id', '$.created_at', ...(canonical ? [`$.${typeField}`] :
    (kind === 'agent' ? PRIMARY_AGENT_TYPE_SOURCE_FIELDS : SUBAGENT_TYPES).map(field => `$.${field}`))]
  if (identity.some(path => !values.has(path)) || leaves.some(leaf => !values.has(`$.${INSTRUCTIONS_FIELDS[leaf]}`))) throw new InstructionsConflictError()
  const identityRaw = identity.map(path => [path, values.get(path)!])
  const revisions = Object.fromEntries(leaves.map(leaf => [leaf, `sha256:${createHash('sha256').update(JSON.stringify({ id, kind, identity: identityRaw,
    leaf, raw: values.get(`$.${INSTRUCTIONS_FIELDS[leaf]}`), lifecycle })).digest('hex')}`]))
  const paths = [...identity, ...leaves.map(leaf => `$.${INSTRUCTIONS_FIELDS[leaf]}`)]
  return Object.freeze({ id, kind, record: Object.freeze(record), paths: Object.freeze(paths), raw: Object.freeze(paths.map(path => values.get(path)!)),
    revisions: Object.freeze(revisions), lifecycle })
}
const READ_INSTRUCTIONS_SNAPSHOT = `
-- BATSHIT_HUMAN_INSTRUCTIONS_BASE_V1: fixed leaves; existing authenticated human editor has no new size restriction.
if redis.call('EXISTS', KEYS[1]) == 0 then return {'MISSING'} end
if redis.call('JSON.TYPE', KEYS[1], '$')[1] ~= 'object' then return {'INVALID'} end
local out = {'OK'}
for _, path in ipairs(cjson.decode(ARGV[1])) do out[#out + 1] = redis.call('JSON.GET', KEYS[1], path) or '' end
return out
`
/** Human write guard only. Agent metadata/text reads use the separate bounded fixed reader. */
export async function readInstructionsSnapshot(client: { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> }, id: string,
  kind: InstructionsKind, lifecycle = captureSettingsLifecycle([`${kind}:${id}`]), leaves: readonly InstructionsLeaf[] = ['customPrompt', 'includeGlobalPrompt']): Promise<InstructionsSnapshot> {
  assertSettingsLifecycle(lifecycle)
  const paths = instructionsReadPaths(kind, leaves)
  const answer = await client.eval(READ_INSTRUCTIONS_SNAPSHOT, { keys: [`${kind}:${id}`], arguments: [JSON.stringify(paths)] })
  assertSettingsLifecycle(lifecycle)
  if (Array.isArray(answer) && answer[0] === 'MISSING') throw Object.assign(new Error('Agent not found'), { status: 404 })
  if (!Array.isArray(answer) || answer[0] !== 'OK' || answer.length !== paths.length + 1 || answer.slice(1).some(raw => typeof raw !== 'string')) throw new InstructionsConflictError()
  return makeInstructionsSnapshot(id, kind, paths.map((path, index) => [path, answer[index + 1]]), lifecycle, leaves)
}
export type InstructionsMutation = Readonly<{ target: InstructionsSnapshot; check(): void; signal?: AbortSignal; deadlineAt?: number; onSaved?(): void;
  authority: { key: string; paths: readonly (readonly [string, string])[]; lifecycle?: SettingsLifecycleSnapshot } }>
export type InstructionsRawGuard = { paths: readonly string[]; raw: readonly string[]; clientBase: true; deadlineAt?: number;
  authority?: { keyIndex: number; paths: readonly (readonly [string, string])[] } }
export function instructionsWriteBasis(snapshot: InstructionsSnapshot, expected: unknown, leaves: readonly InstructionsLeaf[], mutation?: InstructionsMutation) {
  requireInstructionsExpected(expected, leaves)
  if (leaves.some(leaf => expected[leaf] !== snapshot.revisions[leaf])) throw new InstructionsConflictError()
  assertSettingsLifecycle(snapshot.lifecycle)
  if (mutation) {
    assertSettingsLifecycle(mutation.target.lifecycle)
    if (mutation.target.id !== snapshot.id || mutation.target.kind !== snapshot.kind || leaves.some(leaf => mutation.target.revisions[leaf] !== snapshot.revisions[leaf])) throw new InstructionsConflictError()
    if (mutation.authority.lifecycle) assertSettingsLifecycle(mutation.authority.lifecycle)
    checkInstructionsIssue(mutation)
  }
  return { epoch: snapshot.lifecycle.epoch, records: [...snapshot.lifecycle.records, ...(mutation?.target.lifecycle.records ?? []), ...(mutation?.authority.lifecycle?.records ?? [])] }
}
export function instructionsIssueGuard(snapshot: InstructionsSnapshot, keys: string[], mutation?: InstructionsMutation): InstructionsRawGuard {
  let authority: InstructionsRawGuard['authority']
  if (mutation) {
    let index = keys.indexOf(mutation.authority.key)
    if (index < 0) { keys.push(mutation.authority.key); index = keys.length - 1 }
    authority = { keyIndex: index + 1, paths: mutation.authority.paths }
  }
  return { paths: snapshot.paths, raw: snapshot.raw, clientBase: true, ...(authority ? { authority } : {}),
    ...(mutation?.deadlineAt !== undefined ? { deadlineAt: mutation.deadlineAt } : {}) }
}
export function checkInstructionsIssue(mutation?: InstructionsMutation) {
  if (!mutation) return
  mutation.check()
  if (mutation.signal?.aborted || mutation.deadlineAt !== undefined && (!Number.isFinite(mutation.deadlineAt) || mutation.deadlineAt <= Date.now())) throw new InstructionsConflictError()
}
/** Embedded in both actual ordinary sparse scripts before any operation is applied. */
export const CHECK_INSTRUCTIONS_LUA = `
if not instructions.clientBase then return 'INSTRUCTIONS_BASE_REQUIRED' end
if instructions.deadlineAt then
  local now = redis.call('TIME')
  if tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) >= instructions.deadlineAt then return 'INSTRUCTIONS_EXPIRED' end
end
for index, path in ipairs(instructions.paths) do
  if (redis.call('JSON.GET', KEYS[1], path) or '') ~= instructions.raw[index] then return 'INSTRUCTIONS_CHANGED' end
end
if instructions.authority then
  for _, pair in ipairs(instructions.authority.paths) do
    if (redis.call('JSON.GET', KEYS[instructions.authority.keyIndex], pair[1]) or '') ~= pair[2] then return 'INSTRUCTIONS_CHANGED' end
  end
end
`
