import { LOCAL_AI_SERVER_IDS } from '$lib/data/localAiServers'

/**
 * SA-102 P6: derived, never hand-listed.
 *
 * This was a hardcoded five-id set and SA-102 grew the program list to seven,
 * so `sglang` and `omlx` silently classified as CLOUD here — no local image URL
 * rewriting through `imageBaseUrl`, and `shouldEnableTools` took the non-local
 * branch. Deriving from the definitions is the whole point of the "adding a
 * program is one row" rule; two copies had escaped it.
 */
const LOCAL_PROVIDER_IDS: ReadonlySet<string> = LOCAL_AI_SERVER_IDS

export type ImageTransportOverride = 'auto' | 'url'

export type LocalImageUrlRuntimeFailure = {
  code: string
  userMessage: string
}

export function isLocalProviderId(value: string | null | undefined): boolean {
  if (!value) return false
  return LOCAL_PROVIDER_IDS.has(value.toLowerCase())
}

export function rewriteLocalImageUrl(url: string, imageBaseUrl?: string | null): string {
  if (!imageBaseUrl) return url
  if (!url || !url.startsWith('http')) return url
  try {
    const parsed = new URL(url)
    const base = new URL(imageBaseUrl)
    const host = parsed.hostname.toLowerCase()
    const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
    const isLocalPath = parsed.pathname.startsWith('/uploads/')
    const baseHost = base.hostname.toLowerCase()
    if (!isLocalHost && host !== baseHost && !isLocalPath) {
      return url
    }
    return `${base.origin}${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

export function applyImageTransportOverrides(options: {
  messages: any[]
  images: Array<{ url: string }>
  clippedItems: any[]
  transport: ImageTransportOverride
  imageBaseUrl?: string | null
  preferRemoteUrl?: boolean
}): { messages: any[]; images: Array<{ url: string }> } {
  const { messages, images, clippedItems, transport, imageBaseUrl, preferRemoteUrl = false } = options

  if (transport === 'auto' && !preferRemoteUrl) {
    return { messages, images }
  }

  const replacements = new Map<string, string>()

  if (Array.isArray(clippedItems)) {
    for (const item of clippedItems) {
      if (!item || item.contentType !== 'image' || typeof item.content !== 'string') continue
      const original = item.content
      let next = original

      if (transport === 'url') {
        const candidate =
          typeof item.url === 'string' && item.url.startsWith('http')
            ? item.url
            : original
        next = rewriteLocalImageUrl(candidate, imageBaseUrl)
      } else if (preferRemoteUrl && isRemoteHttpImageUrl(item.url)) {
        next = item.url
      }

      if (next !== original) {
        replacements.set(original, next)
      }
    }
  }

  let nextMessages = messages
  let nextImages = images

  if (replacements.size > 0) {
    nextMessages = structuredClone(messages)
    nextImages = images.map((entry) => ({ ...entry }))

    for (const message of nextMessages) {
      if (!Array.isArray(message?.content)) continue
      for (const part of message.content) {
        if (part?.type === 'image_url' && part.image_url?.url && replacements.has(part.image_url.url)) {
          part.image_url.url = replacements.get(part.image_url.url)
        } else if (part?.type === 'image' && typeof part.image === 'string' && replacements.has(part.image)) {
          part.image = replacements.get(part.image)
        }
      }
    }

    for (const entry of nextImages) {
      if (entry?.url && replacements.has(entry.url)) {
        entry.url = replacements.get(entry.url) ?? entry.url
      }
    }
  }

  return { messages: nextMessages, images: nextImages }
}

function isRemoteHttpImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false

  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase()
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '::1'
  } catch {
    return false
  }
}

export function classifyLocalImageUrlRuntimeFailure(options: {
  errorMessage: string
  providerId?: string | null
  connectionId?: string | null
}): LocalImageUrlRuntimeFailure | null {
  const { errorMessage, providerId, connectionId } = options
  const normalized = errorMessage.toLowerCase()
  const connectionHint = (connectionId ?? '').toLowerCase()
  const providerHint = (providerId ?? '').toLowerCase()
  const isLocalRuntime =
    isLocalProviderId(providerHint) ||
    connectionHint.includes('ollama') ||
    connectionHint.includes('lmstudio') ||
    connectionHint.includes('llama-cpp') ||
    connectionHint.includes('vllm') ||
    connectionHint.includes('dmr')

  if (!isLocalRuntime) {
    return null
  }

  if (
    normalized.includes('image urls are not currently supported') ||
    normalized.includes('must be a base64 encoded image')
  ) {
    return {
      code: 'local_image_url_unsupported',
      userMessage:
        'This local runtime rejected image URLs for this model/API path. Switch the runtime or model to automatic image transport so Batshit can send structured base64 image inputs, or use a runtime/model path that supports URL image inputs.'
    }
  }

  if (normalized.includes('cannot make get request')) {
    return {
      code: 'local_image_url_unreachable',
      userMessage:
        'The local runtime could not fetch the image URL. Check the Local AI Image base URL so it is reachable from the runtime process (for Docker Desktop, use http://host.docker.internal:5600).'
    }
  }

  if (normalized.includes('https is not supported')) {
    return {
      code: 'local_image_https_unsupported',
      userMessage:
        'This local runtime build cannot fetch HTTPS image URLs. Use an HTTP-reachable Image base URL for this runtime or switch to a runtime build that supports HTTPS fetch.'
    }
  }

  if (normalized.includes('file:// urls are not allowed')) {
    return {
      code: 'local_image_file_url_blocked',
      userMessage:
        'The local runtime rejected file:// image URLs. Use an HTTP image URL via Batshit uploads and set Image base URL to a host the runtime can reach.'
    }
  }

  if (normalized.includes('invalid image url')) {
    return {
      code: 'local_image_url_invalid',
      userMessage:
        'The local runtime reported an invalid image URL. Check Image base URL, make sure the clip URL is complete, and confirm the runtime can reach that host.'
    }
  }

  return null
}
