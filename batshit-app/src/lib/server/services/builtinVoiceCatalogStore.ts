import { BuiltinVoiceCatalogError, type VoiceCatalogRead } from '$lib/utils/builtinVoiceCatalog'

export const GLOBAL_VOICE_CATALOG_KEY = 'voice-model-catalog:v1'
export const LOCAL_VOICE_CATALOG_KEY = 'voice:model_catalog:v1'

/** These two public derived keys deliberately use raw STRINGs, outside the JSON facade. */
export interface VoiceCatalogStringStore {
  read(): Promise<VoiceCatalogRead>
  compareAndSet(expectedRaw: string | null, nextRaw: string): Promise<boolean>
}

export const VOICE_CATALOG_STRING_CAS = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind ~= 'none' and kind ~= 'string' then return 'UNREADABLE' end
local current = redis.call('GET', KEYS[1])
if ARGV[1] == 'absent' then
  if current then return 'CHANGED' end
elseif current ~= ARGV[2] then return 'CHANGED' end
local written = redis.call('SET', KEYS[1], ARGV[3])
if type(written) == 'table' and written.ok == 'OK' then return 'OK' end
return 'UNCONFIRMED'
`

interface StringClient {
  type(key: string): Promise<string>
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

/** No connection/default client is created. Caller owns the existing Redis execution boundary. */
export function createLocalVoiceCatalogStore(execute: <T>(operation: (client: StringClient) => Promise<T>) => Promise<T>): VoiceCatalogStringStore {
  return {
    read: () => execute(async client => {
      const kind = await client.type(LOCAL_VOICE_CATALOG_KEY)
      if (kind === 'none') return { state: 'absent' } as const
      if (kind !== 'string') throw new BuiltinVoiceCatalogError('cache_storage_type')
      const raw = await client.get(LOCAL_VOICE_CATALOG_KEY)
      // Disappearance/type drift during the read is unavailable, never first-install authority.
      if (typeof raw !== 'string') throw new BuiltinVoiceCatalogError('cache_raw_unavailable')
      return { state: 'present', raw } as const
    }),
    compareAndSet: (expectedRaw, nextRaw) => execute(async client => {
      const result = await client.eval(VOICE_CATALOG_STRING_CAS, { keys: [LOCAL_VOICE_CATALOG_KEY],
        arguments: [expectedRaw === null ? 'absent' : 'present', expectedRaw ?? '', nextRaw] })
      if (result === 'OK') return true
      if (result === 'CHANGED') return false
      throw new BuiltinVoiceCatalogError(result === 'UNREADABLE' ? 'cache_storage_type' : 'cache_write_unconfirmed')
    })
  }
}
