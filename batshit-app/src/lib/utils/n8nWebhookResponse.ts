export function extractN8nWebhookError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const nested = extractN8nWebhookError(entry)
      if (nested) return nested
    }
    return null
  }

  const data = payload as Record<string, any>
  const type = typeof data.type === 'string' ? data.type.trim().toLowerCase() : ''
  if (type !== 'error') return null

  const directMessage =
    typeof data.error === 'string'
      ? data.error
      : typeof data.message === 'string'
        ? data.message
        : typeof data.details === 'string'
          ? data.details
          : ''

  const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : null
  const metadataMessage =
    typeof metadata?.error === 'string'
      ? metadata.error
      : typeof metadata?.message === 'string'
        ? metadata.message
        : typeof metadata?.description === 'string'
          ? metadata.description
          : ''

  const nodeName = typeof metadata?.nodeName === 'string' ? metadata.nodeName.trim() : ''
  const base = directMessage.trim() || metadataMessage.trim()
  if (base && nodeName) return `n8n workflow error in ${nodeName}: ${base}`
  if (base) return `n8n workflow error: ${base}`
  if (nodeName) return `n8n workflow error in ${nodeName}`
  return 'n8n workflow returned an error response'
}
