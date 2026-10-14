import { getInternalBatshitServerApiUrl, getInternalBatshitServerAuthHeaders } from './batshitServerUrls'

export type RegisteredKoboldSetup = {
  registrationId: string
  generationId: string
  createdAt: string
  models: { id: string; nativeRef: string; servedName: string; baseConfig: string }[]
}
export const managedProfileId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v)

/** Session owner supplies userId, saved endpoint supplies endpoint. No browser paths. */
export async function managedProfileHelper<T>(action: 'list' | 'validate' | 'prepare' | 'verify' | 'revoke' | 'fence-restore' | 'revoke-owner', input: {
  userId: string; endpoint?: string; registrationId?: string; modelId?: string; contextTokens?: number; artifactId?: string; operationId?: string; requireState?: boolean
}): Promise<T> {
  const response = await fetch(`${getInternalBatshitServerApiUrl()}/local-ai-managed-profiles/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...getInternalBatshitServerAuthHeaders() },
    body: JSON.stringify(input), signal: AbortSignal.timeout(20_000)
  })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The local context helper returned no answer.')
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > 32768) {
      await reader.cancel()
      throw new Error('The local context helper returned an oversized answer.')
    }
    chunks.push(next.value)
  }
  const bytes = Buffer.concat(chunks).toString('utf8')
  const result = JSON.parse(bytes)
  if (!response.ok || result.success !== true) throw Object.assign(new Error(result.message ?? 'The local context helper refused the request.'), { partial: result.partial === true })
  return result as T
}
