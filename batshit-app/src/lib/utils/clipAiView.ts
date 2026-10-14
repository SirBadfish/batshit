/**
 * SA-109 — the AI view's single clip vocabulary.
 *
 * Agents get exactly three things about clips, and nothing else:
 *
 *   1. CONTENT — every currently-attached clip arrives structurally with the
 *      send (text inlined in `<clipped_items>`, images as real
 *      image parts). A placeholder next to content that already arrived is
 *      redundant bookkeeping, so attached clips compile to NO history marker
 *      at all (DL-109-02).
 *   2. THE ROSTER — one DCM section per send states which clips are attached,
 *      which are new this message, and which persist from earlier. The
 *      new-vs-persisting question is answered by statement, not by noticing
 *      repeated syntax (DL-109-04).
 *   3. CLIP LOGS — a departed clip (unclipped, or an expired
 *      next-message-only clip) leaves `**(Clip Log: <filename>)**` where it
 *      rode. For a departed clip the marker is the ONLY remaining trace, the
 *      same record role zip syntax plays for hidden tool results (DL-109-03).
 *
 * Raw `{{batshit-clip:…}}` syntax must never reach a model on any lane. The
 * user view is untouched: stored message content keeps its placeholders and
 * `compileForUser` still renders chips (DL-109-01).
 *
 * Everything here is pure text/data work so it can run on the server compile
 * path, in the provider adapter, and under unit tests without Redis.
 */

import { replaceClipReferences, replaceLegacyClipReferences } from './zipReferenceSafety'

/** Used when a departed clip has no recoverable filename — loud, never silent. */
export const CLIP_LOG_UNNAMED_LABEL = 'unnamed clip'

/** Status marks shared with the memory recall engine's Current/Lingering grouping. */
const ICON_NEW = '✅'
const ICON_HELD = '\u{1F7E2}'

/** Compiled text for a user message whose only content was clip placeholders. */
export const EMPTY_COMPILED_MESSAGE_TEXT = '[No content]'

export function formatClipLog(name?: string | null): string {
  const label = typeof name === 'string' ? name.trim() : ''
  return `**(Clip Log: ${label || CLIP_LOG_UNNAMED_LABEL})**`
}

function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** `{{batshit-clip|id:X|name:Y}}…{{/batshit-clip}}` — legacy blocks carry the name inline. */
function readLegacyClipName(fullMatch: string): string {
  return normalizeName(/\|\s*name\s*:\s*([^|}]+)/.exec(fullMatch)?.[1])
}

/**
 * Collapses the blank lines a removed placeholder leaves behind.
 *
 * Clip placeholders are appended by ChatInput as their own trailing block
 * (`\n\n{{clip}}\n{{clip}}`), so removing them otherwise leaves a ragged tail.
 * Deterministic by construction: the same stored content always compiles to
 * the same bytes, which is what the SA-108 `historyStability` verdict reads.
 */
function tidyAfterRemoval(content: string, report?: (start:number,end:number,replacement:string)=>void): string {
  const replace=(text:string,pattern:RegExp,replacement:string)=>{
    let shift=0
    return text.replace(pattern,(match:string,offset:number)=>{
      report?.(offset+shift,offset+shift+match.length,replacement)
      shift+=replacement.length-match.length
      return replacement
    })
  }
  let next=replace(content,/[ \t]+\n/g,'\n')
  next=replace(next,/\n{3,}/g,'\n\n')
  const leading=next.length-next.trimStart().length
  if(leading) {report?.(0,leading,'');next=next.slice(leading)}
  const trailing=next.length-next.trimEnd().length
  if(trailing) {report?.(next.length-trailing,next.length,'');next=next.slice(0,next.length-trailing)}
  return next
}

/**
 * Rewrites every clip placeholder in one message's text for the AI view.
 *
 * Attached clips lose their marker entirely; departed clips become Clip Logs
 * at the position they rode. Content with no clip syntax is returned
 * untouched, byte-for-byte, so clip-free chats pay nothing.
 *
 * `activeClipIds === null` means the clip state is UNKNOWN (no session to read
 * it from). Every ref is then treated as attached and simply removed, because
 * writing "Clip Log" over a clip whose content may still be arriving would
 * state something false. Raw syntax leaves either way.
 */
export function compileClipReferencesForAiView(
  content: string,
  activeClipIds: Set<string> | null | undefined,
  options: { clipNames?: Map<string, string> | null; onReplace?: (start:number,end:number,replacement:string)=>void } = {}
): string {
  if (!content || !content.includes('{{batshit-clip')) return content

  const active = activeClipIds ?? null
  const names = options.clipNames ?? null

  const isAttached = (clipId: string) => !active || active.has(clipId)
  const resolveName = (clipId: string, inlineName: string) =>
    inlineName || normalizeName(names?.get(clipId))

  const report=(start:number,end:number,replacement:string)=>{
    try {options.onReplace?.(start,end,replacement)}
    catch(error) {console.error('[Clip AI view] Read-only replacement observer failed:',error)}
  }
  let cursor=0,shift=0
  let next = replaceLegacyClipReferences(content, (fullMatch, clipId) => {
    const id = normalizeName(clipId)
    const replacement=isAttached(id)?'':formatClipLog(resolveName(id,readLegacyClipName(fullMatch)))
    const index=content.indexOf(fullMatch,cursor)
    cursor=index+fullMatch.length
    report(index+shift,index+shift+fullMatch.length,replacement)
    shift+=replacement.length-fullMatch.length
    return replacement
  })

  const beforeModern=next
  cursor=0;shift=0
  next = replaceClipReferences(next, (fullMatch, clipId, description) => {
    const id = normalizeName(clipId)
    const replacement=isAttached(id)?'':formatClipLog(resolveName(id,normalizeName(description)))
    const index=beforeModern.indexOf(fullMatch,cursor)
    cursor=index+fullMatch.length
    report(index+shift,index+shift+fullMatch.length,replacement)
    shift+=replacement.length-fullMatch.length
    return replacement
  })

  if (next === content) return content
  return tidyAfterRemoval(next,report)
}

export interface ClipRosterEntryInput {
  clipId: string
  name?: string | null
  attachedToMessageId?: string | null
  messagesUntilUnclip?: number | null
}

export interface ClipRosterLines {
  currentLines: string[]
  lingeringLines: string[]
}

/**
 * Groups attached clips into the established Current / Lingering vocabulary.
 *
 * A clip counts as Current when the message it was attached to is not in the
 * compiled history yet — i.e. it rode in with this send.
 */
export function buildClipRosterLines(options: {
  entries: ClipRosterEntryInput[]
  historyMessageIds: Set<string>
}): ClipRosterLines {
  const currentLines: string[] = []
  const lingeringLines: string[] = []

  for (const entry of options.entries) {
    if (!entry?.clipId) continue
    const name = normalizeName(entry.name)
    const label = name ? `"${name}" (${entry.clipId})` : entry.clipId
    const countdown =
      typeof entry.messagesUntilUnclip === 'number' && entry.messagesUntilUnclip > 0
        ? `, ${entry.messagesUntilUnclip} message${entry.messagesUntilUnclip === 1 ? '' : 's'} left`
        : ''
    const attachedToKnownHistory = entry.attachedToMessageId
      ? options.historyMessageIds.has(entry.attachedToMessageId)
      : true

    if (attachedToKnownHistory) {
      lingeringLines.push(`  - ${ICON_HELD} clip ${label} — attached earlier, still active${countdown}`)
    } else {
      currentLines.push(`  - ${ICON_NEW} clip ${label} — attached with this message${countdown}`)
    }
  }

  return { currentLines, lingeringLines }
}

/**
 * The general DCM clip section — every agent gets it, including memory-off
 * agents and group runs (DL-109-04). Returns [] when nothing is attached, so
 * clip-free sends stay byte-identical to today.
 */
export function buildClipRosterDcmLines(roster: ClipRosterLines): string[] {
  if (roster.currentLines.length === 0 && roster.lingeringLines.length === 0) return []

  const lines: string[] = [
    'Clips attached (their content is delivered with this message):'
  ]
  if (roster.currentLines.length > 0) {
    lines.push('- Current (new this message):')
    lines.push(...roster.currentLines)
  }
  if (roster.lingeringLines.length > 0) {
    lines.push('- Lingering (from earlier messages):')
    lines.push(...roster.lingeringLines)
  }
  return lines
}
