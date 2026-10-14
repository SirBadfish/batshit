import { redis } from '$lib/server/redis'
import { AbortError } from 'redis'
import { createConditionalSettingsStore, createOwnAgentSettingsExecutors } from './conditionalAgentSettings'
import { createSettingsInspector } from './inspection'
import { refuseSettings } from '$lib/appActions/settings/validation'

export const ownAgentSettings = createOwnAgentSettingsExecutors(createConditionalSettingsStore(operation => redis.execute(operation), error => error instanceof AbortError))

export const inspectSettings = createSettingsInspector({
  readMemory: ownAgentSettings.readMemory,
  async readUserSettings(userId) {
    const value = await redis.json.get(`user:${userId}:settings`)
    if (value === null) return null // A successful absent row, not a failed read.
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.user_id !== userId) refuseSettings('settings_record_not_owned')
    return value
  },
  async readAgent(subjectAgentId, userId) {
    const value = await redis.json.get(`agent:${subjectAgentId}`)
    if (!value || value.id !== subjectAgentId || value.user_id !== userId) refuseSettings('agent_not_owned')
    if (value.agentType !== 'api' && value.agentType !== 'cli') refuseSettings('unsupported_primary_agent')
    if (typeof value.displayName !== 'string') refuseSettings('display_name_unavailable')
    return { displayName: value.displayName, agentType: value.agentType }
  },
  async countEntities(tab, userId) {
    return redis.execute(async client => {
      // The owning source formats are fixed. This does not enumerate arbitrary
      // keys, interpret a requested path, or return a library's record bodies.
      let keys: string[]
      if (tab === 'projects') {
        keys = []
        for await (const batch of client.scanIterator({ MATCH: `project:${userId}:*`, COUNT: 200 })) {
          keys.push(...batch)
          if (keys.length > 1000) throw new Error('Settings project inspection limit exceeded.')
        }
      } else {
        const kind = tab === '3d-goons' ? 'goons' : tab
        const prefix = { groups: 'group', models: 'model', artifacts: 'artifact', goons: 'goon' }[kind]
        if (!prefix) throw new Error('Unsupported Settings inventory.')
        const ids = await client.sMembers(`user:${userId}:${kind}`)
        if (ids.length > 1000) throw new Error('Settings library inspection limit exceeded.')
        keys = ids.map(id => `${prefix}:${id}`)
      }
      let count = 0
      for (const key of keys) {
        const record = await client.json.get(key)
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Settings inventory has an unavailable record.')
        // Saved Model ownership is its canonical per-user index; its record
        // shape has no user_id. Other owners retain user_id on each record.
        if (tab !== 'models' && (record as Record<string, unknown>).user_id !== userId) throw new Error('Settings inventory ownership mismatch.')
        count += 1
      }
      return count
    })
  }
})
