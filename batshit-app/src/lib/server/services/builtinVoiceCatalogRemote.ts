import { BuiltinVoiceCatalogError } from '$lib/utils/builtinVoiceCatalog'
import { readVoiceSourceBody, VOICE_SOURCE_HTTP_CONTRACTS } from './builtinVoiceCatalogSourceHttp'

export const PUBLIC_VOICE_CATALOG_URL = VOICE_SOURCE_HTTP_CONTRACTS.installedCatalog.url

/** Fixed public data GET only. The same 5s AbortSignal covers headers and streamed body. */
export async function fetchPublicVoiceCatalog(http: typeof fetch): Promise<string> {
  const result = await readVoiceSourceBody('installedCatalog', http)
  if (result.kind !== 'body') throw new BuiltinVoiceCatalogError(`public_read_${result.reason}`)
  return result.body
}
