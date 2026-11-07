import { TYPED_FILE_TOOLS_REVISION_HEADER } from '$lib/utils/typedFileToolsSave'
export { TYPED_FILE_TOOLS_REVISION_HEADER }
import { createHash } from 'node:crypto'
import { PRIMARY_AGENT_TYPE_SOURCE_FIELDS } from '$lib/utils/primaryAgentType'
import { assertSettingsLifecycle, captureSettingsLifecycle, type SettingsLifecycleSnapshot } from './services/appActions/settings/lifecycle'
import { readModelSelectionSnapshot } from './modelSelectionGuard'
const GRANT_PATH = '$.provider_specific_settings.nativeTools.typedFileToolsEnabled'
export type TypedToolsKind = 'agent' | 'subagent'
export type TypedToolsRawGuard = { paths: readonly string[]; raw: readonly string[] }
export type TypedToolsSnapshot = TypedToolsRawGuard & { revision: string; value: boolean; lifecycle: SettingsLifecycleSnapshot }
export class TypedToolsBaseRequiredError extends Error {
  readonly status = 400; readonly code = 'typed_file_tools_base_required'
  constructor() { super('Read the saved Typed File Tools choice before changing it. Nothing was saved.') }
}
export class TypedToolsConflictError extends Error {
  readonly status = 409; readonly code = 'typed_file_tools_changed'
  constructor() { super('The saved Typed File Tools choice changed. Your draft is kept; read the saved choice before trying again. Nothing was saved.') }
}
export class TypedToolsSaveUnconfirmedError extends Error {
  readonly status = 503; readonly code = 'typed_file_tools_save_unconfirmed'
  constructor() { super('The Typed File Tools save was issued but its outcome is unconfirmed. Do not repeat it automatically.') }
}
export function namesTypedFileToolsWrite(updates: Record<string, unknown>): boolean {
  const provider = updates.provider_specific_settings as any
  return !!provider && typeof provider === 'object' && !Array.isArray(provider) && !!provider.nativeTools &&
    typeof provider.nativeTools === 'object' && !Array.isArray(provider.nativeTools) && Object.hasOwn(provider.nativeTools, 'typedFileToolsEnabled')
}
export function requireTypedToolsExpected(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypedToolsBaseRequiredError()
}
export function typedToolsReadPaths(kind: TypedToolsKind): string[] {
  return [...new Set(['id', 'user_id', 'created_at', ...(kind === 'agent' ? PRIMARY_AGENT_TYPE_SOURCE_FIELDS :
    ['subagentType', 'subagent_type', 'workflowName', 'workflow_name', 'webhookUrl', 'webhook_url'])])].map(field => `$.${field}`).concat(GRANT_PATH)
}
/** Only the actual atomic detail/read owner supplies these original fixed-path bytes. */
export function makeTypedToolsSnapshot(id: string, kind: TypedToolsKind, raw: readonly string[], lifecycle: SettingsLifecycleSnapshot, knownAck = false): TypedToolsSnapshot {
  if (!knownAck) assertSettingsLifecycle(lifecycle)
  const paths = typedToolsReadPaths(kind)
  if (paths.length !== raw.length || raw.some(value => typeof value !== 'string')) throw new TypedToolsConflictError()
  const stored = raw.map(value => {
    const values: unknown = JSON.parse(value || '[]')
    if (!Array.isArray(values) || values.length > 1) throw new TypedToolsConflictError()
    return values[0]
  })
  if (stored[0] !== id || typeof stored[1] !== 'string' || typeof stored.at(-1) !== 'boolean') throw new TypedToolsConflictError()
  return { paths, raw: [...raw], lifecycle, value: stored.at(-1) as boolean,
    revision: `sha256:${createHash('sha256').update(JSON.stringify({ id, kind, raw, lifecycle })).digest('hex')}` }
}
export async function readTypedToolsSnapshot(client: Parameters<typeof readModelSelectionSnapshot>[0], id: string, kind: TypedToolsKind,
  lifecycle = captureSettingsLifecycle([`${kind}:${id}`])): Promise<TypedToolsSnapshot> {
  const source = await readModelSelectionSnapshot(client, id, kind, lifecycle, typedToolsReadPaths(kind), { typeFenceOnly: true, reportProjection: true })
  return makeTypedToolsSnapshot(id, kind, source.extraRaw, lifecycle)
}
export function typedToolsWriteGuard(snapshot: TypedToolsSnapshot, expected: unknown): TypedToolsRawGuard {
  requireTypedToolsExpected(expected); assertSettingsLifecycle(snapshot.lifecycle)
  if (expected !== snapshot.revision) throw new TypedToolsConflictError()
  return { paths: snapshot.paths, raw: snapshot.raw }
}
/** Shared by both actual sparse writers, before any operation or timestamp is applied. */
export const CHECK_TYPED_TOOLS_LUA = `
local namesTypedTools = false
for _, op in ipairs(cjson.decode(ARGV[1])) do
  if op[2] == '$.provider_specific_settings["nativeTools"]["typedFileToolsEnabled"]' then namesTypedTools = true end
end
if namesTypedTools and not typedTools then return 'TYPED_TOOLS_BASE_REQUIRED' end
if typedTools then
  for index, path in ipairs(typedTools.paths) do
    if (redis.call('JSON.GET', KEYS[1], path) or '') ~= typedTools.raw[index] then return 'TYPED_TOOLS_CHANGED' end
  end
end
`
