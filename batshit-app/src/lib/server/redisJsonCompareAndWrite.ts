/**
 * BL-1371: a compare-and-set on the raw RedisJSON text, the facade's `redis.json.setIfUnchanged`
 * and `delIfUnchanged` (`redis.ts`). A leaf with no imports, so the default lane's twin
 * (`test-utils/redisJsonCompareAndWriteTwin.ts`) reads answers with the same function.
 *
 * It writes only while `JSON.GET key path` still answers exactly the text the writer read with
 * `redis.json.getRaw`, so a write that landed in between is never overwritten and the writer
 * reads again. The text is RedisJSON's own serialization on both sides. A missing key answers
 * nil, compared as ''; a `$` path that matches nothing in an existing key answers `[]`.
 *
 * KEYS[1] the key. ARGV[1] 'SET' or 'DEL', ARGV[2] the path, ARGV[3] the text the writer read
 * ('' for a key that did not exist), ARGV[4] the new value as JSON text (SET only). One write
 * after the compare, so nothing is half written. Answers `CHANGED`; `OK` only when the write
 * reports success (`JSON.SET` answers the status `OK`, which Lua sees as a table with `ok`;
 * `JSON.DEL` answers the count 1); else `UNWRITTEN`.
 */
export const JSON_COMPARE_AND_WRITE_SCRIPT = `
local current = redis.call('JSON.GET', KEYS[1], ARGV[2])
if not current then current = '' end
if current ~= ARGV[3] then return 'CHANGED' end
if ARGV[1] == 'SET' then
  local written = redis.call('JSON.SET', KEYS[1], ARGV[2], ARGV[4])
  if type(written) == 'table' and written.ok == 'OK' then return 'OK' end
  return 'UNWRITTEN'
end
if ARGV[1] == 'DEL' then
  if redis.call('JSON.DEL', KEYS[1], ARGV[2]) == 1 then return 'OK' end
  return 'UNWRITTEN'
end
return redis.error_reply('Unknown compare-and-write operation')
`

export type JsonCompareAndWriteOperation = 'SET' | 'DEL'

/**
 * What the script answered: true when it wrote, false when the stored text changed. Anything
 * else throws, so a write that did not happen is never taken for one.
 */
export function readJsonCompareAndWriteAnswer(
  answer: unknown,
  operation: JsonCompareAndWriteOperation,
  key: string,
  path: string
): boolean {
  if (answer === 'OK') return true
  if (answer === 'CHANGED') return false
  throw new Error(`The compare-and-write ${operation} of ${key} at ${path} answered ${String(answer)}.`)
}

/** The value as the JSON text `json.set` sends; a value with no JSON text is refused. */
export function jsonTextOf(value: unknown): string {
  const text = JSON.stringify(value)
  if (typeof text !== 'string') throw new Error('The compare-and-write value has no JSON text.')
  return text
}
