/** Managed-helper mirror of the pure model-text cut for ephemeral sys.memory.* results.
 * This path never creates a raw zip. Keep parity with toolModelTextSizeGuard.ts. */
// BL-677: 24,000 tokens by the estimate, below the 25,000-token guard (toolModelTextSizeGuard.ts).
const MAX_TEXT_CHARS = 96_000
const RAW_MAX_CHARS = 8_000_000
const TOO_LARGE_TOKENS = 25_000

function safeSliceEnd(text, end) {
  if (end <= 0 || end >= text.length) return end
  const before = text.charCodeAt(end - 1)
  const after = text.charCodeAt(end)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? end - 1 : end
}

function firstPartEnd(text, maxChars) {
  const safeEnd = safeSliceEnd(text, Math.min(text.length, maxChars))
  const lastLineEnd = text.lastIndexOf('\n', safeEnd - 1) + 1
  return lastLineEnd > 0 && safeEnd - lastLineEnd <= maxChars / 4 ? lastLineEnd : safeEnd
}

function safeBudgetSource(source) {
  const clean = source?.trim()
  return clean && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(clean) ? clean : 'model lane'
}

function memoryNotice(estimatedTokens, totalChars, keptChars, budget, byteLimited) {
  const laneLimit = byteLimited
    ? ` The ${safeBudgetSource(budget?.source)} model-facing result budget is ${budget.maxUtf8Bytes.toLocaleString('en-US')} UTF-8 bytes.`
    : ''
  return `[Output cut here by Batshit: this result is about ${estimatedTokens.toLocaleString('en-US')} tokens (${totalChars.toLocaleString('en-US')} characters). One result can be ${TOO_LARGE_TOKENS.toLocaleString('en-US')} tokens at most. You have the first ${keptChars.toLocaleString('en-US')} characters.${laneLimit} Search again with a narrower query or a smaller limit, or recall one memory by its id.]`
}

function shortCutRefusal(maxUtf8Bytes) {
  return [
    '[Output cut: the model-facing byte limit cannot hold the full notice.]',
    '[Output cut]', 'CUT', '!'
  ].find((notice) => notice.length <= maxUtf8Bytes) ?? ''
}

function formatMemoryResultCut(text, originalTextChars = text.length, budget) {
  if (typeof text !== 'string' || !Number.isSafeInteger(originalTextChars) || originalTextChars < text.length) {
    throw new Error('Original tool text length must be an integer at least as long as the delivered text.')
  }
  const maxUtf8Bytes = budget?.maxUtf8Bytes
  if (maxUtf8Bytes !== undefined && (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 0)) {
    throw new Error('The model-facing byte budget must be a nonnegative safe integer.')
  }
  // A saved Codex profile may explicitly permit zero tool-output bytes. No notice can fit.
  if (maxUtf8Bytes === 0) return ''
  const estimatedTokens = Math.ceil(originalTextChars / 4)
  const byteLimited = maxUtf8Bytes !== undefined && Buffer.byteLength(text, 'utf8') > maxUtf8Bytes
  if (estimatedTokens < TOO_LARGE_TOKENS && !byteLimited) return text
  const rawEnd = safeSliceEnd(text, Math.min(text.length, RAW_MAX_CHARS))
  const rawText = text.slice(0, rawEnd)
  const noticeFor = (keptChars) => memoryNotice(estimatedTokens, originalTextChars, keptChars, budget, byteLimited)

  if (maxUtf8Bytes !== undefined) {
    const render = (keptChars) => {
      const prefix = rawText.slice(0, keptChars)
      return `${prefix}${prefix && !prefix.endsWith('\n') ? '\n' : ''}${noticeFor(keptChars)}`
    }
    const fits = (keptChars) => {
      const finalText = render(keptChars)
      return finalText.length <= MAX_TEXT_CHARS && Buffer.byteLength(finalText, 'utf8') <= maxUtf8Bytes
    }
    if (!fits(0)) return shortCutRefusal(maxUtf8Bytes)

    let low = 0
    let high = Math.min(rawText.length, MAX_TEXT_CHARS)
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (fits(safeSliceEnd(rawText, middle))) low = middle
      else high = middle - 1
    }
    let keptChars = safeSliceEnd(rawText, low)
    const wholeLineEnd = firstPartEnd(rawText, keptChars)
    if (wholeLineEnd < keptChars && fits(wholeLineEnd)) keptChars = wholeLineEnd
    const result = render(keptChars)
    if (result.length > MAX_TEXT_CHARS || Buffer.byteLength(result, 'utf8') > maxUtf8Bytes) {
      throw new Error('The tool-result cut exceeded its model budget.')
    }
    return result
  }

  let keptChars = firstPartEnd(rawText, MAX_TEXT_CHARS - 512)
  let notice = noticeFor(keptChars)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const available = MAX_TEXT_CHARS - notice.length - 1
    if (available < 1) throw new Error('The tool-result cut notice exceeds its model budget.')
    const nextKept = firstPartEnd(rawText, available)
    if (nextKept === keptChars) break
    keptChars = nextKept
    notice = noticeFor(keptChars)
  }
  while (keptChars + 1 + notice.length > MAX_TEXT_CHARS) {
    keptChars = firstPartEnd(rawText, keptChars - 1)
    notice = noticeFor(keptChars)
  }
  const prefix = rawText.slice(0, keptChars)
  const result = `${prefix}${prefix.endsWith('\n') ? '' : '\n'}${notice}`
  if (result.length > MAX_TEXT_CHARS) throw new Error('The tool-result cut exceeded its model budget.')
  return result
}

module.exports = { formatMemoryResultCut }
