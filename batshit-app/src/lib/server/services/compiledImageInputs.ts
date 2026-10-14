/**
 * BL-504: the image inputs a compiled turn carries, which decide both whether a text-only model
 * is refused (422, "remove the image clip") and which URLs the API lane sends as image parts.
 *
 * A Clip counts only when the compiler marked it an image (`contentType === 'image'`); a PDF,
 * video, or document Clip carries its URL as `content` too, and once counted as an image because
 * it starts with `http`. The compiled message's own `image_url` parts count as well (the
 * compiler adds one for every image Clip and every remembered image).
 */
export type CompiledImageInput = { url: string }

function isImageUrl(candidate: unknown): candidate is string {
  return (
    typeof candidate === 'string' && (candidate.startsWith('http') || candidate.startsWith('data:'))
  )
}

export function collectCompiledImageInputs(structuredInput: unknown): CompiledImageInput[] {
  const input = (structuredInput ?? {}) as { clippedItems?: unknown; messages?: unknown }
  const urls = new Set<string>()

  const clipped = Array.isArray(input.clippedItems) ? input.clippedItems : []
  for (const item of clipped as any[]) {
    if (item?.contentType !== 'image') continue
    const candidate = (typeof item.content === 'string' ? item.content : null) || item.url || null
    if (isImageUrl(candidate)) urls.add(candidate)
  }

  const messages = Array.isArray(input.messages) ? input.messages : []
  for (const message of messages as any[]) {
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content) {
      const candidate = part?.image_url?.url || part?.image
      if (isImageUrl(candidate)) urls.add(candidate)
    }
  }

  return Array.from(urls).map((url) => ({ url }))
}
