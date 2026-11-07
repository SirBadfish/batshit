import type { SavedModel } from '$lib/types/savedModels'
import { findSettingsVoicePresetFallback, findChatVoicePresetFallback, resolveModelVoiceSessionConfig, type AgentVoicePresetSelection } from '$lib/utils/modelVoiceSession'
import { assertSettingsLifecycle, captureSettingsLifecycle } from '$lib/server/services/appActions/settings/lifecycle'
import type { TtsSourceGuard } from './configuredTtsGuard'
import { validTtsId } from '$lib/appActions/settings/configuredTtsPreferences'

/** Fixed read-only cut shared by configured Voice reports and the physical human lock guard.
 * The caller supplies its actual client; this module imports no Redis service, keys or catalog owner. */
export type VoiceModelSourceClient = { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> }
type ModelVoiceSourceCheck = { key: string; paths: readonly (readonly [string, string])[] }
export class ModelVoiceSourceUnavailableError extends Error { readonly status = 409; readonly code = 'tts_model_selection_unavailable'; constructor(message = 'Selected model source is unavailable.') { super(message) } }
function exactId(value: string) {
  if (typeof value !== 'string' || !value.length || !value.isWellFormed() || value.includes('\0')) throw new ModelVoiceSourceUnavailableError()
  return value
}

export async function readOwnedVoicePresetFallbackSources(client: VoiceModelSourceClient, userId: string, selection: AgentVoicePresetSelection, exactPresetId?: string) {
  const indexKey = `user:${userId}:models`
  const inventory = exactPresetId ? ['OK', exactId(exactPresetId)] : await client.eval(`
-- fixed-voice-model-index-source
local count = redis.call('SCARD', KEYS[1]); if count > 256 then return {'LIMIT'} end
local ids = redis.call('SMEMBERS', KEYS[1]); table.sort(ids); local out = {'OK'}
for _, id in ipairs(ids) do if string.len(id) > 256 then return {'INVALID'} end; out[#out+1] = id end
return out`, { keys: [indexKey], arguments: [] })
  if (!Array.isArray(inventory) || inventory[0] !== 'OK' || inventory.slice(1).some(id => typeof id !== 'string')) throw new ModelVoiceSourceUnavailableError('Saved model fallback source is unavailable.')
  const ids = inventory.slice(1) as string[]
  const lifecycle = captureSettingsLifecycle(ids.map(id => `model:${id}`)), candidates: SavedModel[] = [], checks: ModelVoiceSourceCheck[] = []
  const fields = ['id', 'provider', 'modelId', 'effectiveModelId', 'connection.id', 'connection.type', 'connection.service', 'isVercelImport',
    ...['runtime', 'mode', 'providerId', 'locksVoiceModeSettings'].map(field => `voiceSession.${field}`),
    ...['runtime', 'mode', 'providerId', 'locksVoiceModeSettings'].map(field => `settings.voiceSession.${field}`)]
  const answer = await client.eval(`
-- fixed-voice-model-record-source
local ids = cjson.decode(ARGV[1]); local paths = cjson.decode(ARGV[2])
if ARGV[3] ~= '1' and redis.call('SCARD', KEYS[1]) ~= #ids then return {'CHANGED'} end
local out = {'OK'}; local bytes = 0
for index, id in ipairs(ids) do
  if redis.call('SISMEMBER', KEYS[1], id) ~= 1 then return {'CHANGED'} end
  local shape = redis.pcall('JSON.TYPE', KEYS[index+1], '$')
  if type(shape) ~= 'table' or shape.err or shape[1] ~= 'object' then return {'INVALID'} end
  for _, path in ipairs(paths) do
    local raw = redis.call('JSON.GET', KEYS[index+1], path) or '[]'; bytes = bytes + string.len(raw)
    if string.len(raw) > 16384 or bytes > 262144 then return {'LIMIT'} end
    out[#out+1] = raw
  end
  local connection = redis.call('JSON.TYPE', KEYS[index+1], '$.connection'); out[#out+1] = connection and connection[1] or ''
end
return out`, { keys: [indexKey, ...ids.map(id => `model:${id}`)], arguments: [JSON.stringify(ids), JSON.stringify(fields.map(field => `$.${field}`)), exactPresetId ? '1' : '0'] })
  assertSettingsLifecycle(lifecycle)
  if (!Array.isArray(answer) || answer[0] !== 'OK' || answer.length !== 1 + ids.length * (fields.length + 1) || answer.slice(1).some(raw => typeof raw !== 'string')) throw new ModelVoiceSourceUnavailableError('Saved model fallback source is unavailable.')
  const identity = new Set(['$.id', '$.provider', '$.modelId', '$.effectiveModelId', '$.connection.id', '$.connection.type', '$.connection.service', '$.isVercelImport'])
  const typeChecks: Array<{ key: string; typePath: string; type: string }> = []
  for (const [index, id] of ids.entries()) {
    const raw = fields.map((_, fieldIndex) => answer[1 + index * (fields.length + 1) + fieldIndex] as string)
    const values = raw.map(raw => { const value: unknown = JSON.parse(raw); if (!Array.isArray(value) || value.length > 1) throw new ModelVoiceSourceUnavailableError(); return value[0] })
    if (values[0] !== id || typeof values[1] !== 'string' || typeof values[2] !== 'string' || values[3] != null && typeof values[3] !== 'string') throw new ModelVoiceSourceUnavailableError('Saved model fallback identity is unreadable.')
    const connectionType = answer[1 + index * (fields.length + 1) + fields.length] as string
    const model = { id, modelName: id, provider: values[1], modelId: values[2], effectiveModelId: values[3], isVercelImport: values[7],
      ...(connectionType === '' || connectionType === 'null' ? {} : { connection: { id: values[4], type: values[5], service: values[6] } }),
      voiceSession: Object.fromEntries(['runtime', 'mode', 'providerId', 'locksVoiceModeSettings'].map((field, offset) => [field, values[8 + offset]])),
      settings: { voiceSession: Object.fromEntries(['runtime', 'mode', 'providerId', 'locksVoiceModeSettings'].map((field, offset) => [field, values[12 + offset]])) } } as unknown as SavedModel
    const potential = Boolean(exactPresetId || findSettingsVoicePresetFallback([model], { ...selection, primary_model_connection: null }) || findChatVoicePresetFallback([model], selection))
    if (potential && !['', 'null', 'object'].includes(connectionType)) throw new ModelVoiceSourceUnavailableError('Saved model connection shape is unreadable.')
    const matches = Boolean(exactPresetId || findSettingsVoicePresetFallback([model], selection) || findChatVoicePresetFallback([model], selection))
    if (matches && values.some((value, offset) => value != null && (offset === 7 || offset === 11 || offset === 15 ? typeof value !== 'boolean' : typeof value !== 'string'))) throw new ModelVoiceSourceUnavailableError('Saved model voice metadata is unreadable.')
    if (matches) candidates.push(model)
    checks.push({ key: `model:${id}`, paths: fields.flatMap((field, fieldIndex) => identity.has(`$.${field}`) || matches ? [[`$.${field}`, raw[fieldIndex]] as const] : []) })
    typeChecks.push({ key: `model:${id}`, typePath: '$.connection', type: connectionType })
  }
  return { indexKey, ids, candidates, checks, typeChecks, lifecycle }
}

export async function readAgentVoiceModelLockSource(client: VoiceModelSourceClient, userId: string, id: string, postimage: Readonly<Record<string, unknown>> = {}) {
  const key = `agent:${id}`, lifecycle = captureSettingsLifecycle([key])
  const fields = ['id', 'user_id', 'primary_model_preset_id', 'primary_model_provider', 'primary_model_name',
    'primary_model_connection.id', 'primary_model_connection.type', 'primary_model_connection.service']
  const answer = await client.eval(`
-- fixed-agent-voice-model-source
local out = {'OK'}
for _, path in ipairs(cjson.decode(ARGV[1])) do
  local raw = redis.call('JSON.GET', KEYS[1], path) or '[]'
  if string.len(raw) > 16384 then return {'INVALID'} end
  out[#out+1] = raw
end
local connection = redis.call('JSON.TYPE', KEYS[1], '$.primary_model_connection')
out[#out+1] = connection and connection[1] or ''
return out`, { keys: [key], arguments: [JSON.stringify(fields.map(field => `$.${field}`))] })
  assertSettingsLifecycle(lifecycle)
  if (!Array.isArray(answer) || answer[0] !== 'OK' || answer.length !== fields.length + 2 || answer.slice(1).some(value => typeof value !== 'string')) throw new ModelVoiceSourceUnavailableError()
  const raw = answer.slice(1, -1) as string[], values = raw.map(raw => {
    const values: unknown = JSON.parse(raw)
    if (!Array.isArray(values) || values.length > 1) throw new ModelVoiceSourceUnavailableError()
    return values[0]
  })
  const storedConnectionType = answer.at(-1) as string
  if (values[0] !== id || values[1] !== userId) throw new ModelVoiceSourceUnavailableError()
  const resulting = { primary_model_preset_id: values[2], primary_model_provider: values[3], primary_model_name: values[4],
    primary_model_connection: storedConnectionType === 'object' ? { id: values[5], type: values[6], service: values[7] } : storedConnectionType === '' || storedConnectionType === 'null' ? null : false } as Record<string, unknown>
  for (const field of Object.keys(resulting)) if (Object.hasOwn(postimage, field)) resulting[field] = postimage[field]
  if (resulting.primary_model_preset_id != null && typeof resulting.primary_model_preset_id !== 'string') throw new ModelVoiceSourceUnavailableError()
  const optionalPresetId = typeof resulting.primary_model_preset_id === 'string' ? resulting.primary_model_preset_id.trim() : ''
  if (optionalPresetId && !validTtsId(optionalPresetId)) throw new ModelVoiceSourceUnavailableError()
  const connection = resulting.primary_model_connection
  if (!optionalPresetId && ([resulting.primary_model_provider, resulting.primary_model_name].some(value => value != null && typeof value !== 'string') ||
    connection != null && (typeof connection !== 'object' || Array.isArray(connection)) || connection && ['id', 'type', 'service'].some(field => {
      const value = (connection as Record<string, unknown>)[field]; return value != null && typeof value !== 'string'
    }))) throw new ModelVoiceSourceUnavailableError()
  const guards: TtsSourceGuard[] = fields.flatMap((field, index) => !optionalPresetId || index < 3 ? [{ key, path: `$.${field}`, raw: raw[index] }] : [])
  if (!optionalPresetId) guards.push({ key, typePath: '$.primary_model_connection', type: storedConnectionType })
  const selection = resulting as AgentVoicePresetSelection
  let locked = false
  const dependencies = [lifecycle]
  if (optionalPresetId || String(selection.primary_model_provider ?? '').trim() || String(selection.primary_model_name ?? '').trim()) {
    const source = await readOwnedVoicePresetFallbackSources(client, userId, selection, optionalPresetId || undefined)
    dependencies.push(source.lifecycle)
    guards.push(optionalPresetId ? { key: source.indexKey, member: optionalPresetId, present: true } : { key: source.indexKey, members: source.ids }, ...source.typeChecks)
    for (const check of source.checks) for (const [path, raw] of check.paths) guards.push({ key: check.key, path, raw: raw || '[]' })
    if (optionalPresetId) locked = Boolean(resolveModelVoiceSessionConfig(source.candidates[0])?.locksVoiceModeSettings)
    else {
      const settings = source.candidates.filter(model => findSettingsVoicePresetFallback([model], selection))
      const chat = source.candidates.filter(model => findChatVoicePresetFallback([model], selection))
      const truth = [...settings.map(model => Boolean(resolveModelVoiceSessionConfig(model)?.locksVoiceModeSettings)),
        ...chat.map(model => Boolean(resolveModelVoiceSessionConfig(model)?.locksVoiceModeSettings)), ...(!settings.length || !chat.length ? [false] : [])]
      if (truth.includes(true) && truth.includes(false)) throw new ModelVoiceSourceUnavailableError('tts_model_lock_ambiguous')
      locked = truth.includes(true)
    }
  }
  dependencies.forEach(assertSettingsLifecycle)
  return { locked, guards, lifecycle: { epoch: lifecycle.epoch, records: dependencies.flatMap(value => value.records) } }
}

