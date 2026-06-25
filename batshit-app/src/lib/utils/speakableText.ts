const SPEAKABLE_HTML_TAGS = new Set([
  'a',
  'abbr',
  'article',
  'aside',
  'b',
  'blockquote',
  'br',
  'cite',
  'code',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'wbr'
])

const EMOJI_CLUSTER_SOURCE =
  String.raw`\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*`
const EMOJI_COMBO_JOINER_PATTERN = new RegExp(
  `(${EMOJI_CLUSTER_SOURCE})\\s*\\+\\s*(${EMOJI_CLUSTER_SOURCE})`,
  'gu'
)

export type SpeakableItalicBehavior = 'speak' | 'silent'

export type SpeakableTextOptions = {
  italicBehavior?: SpeakableItalicBehavior
}

function shouldSilenceItalics(options?: SpeakableTextOptions): boolean {
  return options?.italicBehavior === 'silent'
}

function shouldDropXmlBlock(tagName: string): boolean {
  return !SPEAKABLE_HTML_TAGS.has(tagName.toLowerCase())
}

function stripUnsupportedXmlBlocks(text: string): string {
  let output = text
  let changed = true

  // Remove unsupported self-closing tags before paired tags so a tag like
  // `<emote name="smile" />` is not mistaken for an opener when another
  // `</emote>` appears later in the same reply.
  output = output.replace(/<([a-z][a-z0-9:_-]*)\b[^>]*\/>/gi, (match, tagName) => {
    return shouldDropXmlBlock(tagName) ? '' : match
  })

  // Remove unsupported paired tags repeatedly so nested tags are fully stripped.
  while (changed) {
    changed = false
    output = output.replace(/<([a-z][a-z0-9:_-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, (match, tagName) => {
      if (shouldDropXmlBlock(tagName)) {
        changed = true
        return ''
      }
      return match
    })
  }

  // Remove unsupported self-closing tags.
  output = output.replace(/<([a-z][a-z0-9:_-]*)\b[^>]*\/>/gi, (match, tagName) => {
    return shouldDropXmlBlock(tagName) ? '' : match
  })

  return output
}

function stripEmojiComboJoiners(text: string): string {
  let output = text
  let changed = true

  while (changed) {
    changed = false
    output = output.replace(EMOJI_COMBO_JOINER_PATTERN, (_match, left: string, right: string) => {
      changed = true
      return `${left}${right}`
    })
  }

  return output
}

function isHtmlTagNameBoundary(char: string | undefined): boolean {
  return !char || char === '>' || char === '/' || char === ' ' || char === '\t' || char === '\n' || char === '\r'
}

function findHtmlTag(lowerText: string, tagName: string, fromIndex: number, closing = false): number {
  const prefix = closing ? `</${tagName}` : `<${tagName}`
  let searchIndex = fromIndex
  while (searchIndex < lowerText.length) {
    const index = lowerText.indexOf(prefix, searchIndex)
    if (index < 0) return -1
    if (isHtmlTagNameBoundary(lowerText[index + prefix.length])) return index
    searchIndex = index + prefix.length
  }
  return -1
}

function stripSelfClosingHtmlTagsByName(text: string, tagName: string): string {
  let output = text
  for (let scanCount = 0; scanCount < 50; scanCount += 1) {
    const lower = output.toLowerCase()
    const openIndex = findHtmlTag(lower, tagName, 0)
    if (openIndex < 0) return output

    const openEnd = lower.indexOf('>', openIndex)
    if (openEnd < 0) return output.slice(0, openIndex)

    const tagText = lower.slice(openIndex, openEnd + 1)
    if (!tagText.trimEnd().endsWith('/>')) {
      return output
    }

    output = `${output.slice(0, openIndex)} ${output.slice(openEnd + 1)}`
  }
  return output
}

function stripHtmlBlocksByTagName(text: string, tagName: string): string {
  let output = text

  for (let scanCount = 0; scanCount < 50; scanCount += 1) {
    const lower = output.toLowerCase()
    const openIndex = findHtmlTag(lower, tagName, 0)
    if (openIndex < 0) return output

    const openEnd = lower.indexOf('>', openIndex)
    if (openEnd < 0) {
      output = `${output.slice(0, openIndex)} ${output.slice(openIndex + tagName.length + 1)}`
      continue
    }

    const closeIndex = findHtmlTag(lower, tagName, openEnd + 1, true)
    if (closeIndex < 0) {
      output = output.slice(0, openIndex)
      continue
    }

    const closeEnd = lower.indexOf('>', closeIndex)
    output = `${output.slice(0, openIndex)} ${closeEnd >= 0 ? output.slice(closeEnd + 1) : ''}`
  }

  return output
}

function stripRemainingHtmlTags(text: string): string {
  let output = ''
  let index = 0
  while (index < text.length) {
    const openIndex = text.indexOf('<', index)
    if (openIndex < 0) {
      output += text.slice(index)
      break
    }

    output += text.slice(index, openIndex)
    const closeIndex = text.indexOf('>', openIndex + 1)
    if (closeIndex < 0) {
      break
    }
    output += ' '
    index = closeIndex + 1
  }
  return output
}

function stripHtmlItalicNarrationForSpeech(text: string): string {
  let output = stripHtmlBlocksByTagName(text, 'em')
  output = stripHtmlBlocksByTagName(output, 'i')
  output = stripSelfClosingHtmlTagsByName(output, 'em')
  return stripSelfClosingHtmlTagsByName(output, 'i')
}

function stripMarkdownItalicNarrationForSpeech(text: string): string {
  let output = text
  const trailingBoundary = String.raw`(?=$|[\s.,!?;:)\]}])`

  output = output.replace(
    new RegExp(String.raw`(^|[\s([{])\*\*\*([^*\n]+)\*\*\*${trailingBoundary}`, 'g'),
    '$1'
  )
  output = output.replace(
    new RegExp(String.raw`(^|[\s([{])___([^_\n]+)___${trailingBoundary}`, 'g'),
    '$1'
  )
  output = output.replace(
    new RegExp(String.raw`(^|[\s([{])\*([^*\n]+)\*${trailingBoundary}`, 'g'),
    '$1'
  )
  output = output.replace(
    new RegExp(String.raw`(^|[\s([{])_([^_\n]+)_${trailingBoundary}`, 'g'),
    '$1'
  )

  return output
}

function stripMarkdownForSpeech(text: string, options: SpeakableTextOptions = {}): string {
  let output = text

  // Drop fenced code blocks; reading raw code aloud is usually punctuation soup.
  output = output.replace(/```[\s\S]*?```/g, '')
  output = output.replace(/~~~[\s\S]*?~~~/g, '')

  // Remove reference definitions and image/link URLs while preserving useful labels.
  output = output.replace(/^\s{0,3}\[[^\]]+\]:\s+\S+.*$/gm, '')
  output = output.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
  output = output.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  output = output.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')

  // Strip block-level Markdown markers that should not be spoken.
  output = output.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '$1')
  output = output.replace(/^\s{0,3}>\s?/gm, '')
  output = output.replace(/^\s{0,3}([-*_]\s*){3,}$/gm, '')
  output = output.replace(/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')

  // Strip inline formatting markers but keep the words.
  output = output.replace(/`{1,2}([^`\n]+)`{1,2}/g, '$1')
  output = output.replace(/~~([^~\n]+)~~/g, '$1')
  if (shouldSilenceItalics(options)) {
    output = stripMarkdownItalicNarrationForSpeech(output)
  }
  output = output.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  output = output.replace(/__([^_\n]+)__/g, '$1')
  if (!shouldSilenceItalics(options)) {
    output = output.replace(/(^|[\s([{])\*([^*\n]+)\*(?=$|[\s.,!?;:)\]}])/g, '$1$2')
    output = output.replace(/(^|[\s([{])_([^_\n]+)_(?=$|[\s.,!?;:)\]}])/g, '$1$2')
  }

  // Clean up common table/separator punctuation that speech engines tend to vocalize.
  output = output.replace(/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?\s*$/gm, '')
  output = output.replace(/^\s*\|(.+)\|\s*$/gm, (_match, cells: string) =>
    cells
      .split('|')
      .map((cell: string) => cell.trim())
      .filter(Boolean)
      .join(', ')
  )

  // Remove leftover Markdown emphasis markers after structured cases are handled.
  output = output.replace(/[*~`]/g, '')

  return output
}

function stripToolResultsSummarySections(text: string): string {
  const lines = text.split(/\r?\n/)
  const kept: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const normalized = line.trim()

    if (!/^#{0,6}\s*tool results summary\b/i.test(normalized)) {
      kept.push(line)
      continue
    }

    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? ''
      const trimmed = next.trim()

      if (!trimmed) {
        index += 1
        break
      }

      if (/^#{1,6}\s+\S/.test(trimmed)) break

      index += 1
    }
  }

  return kept.join('\n')
}

function stripKnownControlTails(text: string): string {
  return text
    .replace(/<batshit-zip-control\b[\s\S]*?<\/batshit-zip-control>/gi, '')
    .replace(/<batshit-zip-control\b[\s\S]*$/gi, '')
    .replace(/<(batshit-group|batshit-cue)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<batshit-(?:group|cue)\b[\s\S]*$/gi, '')
    .replace(/<tool[-_ ]?results(?:[-_ ]?summary)?\b[\s\S]*?<\/tool[-_ ]?results(?:[-_ ]?summary)?>/gi, '')
    .replace(/<tool[-_ ]?results(?:[-_ ]?summary)?\b[\s\S]*$/gi, '')
    .replace(/\btoolResultsSummary\b[\s\S]*$/i, '')
}

export function extractSpeakableText(content: string, options: SpeakableTextOptions = {}): string {
  if (!content) return ''

  let text = content

  // Remove thinking blocks entirely (never read aloud).
  text = text.replace(/<thinking[\s\S]*?>[\s\S]*?<\/thinking>/gi, '')

  // Remove mute blocks entirely (never read aloud).
  text = text.replace(/<mute[\s\S]*?>[\s\S]*?<\/mute>/gi, '')

  // Remove control tags entirely (group chat metadata + presentation cues).
  text = text
    .replace(/<batshit-group[\s\S]*?>[\s\S]*?<\/batshit-group>/gi, '')
    .replace(/<batshit-cue[\s\S]*?>[\s\S]*?<\/batshit-cue>/gi, '')

  // Remove zip/tool note controls, including partial tails seen by realtime TTS.
  text = stripKnownControlTails(text)

  // Remove Tool Results Summary blocks from speech; they remain visible app metadata in chat.
  text = stripToolResultsSummarySections(text)

  // Remove goon stage directions (never read aloud).
  text = text.replace(/\*goon:\s*[^*]*\*/gi, '')

  if (shouldSilenceItalics(options)) {
    text = stripHtmlItalicNarrationForSpeech(text)
  }

  // Remove Markdown formatting markers so TTS does not say "asterisk",
  // "hash", or raw link punctuation during normal assistant replies.
  text = stripMarkdownForSpeech(text, options)

  // Remove zip references (new + legacy) so we never read `{{batshit-zip:...}}`.
  text = text.replace(/\{\{batshit-zip:[^}]+\}\}/g, '')
  text = text.replace(/\{\{batshit\|id:[^}]+\}\}/g, '')

  // Remove script/style blocks entirely (avoid reading embedded JSON payloads).
  text = stripHtmlBlocksByTagName(text, 'script')
  text = stripHtmlBlocksByTagName(text, 'style')

  // Remove unsupported XML-style blocks entirely so custom control tags
  // (for example <emotion>...</emotion>) are never read aloud.
  text = stripUnsupportedXmlBlocks(text)

  // Preserve line breaks where HTML intentionally inserts them.
  text = text.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')

  // Strip remaining XML/HTML tags but keep their inner text.
  text = stripRemainingHtmlTags(text)

  // Remove `+` only when it is acting as an emoji-combo joiner (for example `🙄+🤨`).
  text = stripEmojiComboJoiners(text)

  // Strip emoji characters (Goon cues should not be read aloud).
  text = text.replace(/\p{Extended_Pictographic}/gu, '')

  // Normalize repeated spaces created by tag stripping.
  text = text.replace(/[ \t]{2,}/g, ' ')
  text = text.replace(/\s+([,.;:!?])/g, '$1')
  text = text.replace(/^[ \t]+/gm, '')
  text = text.replace(/[ \t]+$/gm, '')

  // Normalize whitespace.
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  return text
}
