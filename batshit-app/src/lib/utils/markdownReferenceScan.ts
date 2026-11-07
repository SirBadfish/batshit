/** Exact legacy reader grammars, with advancing delimiter searches instead of
 * retrying the remaining message at every unfinished reference opener.
 * Trust decisions, code-region handling and rendering belong to the callers.
 */
export type MarkdownReference = {
  start: number
  end: number
  match: string
  kind: 'batshit-zip' | 'batshit-clip'
  id: string
  description: string | undefined
}

function delimiterFinder(text: string, delimiter: string) {
  let next = -2
  return (from: number) => {
    // Queries advance; a delimiter found beyond this opener is reusable by the
    // following openers. Cache exhaustion too, so missing closers cost one scan.
    if (next === -2 || (next >= 0 && next < from)) next = text.indexOf(delimiter, from)
    return next
  }
}

function scanReferences(text: string): MarkdownReference[] {
  const references: MarkdownReference[] = []
  const nextColon = delimiterFinder(text, ':')
  const nextBrace = delimiterFinder(text, '}')
  let from = 0
  while (from < text.length) {
    const start = text.indexOf('{{batshit-', from)
    if (start < 0) break
    from = start + 1
    const kind = text.startsWith('{{batshit-zip:', start)
      ? 'batshit-zip'
      : text.startsWith('{{batshit-clip:', start) ? 'batshit-clip' : undefined
    if (!kind) continue
    const idStart = start + kind.length + 3
    const colon = nextColon(idStart)
    const brace = nextBrace(idStart)
    let idEnd: number
    let end: number
    let description: string | undefined
    if (brace >= 0 && (colon < 0 || brace < colon)) {
      if (brace === idStart || !text.startsWith('}}', brace)) continue
      idEnd = brace
      end = brace + 2
    } else {
      if (colon <= idStart || !text.startsWith(':::', colon)) continue
      const descriptionStart = colon + 3
      const descriptionEnd = nextBrace(descriptionStart)
      if (descriptionEnd <= descriptionStart || !text.startsWith('}}', descriptionEnd)) continue
      idEnd = colon
      end = descriptionEnd + 2
      description = text.slice(descriptionStart, descriptionEnd)
    }
    references.push({ start, end, match: text.slice(start, end), kind, id: text.slice(idStart, idEnd), description })
    from = end
  }
  return references
}

/**
 * The transcript export's grammar: ids exclude ':' and '}'. The chat view's formatter reads the
 * trust reader's shapes (`scanZipReferences`, `scanClipReferences`) since BL-609.
 */
export function scanTranscriptReferences(text: string) {
  return scanReferences(text)
}

export function scanTranscriptLegacyClipBlocks(text: string) {
  const blocks: Array<{ start: number; end: number; metadata: string; body: string }> = []
  const opener = '{{batshit-clip|'
  const closer = '{{/batshit-clip}}'
  const nextBrace = delimiterFinder(text, '}')
  const nextClose = delimiterFinder(text, closer)
  let from = 0
  while (from < text.length) {
    const start = text.indexOf(opener, from)
    if (start < 0) break
    from = start + 1
    const metadataStart = start + opener.length
    const metadataEnd = nextBrace(metadataStart)
    if (metadataEnd < 0) break
    if (metadataEnd === metadataStart || !text.startsWith('}}', metadataEnd)) continue
    const bodyStart = metadataEnd + 2
    const bodyEnd = nextClose(bodyStart)
    if (bodyEnd < 0) break
    const end = bodyEnd + closer.length
    blocks.push({ start, end, metadata: text.slice(metadataStart, metadataEnd), body: text.slice(bodyStart, bodyEnd) })
    from = end
  }
  return blocks
}
