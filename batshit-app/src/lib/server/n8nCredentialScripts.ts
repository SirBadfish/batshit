/**
 * BL-1397: the two guarded writes of the n8n Instance MCP token, which lives in two owners: the
 * saved key `api_keys:{userId}:n8n_instance_mcp_token` (canonical) and, from older data, a copy in
 * an n8n Instance gateway's `metadata.authToken` in `mcp_gateways:{userId}`. Each script compares
 * the raw RedisJSON text of BOTH owners before it writes, so one decision covers both. A leaf with
 * no imports, so the default lane's twin (`test-utils/n8nCredentialScriptsTwin.ts`) reads answers
 * with the same functions. Server facade: `redis.json.moveLegacyN8nToken` / `deleteN8nToken`.
 *
 * Lua runs whole against other clients, but a command error does NOT undo the writes before it.
 * So both scripts read and check everything with `redis.call` first (an error there means nothing
 * was written), write with `redis.pcall`, check every answer, and order the writes so that a
 * failure part way keeps the canonical credential:
 * - the move writes the key FIRST (only into an absent key, `NX`), then removes the copy: a failure
 *   between them leaves the token in both owners, and the next move retires the copy;
 * - the delete removes the copies FIRST and the key LAST: a failure part way leaves the key saved.
 * A part-way failure is answered as `PARTIAL`, never as nothing written.
 */

/**
 * KEYS[1] the saved key, KEYS[2] the gateway registry. ARGV[1] the key's `$` text as read ('' when
 * absent), ARGV[2] the gateway's element path (`$.gateways[<n>]`), ARGV[3] that element's text as
 * read, ARGV[4] the new key document as JSON text, or '' to only retire the copy.
 */
export const MOVE_LEGACY_N8N_TOKEN_SCRIPT = `
local keyRaw = redis.call('JSON.GET', KEYS[1], '$')
if not keyRaw then keyRaw = '' end
if keyRaw ~= ARGV[1] then return {'CHANGED'} end
local element = redis.call('JSON.GET', KEYS[2], ARGV[2])
if not element then element = '' end
if element ~= ARGV[3] then return {'CHANGED'} end
local tokenPath = ARGV[2] .. '.metadata.authToken'
local types = redis.call('JSON.TYPE', KEYS[2], tokenPath)
if type(types) ~= 'table' or #types ~= 1 or types[1] ~= 'string' then return {'INVALID', 'copy'} end
if ARGV[4] ~= '' then
  if ARGV[1] ~= '' then return {'INVALID', 'key exists'} end
  local written = redis.pcall('JSON.SET', KEYS[1], '$', ARGV[4], 'NX')
  if type(written) ~= 'table' or written.ok ~= 'OK' then return {'FAILED', 'key'} end
end
local removed = redis.pcall('JSON.DEL', KEYS[2], tokenPath)
if removed ~= 1 then
  if ARGV[4] ~= '' then return {'PARTIAL', 'key written'} end
  return {'FAILED', 'copy'}
end
return {'OK'}
`

/**
 * KEYS[1] the saved key, KEYS[2] the gateway registry. ARGV[1] the key's `$` text as read ('' when
 * absent), ARGV[2] the WHOLE registry's `$` text as read ('' when absent), ARGV[3] a JSON list of
 * every copy path (`$.gateways[<n>].metadata.authToken`) planned from that registry text.
 */
export const DELETE_N8N_TOKEN_SCRIPT = `
local keyRaw = redis.call('JSON.GET', KEYS[1], '$')
if not keyRaw then keyRaw = '' end
if keyRaw ~= ARGV[1] then return {'KEY_CHANGED'} end
local registryRaw = redis.call('JSON.GET', KEYS[2], '$')
if not registryRaw then registryRaw = '' end
if registryRaw ~= ARGV[2] then return {'CHANGED'} end
local paths = cjson.decode(ARGV[3])
for _, path in ipairs(paths) do
  local types = redis.call('JSON.TYPE', KEYS[2], path)
  if type(types) ~= 'table' or #types ~= 1 or types[1] ~= 'string' then return {'INVALID', path} end
end
local cleared = 0
for _, path in ipairs(paths) do
  if redis.pcall('JSON.DEL', KEYS[2], path) ~= 1 then return {'PARTIAL', cleared} end
  cleared = cleared + 1
end
if ARGV[1] ~= '' then
  if redis.pcall('DEL', KEYS[1]) ~= 1 then return {'PARTIAL', cleared} end
end
return {'OK', cleared}
`

export type LegacyN8nTokenMoveAnswer =
  | { kind: 'ok' }
  | { kind: 'changed' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'failed'; step: 'key' | 'copy' }
  | { kind: 'partial_key_written' }

export type N8nTokenDeleteAnswer =
  | { kind: 'ok'; copiesCleared: number }
  | { kind: 'key_changed' }
  | { kind: 'changed' }
  | { kind: 'invalid'; path: string }
  | { kind: 'partial'; copiesCleared: number }

function tagOf(answer: unknown): [string, unknown] {
  if (!Array.isArray(answer) || typeof answer[0] !== 'string') return ['', undefined]
  return [answer[0], answer[1]]
}

/** What the move answered. Anything unknown throws, so no write is ever taken for one that happened. */
export function readLegacyN8nTokenMoveAnswer(answer: unknown): LegacyN8nTokenMoveAnswer {
  const [tag, detail] = tagOf(answer)
  if (tag === 'OK') return { kind: 'ok' }
  if (tag === 'CHANGED') return { kind: 'changed' }
  if (tag === 'INVALID' && typeof detail === 'string') return { kind: 'invalid', reason: detail }
  if (tag === 'FAILED' && (detail === 'key' || detail === 'copy')) return { kind: 'failed', step: detail }
  if (tag === 'PARTIAL') return { kind: 'partial_key_written' }
  throw new Error(`The n8n token move answered ${JSON.stringify(answer)}.`)
}

/** What the delete answered. Anything unknown throws. */
export function readN8nTokenDeleteAnswer(answer: unknown): N8nTokenDeleteAnswer {
  const [tag, detail] = tagOf(answer)
  if (tag === 'OK' && typeof detail === 'number') return { kind: 'ok', copiesCleared: detail }
  if (tag === 'KEY_CHANGED') return { kind: 'key_changed' }
  if (tag === 'CHANGED') return { kind: 'changed' }
  if (tag === 'INVALID' && typeof detail === 'string') return { kind: 'invalid', path: detail }
  if (tag === 'PARTIAL' && typeof detail === 'number') return { kind: 'partial', copiesCleared: detail }
  throw new Error(`The n8n token delete answered ${JSON.stringify(answer)}.`)
}
