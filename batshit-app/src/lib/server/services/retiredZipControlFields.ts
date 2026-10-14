import { redis } from '$lib/server/redis'

/**
 * SA-129 DL-06 (BL-1484, Josh 2026-10-13): the zip control permission is parked behind the hidden
 * `zip_agent_control_experiment` key, and its two older keys are retired. Josh is the only user and
 * there is no compatibility to keep, so startup removes them for real, not only ignores them:
 * `global_zip_settings.zip_agent_control_enabled` and `global_zip_settings.zip_control_mode` on every
 * `user:{userId}:settings` record, and `zip_agent_control_enabled` and `zip_control_mode` on every
 * `agent:{id}` and `subagent:{id}` record (the Subagent zip form once wired the old control too).
 * Most stored `true` values came from BL-231's first-save bug, not a choice.
 *
 * Each record is one atomic script of RedisJSON path deletes (never a whole-record write, so no
 * sibling field moves, and never node-redis `json.del(key, path)`, which can drop the whole document:
 * `.agents/memories/topics/redis-client-gotchas.md`). A key that is not a JSON document is left
 * alone. Idempotent: a second run finds nothing and changes nothing. A restored older backup is swept
 * on the next start. No new key, so backup and restore need nothing new.
 */

const RETIRED_FIELDS = ['zip_agent_control_enabled', 'zip_control_mode'] as const

const SETTINGS_PATHS = RETIRED_FIELDS.map((field) => `$.global_zip_settings.${field}`)
const AGENT_PATHS = RETIRED_FIELDS.map((field) => `$.${field}`)

/** Deletes each JSONPath in ARGV from the JSON document at KEYS[1]; answers how many values went. */
export const DELETE_RETIRED_JSON_FIELDS_SCRIPT = `
local kind = redis.call('TYPE', KEYS[1])
if type(kind) == 'table' then kind = kind['ok'] end
if kind ~= 'ReJSON-RL' then return 0 end
local removed = 0
for i = 1, #ARGV do
  removed = removed + redis.call('JSON.DEL', KEYS[1], ARGV[i])
end
return removed
`

async function deleteRetiredPaths(key: string, paths: readonly string[]): Promise<number> {
  const answer = await redis.execute((client) =>
    client.eval(DELETE_RETIRED_JSON_FIELDS_SCRIPT, { keys: [key], arguments: [...paths] })
  )
  const removed = Number(answer)
  if (!Number.isInteger(removed) || removed < 0) {
    throw new Error(`The retired zip control sweep of ${key} answered ${String(answer)}.`)
  }
  return removed
}

/** An agent record is `agent:{id}` (a Subagent's `subagent:{id}`); longer keys belong to other families. */
const AGENT_RECORD_KEY = /^agent:[^:]+$/
const SUBAGENT_RECORD_KEY = /^subagent:[^:]+$/

export async function removeRetiredZipControlFields(): Promise<{ records: number; fields: number }> {
  let records = 0
  let fields = 0
  const settingsKeys = (await redis.keys('user:*:settings')).filter((key) => /^user:[^:]+:settings$/.test(key)).sort()
  const agentKeys = (await redis.keys('agent:*')).filter((key) => AGENT_RECORD_KEY.test(key)).sort()
  const subagentKeys = (await redis.keys('subagent:*')).filter((key) => SUBAGENT_RECORD_KEY.test(key)).sort()
  for (const [keys, paths] of [[settingsKeys, SETTINGS_PATHS], [agentKeys, AGENT_PATHS], [subagentKeys, AGENT_PATHS]] as const) {
    for (const key of keys) {
      const removed = await deleteRetiredPaths(key, paths)
      if (removed > 0) {
        records += 1
        fields += removed
      }
    }
  }
  if (fields > 0) {
    console.info(`[Startup] Removed ${fields} retired zip control field(s) from ${records} record(s) (BL-1484).`)
  }
  return { records, fields }
}
