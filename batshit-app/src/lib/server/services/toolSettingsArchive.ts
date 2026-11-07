import { isExactSavedAccessAgentId } from '$lib/utils/agentAccessIds'
import { materializedToolSettingsProvider, planTypedFileToolsGrantMaterialization,
  type TypedFileToolsGlobalSnapshot } from '$lib/utils/toolSettingsMigration'

type ArchiveRecord = { key: string; type: string; value: unknown }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Transform ONLY the validated remapped archive postimage, never live or rollback sources. */
export function materializeArchiveToolSettings<T extends ArchiveRecord>(records: readonly T[], userId: string): T[] {
  const settingsKey = `user:${userId}:settings`
  const settingsRecords = records.filter(record => record.key === settingsKey)
  if (settingsRecords.length > 1 || settingsRecords.some(record => record.type !== 'json' || !object(record.value) || record.value.user_id !== userId)) {
    throw new Error('The archive tool-settings source is malformed. Restore did not publish its records.')
  }
  const settings = settingsRecords[0]?.value as Record<string, unknown> | undefined
  const global: TypedFileToolsGlobalSnapshot = settings && Object.hasOwn(settings, 'global_tool_grid_settings')
    ? { kind: 'known', value: settings.global_tool_grid_settings } : { kind: 'absent' }
  // Validate even a zero-agent archive before dropping its inherited source.
  planTypedFileToolsGrantMaterialization(null, global)
  const subjects = new Set<string>()
  for (const [index, prefix] of [['agents', 'agent'], ['subagents', 'subagent']] as const) {
    const matches = records.filter(record => record.key === `user:${userId}:${index}`)
    if (matches.length > 1 || matches.some(record => record.type !== 'set' || !Array.isArray(record.value) ||
        record.value.some(id => !isExactSavedAccessAgentId(id)) || new Set(record.value).size !== record.value.length)) {
      throw new Error('The archive subject inventory is malformed. Restore did not publish its records.')
    }
    for (const id of (matches[0]?.value ?? []) as string[]) subjects.add(`${prefix}:${id}`)
  }
  for (const key of subjects) {
    if (records.filter(record => record.key === key).length !== 1) throw new Error('An expected archive subject is missing. Restore did not publish its records.')
  }
  return records.map(record => {
    if (!subjects.has(record.key) && /^(agent|subagent):[^:]+$/.test(record.key)) {
      throw new Error('An archive subject is outside its inventory. Restore did not publish its records.')
    }
    if (subjects.has(record.key)) {
      if (record.type !== 'json' || !object(record.value) || record.value.user_id !== userId ||
          record.key.slice(record.key.indexOf(':') + 1) !== record.value.id) {
        throw new Error('An archive tool-settings subject is malformed. Restore did not publish its records.')
      }
      return { ...record, value: { ...record.value,
        provider_specific_settings: materializedToolSettingsProvider(record.value.provider_specific_settings, global) } }
    }
    if (record.key === settingsKey && settings && object(settings.global_tool_grid_settings)) {
      const grid = { ...settings.global_tool_grid_settings }
      delete grid.typed_file_tools
      return { ...record, value: { ...settings, global_tool_grid_settings: grid } }
    }
    return record
  })
}
