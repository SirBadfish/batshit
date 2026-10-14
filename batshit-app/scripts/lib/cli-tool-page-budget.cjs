/** Fit a server-identified content page after helper formatting, before final MCP delivery. */
// A page stays within the guard's model-text limit on every lane (BL-676), so no guard cuts it:
// the Claude lane has no byte budget, and still gets a fitted page. 96,000 characters is the
// guard's own ceiling (BL-677, toolModelTextSizeGuard.ts).
const PAGE_MAX_CHARS = 96_000

function safeEnd(text, end) {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) return end - 1
  return end
}

function fitToolPagePayload(payload, kind, budget) {
  if (!['fetch-zip', 'skill-read'].includes(kind)) return payload
  const byteBudget = budget && Number.isSafeInteger(budget.maxUtf8Bytes) && budget.maxUtf8Bytes >= 0
    ? Math.min(300_000, budget.maxUtf8Bytes)
    : undefined
  const fits = value => {
    const encoded = JSON.stringify(value, null, 2)
    return encoded.length <= PAGE_MAX_CHARS &&
      (byteBudget === undefined || Buffer.byteLength(encoded, 'utf8') <= byteBudget)
  }
  if (fits(payload)) return payload
  // Only server-authored envelopes of these two paginated tools are followed.
  let node = payload
  const keys = []
  for (let depth = 0; depth < 3 && node && typeof node === 'object' && typeof node.content !== 'string'; depth++) {
    const key = node.result && typeof node.result === 'object' ? 'result' :
      node.data && typeof node.data === 'object' ? 'data' : null
    if (!key) break
    keys.push(key)
    node = node[key]
  }
  if (!node || typeof node.content !== 'string' || node.success === false || node.found === false) return payload
  const original = node.content
  const offset = Number.isSafeInteger(node.offset) && node.offset >= 0 ? node.offset : 0
  const total = kind === 'fetch-zip' ? node.totalLength ?? node.contentLength : node.originalChars
  if (!Number.isSafeInteger(total) || total < offset + original.length) return payload

  const limit = byteBudget !== undefined
    ? `${byteBudget} UTF-8 bytes (${budget.source})`
    : `one result (${PAGE_MAX_CHARS} characters)`
  const make = end => {
    const next = offset + end < total ? offset + end : null
    const readMore = next === null ? 'This is the end of the content.' : kind === 'fetch-zip'
      ? `Call Fetch Zip with zipId ${node.zipId} and offset ${next} to read the next part.`
      : `Call native_skill with skillId ${JSON.stringify(node.skillId)}, action "read", path ${JSON.stringify(node.path)}, and offset ${next}.`
    const part = {
      ...node, content: original.slice(0, end), offset, nextOffset: next,
      ...(Object.hasOwn(node, 'returnedChars') ? { returnedChars: end } : {}),
      ...(Object.hasOwn(node, 'truncated') ? { truncated: next !== null } : {}),
      ...(Object.hasOwn(node, 'contentTruncated') ? { contentTruncated: next !== null } : {}),
      readMore: `This page fits ${limit}. ${readMore}`
    }
    const replace = (value, depth) => depth === keys.length ? part :
      { ...value, [keys[depth]]: replace(value[keys[depth]], depth + 1) }
    return replace(payload, 0)
  }
  if (!fits(make(0))) {
    // Never announce a false next offset or silently discard oversized metadata.
    return { success: false, error: 'Page metadata does not fit this run’s tool output limit. Request a smaller source.' }
  }
  let low = 0
  let high = original.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(make(safeEnd(original, mid)))) low = mid
    else high = mid - 1
  }
  const end = safeEnd(original, low)
  if (end === 0 && original.length > 0) {
    return { success: false, error: 'This run’s tool output limit leaves no room for content. Request a smaller source.' }
  }
  return make(end)
}

module.exports = { fitToolPagePayload, PAGE_MAX_CHARS }
