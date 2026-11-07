/**
 * SA-129 P2 (DL-08): the control blocks at the end of a finished reply, read in ONE place.
 *
 * An agent may end a reply with three hidden blocks: `<batshit-tool-notes>` (its notes, plus the
 * files it holds or releases, DL-02), `<batshit-memory>` (one save per block), and the retired
 * `<batshit-zip-control>` (its zip actions are always refused with a control error, 2026-10-23).
 * `send-routed` finalizes them once per reply for every lane and every caller
 * (`replyControlFinalize.ts`); `/api/sse`'s `end` strips the same blocks from the content it
 * rebuilds from the stream, with `stripReplyControlBlocks`, so the browser's save cannot bring a
 * block back. The chat page only renders.
 *
 * Pure: it reads the text it is handed and nothing else.
 */

import {
  buildControlErrorRecord,
  findControlBlocks,
  removeControlBlocks,
  type ControlBlock,
  type ControlErrorRecord
} from './controlTags'
import { readMemoryBlocks, type ExtractedMemoryBlock } from './memoryControl'
import {
  extractTrailingBareHiddenControl,
  extractTrailingBareToolNotes,
  readToolNotesBlocks,
  readZipControlBlocks,
  stripBareHiddenControlPayloads,
  TOOL_NOTES_BLOCK_LIMIT,
  TOOL_NOTES_EMPTY_BLOCK_ERROR,
  TOOL_NOTES_OFF_EMPTY_BLOCK_ERROR,
  type ToolNotesHoldBlock,
  type ToolNotesPayload,
  type ZipControlToolSummary
} from './zipControl'

/** The metadata flag that says the server finalized this reply's control blocks. */
export const REPLY_CONTROL_FINALIZED_FLAG = 'replyControlFinalized'

export const TOOL_NOTES_BLOCK_HINT =
  'Use <batshit-tool-notes>{"notes":[{"toolName":"...","summary":"exact fact(s)"}],"hold":["path/to/file"],"release":["path/to/file"]}</batshit-tool-notes>; every key is optional.'
/** BL-1785: the same fix line for an agent with Tool Notes off, which never names notes. */
export const TOOL_NOTES_OFF_BLOCK_HINT =
  'Use <batshit-tool-notes>{"hold":["path/to/file"],"release":["path/to/file"]}</batshit-tool-notes>; leave out notes.'

export function toolNotesBlockHint(toolNotesEnabled: boolean): string {
  return toolNotesEnabled ? TOOL_NOTES_BLOCK_HINT : TOOL_NOTES_OFF_BLOCK_HINT
}

const PRESENTATION_BLOCK_HINTS: Record<string, string> = {
  'batshit-cue': 'Close it: <batshit-cue>{"goon_mood":"happy"}</batshit-cue>.',
  'batshit-group': 'Close it: <batshit-group>{"mode":"responding"}</batshit-group>.'
}

/** Agent zip control is retired (decision 7, 2026-10-23): a broken block gets the same way forward as a valid one. */
export const ZIP_CONTROL_BLOCK_HINT =
  'Agents cannot unzip or zip results. To keep a file you read open, hold it: <batshit-tool-notes>{"hold":["path/to/file"]}</batshit-tool-notes>. Use Fetch Zip to read an earlier result.'

export interface ReplyControlExtraction {
  /** The reply with every notes, memory, and zip-control block removed, and an open cue or group block's tag and payload line. */
  cleaned: string
  /** A notes block (tagged or a trailing bare payload) was present. */
  hadNotesBlock: boolean
  /** How many notes blocks the reply carried; more than one is read whole and reported (BL-357). */
  notesBlockCount: number
  notes: ZipControlToolSummary[]
  hold: string[]
  release: string[]
  /**
   * The holds and releases to apply, one entry per Tool Notes block in order (BL-538): the hold
   * step runs each block's releases, then its holds, block by block, comparing paths by file.
   * Empty when no block asked for any.
   */
  holdBlocks: ToolNotesHoldBlock[]
  notesParseError?: string
  unknownNotesKeys: string[]
  invalidHoldEntries: Array<{ key: 'hold' | 'release'; value: string }>
  /** A zip-control block was present (the parked legacy path, DL-06). */
  hadZipControlBlock: boolean
  unzip: string[]
  zip: string[]
  zipControlParseError?: string
  legacyNotesDropped: boolean
  memoryBlocks: ExtractedMemoryBlock[]
  /** The cue or group tags left open, one per block; each lost its tag and payload only (BL-695). */
  unclosedPresentationTags: string[]
  /** More open cue or group blocks than the reply end reads: the reply was cut at the next one. */
  openPresentationCutTag?: string
}

const REPLY_BLOCK_IDS = new Set(['tool-notes', 'memory', 'zip-control'])
/** The presentation tags: a complete block stays in the stored reply. */
const PRESENTATION_BLOCK_IDS = new Set(['cue', 'group'])

/**
 * At most this many more scans look for further open cue or group blocks (the scanner folds a
 * later opening tag of the same name into the first open block); past them, the reply is cut at
 * the next open block, loudly (R3), so the reply end stays bounded.
 */
const OPEN_PRESENTATION_RESCAN_LIMIT = 20

/** Whether `text.slice(from, to)` is JSON. */
function isJson(text: string, from: number, to: number): boolean {
  try {
    JSON.parse(text.slice(from, to))
    return true
  } catch {
    return false
  }
}

/**
 * Where a JSON object or string that starts at `from` ends (one past its last character), or -1
 * when it never closes (BL-695, review round 2): a raw line break inside a string means it never
 * closes, and a candidate end counts only when the whole slice is JSON, so prose after a broken
 * payload is never taken for the rest of it. One pass, and one parse.
 */
function closedJsonEnd(text: string, from: number): number {
  const isString = text[from] === '"'
  // Inside the outer object, how many more objects are open.
  let depth = 0
  let inString = isString
  for (let at = from + 1; at < text.length; at += 1) {
    const char = text[at]
    if (inString) {
      if (char === '\n' || char === '\r') return -1
      if (char === '\\') at += 1
      else if (char === '"') {
        inString = false
        if (isString) return isJson(text, from, at + 1) ? at + 1 : -1
      }
    } else if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      if (depth === 0) return isJson(text, from, at + 1) ? at + 1 : -1
      depth -= 1
    }
  }
  return -1
}

const isLineSpace = (char: string | undefined) => char === ' ' || char === '\t'

/**
 * BL-695: what an unclosed cue or group block loses: its tag and its payload. A payload that closes
 * as JSON (an object or a string, over several lines too) ends the removal right after it, so the
 * words after it on that line stay, joined by one space. A payload that never closes, or a cue's
 * `key: value` form, takes the rest of its first line. When the removal ends a line, the spaces
 * before the tag go with it. Every later line stays.
 */
function openPresentationRemoval(text: string, block: ControlBlock): ControlBlock {
  let start = block.start
  let at = block.bodyStart
  while (at < text.length && /\s/.test(text[at])) at += 1
  let end = text.length
  if (at < text.length) {
    const closed = text[at] === '{' || text[at] === '"' ? closedJsonEnd(text, at) : -1
    if (closed > 0) {
      end = closed
      if (isLineSpace(text[end]) && (start === 0 || /\s/.test(text[start - 1]))) end += 1
    } else {
      const lineEnd = text.indexOf('\n', at)
      end = lineEnd < 0 ? text.length : text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd
    }
  }
  if (end === text.length || text[end] === '\n' || text[end] === '\r') {
    while (start > 0 && isLineSpace(text[start - 1])) start -= 1
  }
  return { ...block, start, end }
}

/** The open cue and group blocks among `blocks`. */
const openPresentationBlocks = (blocks: readonly ControlBlock[]) =>
  blocks.filter((block) => block.kind === 'unclosed' && PRESENTATION_BLOCK_IDS.has(block.id))

const tidy = (text: string) => text.replace(/\n{3,}/g, '\n\n').trim()

/**
 * Reads a finished reply's control blocks, from ONE scan of the reply (BL-442,
 * `findControlBlocks` with `final: true`): a block counts only when it is outside code, followed
 * by its payload, and closed. An example in a code block and a tag named in a sentence are text:
 * they stay in the reply and save nothing (BL-442, BL-473). A real block left open at the end is
 * hidden from its tag on and reported loudly (R3; BL-480).
 *
 * Every kind is read from the same scan, so a broken block cannot take a later block of another
 * kind with it (the scan goes on after an unclosed tag), and memory is never lost to the
 * zip-control cleaner (BL-349). The cleaned text is the reply without every notes, memory, and
 * zip-control block, with the old rules around it: a trailing bare Tool Notes payload is read when
 * there is no notes block; with a zip-control block, bare hidden payloads at the edges go too, and
 * without one a trailing bare zip-control payload is read (the malformed-output fallback).
 */
export function extractReplyControl(content: string): ReplyControlExtraction {
  let working = typeof content === 'string' ? content : ''
  let blocks = working ? findControlBlocks(working, { final: true }) : []

  // Tool Notes: the tagged blocks, else a trailing bare payload (read on the whole reply).
  let notes: { payload?: ToolNotesPayload; parseError?: string; hadBlock: boolean; blockCount: number } =
    readToolNotesBlocks(working, blocks)
  if (!notes.hadBlock) {
    const bare = working ? extractTrailingBareToolNotes(working) : null
    if (bare) {
      notes = { payload: bare.payload, hadBlock: true, blockCount: 1 }
      working = bare.cleaned
      blocks = findControlBlocks(working, { final: true })
    }
  }

  const memoryBlocks = readMemoryBlocks(working, blocks)
  const zip = readZipControlBlocks(working, blocks)
  // The reply's own blocks, and a held start of any tag: at a finished reply's end, one that holds
  // `<batshit-` in full is the start of a cut block and is hidden, with no error (R4). A cue or
  // group block left open (BL-695) loses its tag and its payload only, with a loud error: the
  // words after it are the reply's, and its tool cards with them. A complete cue block stays:
  // the Goon reads it from the stored reply.
  const firstOpen = openPresentationBlocks(blocks)
  const unclosedPresentationTags = firstOpen.map((block) => block.tag)
  const replyBlocks = [
    ...blocks.filter((block) => REPLY_BLOCK_IDS.has(block.id) || block.kind === 'held-start'),
    ...firstOpen.map((block) => openPresentationRemoval(working, block))
  ].sort((a, b) => a.start - b.start)
  if (replyBlocks.length > 0) {
    working = tidy(removeControlBlocks(working, replyBlocks))
  }
  // The scanner reads a later opening tag of an open block's name as part of it, so each further
  // open cue or group block shows only after the one before it is gone: read again, a bounded
  // number of times, until none is left, so the strip is idempotent.
  let openPresentationCutTag: string | undefined
  for (let rescan = 0; firstOpen.length > 0; rescan += 1) {
    const more = openPresentationBlocks(findControlBlocks(working, { final: true }))
    if (more.length === 0) break
    if (rescan >= OPEN_PRESENTATION_RESCAN_LIMIT) {
      openPresentationCutTag = more[0].tag
      working = tidy(working.slice(0, more[0].start))
      break
    }
    unclosedPresentationTags.push(...more.map((block) => block.tag))
    const current = working
    working = tidy(removeControlBlocks(current, more.map((block) => openPresentationRemoval(current, block))))
  }
  let zipPayload = zip.payload
  let hadZipControlBlock = zip.hadBlock
  if (zip.hadBlock) {
    working = stripBareHiddenControlPayloads(working)
  } else {
    const bare = extractTrailingBareHiddenControl(working, 'zip')
    if (bare) {
      hadZipControlBlock = true
      zipPayload = bare.payload
      working = bare.cleaned
    }
  }

  const notesPayload = notes.payload
  const holdBlocks = (
    notesPayload?.blocks ?? (notesPayload ? [{ hold: notesPayload.hold, release: notesPayload.release }] : [])
  ).filter((block) => block.hold.length > 0 || block.release.length > 0)
  return {
    cleaned: working,
    hadNotesBlock: notes.hadBlock,
    notesBlockCount: notes.blockCount,
    notes: notesPayload?.notes ?? [],
    hold: notesPayload?.hold ?? [],
    release: notesPayload?.release ?? [],
    holdBlocks,
    ...(notes.parseError ? { notesParseError: notes.parseError } : {}),
    unknownNotesKeys: notesPayload?.unknownKeys ?? [],
    invalidHoldEntries: notesPayload?.invalidEntries ?? [],
    hadZipControlBlock,
    unzip: zipPayload?.unzip ?? [],
    zip: zipPayload?.zip ?? [],
    ...(zip.parseError ? { zipControlParseError: zip.parseError } : {}),
    legacyNotesDropped: zipPayload?.legacyNotesDropped === true,
    memoryBlocks,
    unclosedPresentationTags,
    ...(openPresentationCutTag ? { openPresentationCutTag } : {})
  }
}

/**
 * The reply as it is stored and shown: every notes, memory, and zip-control block removed, and a
 * cue or group block left open without its tag and payload line (BL-695).
 */
export function stripReplyControlBlocks(content: string): string {
  return extractReplyControl(content).cleaned
}

export interface ReplyControlMetadata {
  /** Stored at `metadata.zipControl` (the Tool Notes storage location is unchanged). */
  zipControl?: {
    unzip: string[]
    zip: string[]
    toolResultsSummary: ZipControlToolSummary[]
    hold?: string[]
    release?: string[]
    parseError?: string
  }
  controlErrors: ControlErrorRecord[]
}

/** BL-1785: the loud line for notes sent while Tool Notes are off. */
export const TOOL_NOTES_OFF_NOT_SAVED = 'Tool Notes are off for this agent; the notes in this reply were not saved.'

/**
 * The metadata a reply's notes and zip-control blocks leave on the stored message, with the same
 * rules the chat page applied: notes are kept only when Tool Notes are on for the agent, and every
 * malformed or unknown part is a loud `controlErrors` record (DL-104-05), never a silent drop.
 */
export function buildReplyControlMetadata(
  extraction: ReplyControlExtraction,
  options: { toolNotesEnabled: boolean; whiteboardAvailable?: boolean }
): ReplyControlMetadata {
  const controlErrors: ControlErrorRecord[] = []
  const blockHint = toolNotesBlockHint(options.toolNotesEnabled)
  if (!options.toolNotesEnabled && extraction.notes.length > 0) {
    // BL-1785 (Josh, 2026-10-19, option B): notes sent while Tool Notes are off are not kept, and
    // the agent is told so; holds and releases in the same block still apply. A hold-only block
    // sends no notes and gets no line.
    controlErrors.push(buildControlErrorRecord(
      'batshit-tool-notes',
      TOOL_NOTES_OFF_NOT_SAVED,
      // Notes are often about results that are not files, which Hold cannot keep (review S1).
      options.whiteboardAvailable
        ? 'Put what you still need on your Whiteboard, or hold a file you still need open; Fetch Zip shows any earlier result again.'
        : 'Hold a file you still need open; Fetch Zip shows any earlier result again.'
    ))
  }
  if (extraction.zipControlParseError) {
    controlErrors.push(
      buildControlErrorRecord('batshit-zip-control', extraction.zipControlParseError, ZIP_CONTROL_BLOCK_HINT)
    )
  }
  if (extraction.legacyNotesDropped) {
    controlErrors.push(
      buildControlErrorRecord(
        'batshit-zip-control',
        'Tool Notes fields inside the zip-control block were dropped.',
        options.toolNotesEnabled
          ? 'Tool Notes moved to their own block: <batshit-tool-notes>{"notes":[{"toolName":"...","summary":"..."}]}</batshit-tool-notes>.'
          : blockHint
      )
    )
  }
  // BL-1785: with Tool Notes off the block is named by its tag and nothing says notes are kept.
  const blockName = options.toolNotesEnabled ? 'Tool Notes' : '<batshit-tool-notes>'
  const notesKept = options.toolNotesEnabled ? 'the notes are kept together, and ' : ''
  if (extraction.notesBlockCount > TOOL_NOTES_BLOCK_LIMIT) {
    // BL-543: past the limit the rest are removed but not read, and the agent is told which.
    controlErrors.push(
      buildControlErrorRecord(
        'batshit-tool-notes',
        `This reply had ${extraction.notesBlockCount} ${blockName} blocks. Batshit read the first ${TOOL_NOTES_BLOCK_LIMIT} and ignored the other ${extraction.notesBlockCount - TOOL_NOTES_BLOCK_LIMIT}: ${options.toolNotesEnabled ? 'their notes were not kept and ' : ''}their holds and releases were not applied. Of the blocks read, ${notesKept}for a file named in more than one block the last hold or release counts.`,
        `Write one ${blockName} block, at the end of the reply. ${blockHint}`
      )
    )
  } else if (extraction.notesBlockCount > 1) {
    controlErrors.push(
      buildControlErrorRecord(
        'batshit-tool-notes',
        `This reply had ${extraction.notesBlockCount} ${blockName} blocks. Batshit read them all: ${notesKept}for a file named in more than one block the last hold or release counts.`,
        `Write one ${blockName} block, at the end of the reply. ${blockHint}`
      )
    )
  }
  if (extraction.notesParseError) {
    // BL-1785 (review): an empty block's error teaches the notes form; off, it teaches hold/release.
    const parseError = options.toolNotesEnabled
      ? extraction.notesParseError
      : extraction.notesParseError
        .replaceAll(TOOL_NOTES_EMPTY_BLOCK_ERROR, TOOL_NOTES_OFF_EMPTY_BLOCK_ERROR)
        .replace(/\bTool Notes block (\d+) of (\d+):/g, '<batshit-tool-notes> block $1 of $2:')
    controlErrors.push(buildControlErrorRecord('batshit-tool-notes', parseError, blockHint))
  }
  for (const tag of extraction.unclosedPresentationTags) {
    // BL-695: loud, never a silent drop (R3).
    controlErrors.push(
      buildControlErrorRecord(
        tag,
        `Unclosed <${tag}> block (missing </${tag}>): its tag and payload were removed, and the rest of the reply was kept.`,
        PRESENTATION_BLOCK_HINTS[tag]
      )
    )
  }
  if (extraction.openPresentationCutTag) {
    const tag = extraction.openPresentationCutTag
    controlErrors.push(
      buildControlErrorRecord(
        tag,
        `This reply had more than ${OPEN_PRESENTATION_RESCAN_LIMIT + 1} unclosed presentation blocks; Batshit removed them one by one and cut the reply at the next <${tag}>.`,
        PRESENTATION_BLOCK_HINTS[tag]
      )
    )
  }
  if (extraction.unknownNotesKeys.length > 0) {
    const keys = extraction.unknownNotesKeys.map((key) => `"${key}"`).join(', ')
    controlErrors.push(
      buildControlErrorRecord(
        'batshit-tool-notes',
        `The ${blockName} block does not know ${keys}; ${extraction.unknownNotesKeys.length === 1 ? 'it was' : 'they were'} ignored.`,
        blockHint
      )
    )
  }
  for (const entry of extraction.invalidHoldEntries) {
    controlErrors.push(
      buildControlErrorRecord(
        'batshit-tool-notes',
        `"${entry.key}" takes file paths; ${entry.value || 'an empty entry'} is not one and was ignored.`,
        blockHint
      )
    )
  }

  const hasBlock =
    extraction.hadNotesBlock ||
    extraction.hadZipControlBlock ||
    Boolean(extraction.notesParseError) ||
    Boolean(extraction.zipControlParseError)
  if (!hasBlock) return { controlErrors }

  return {
    zipControl: {
      unzip: extraction.unzip,
      zip: extraction.zip,
      toolResultsSummary: options.toolNotesEnabled ? extraction.notes : [],
      ...(extraction.hold.length > 0 ? { hold: extraction.hold } : {}),
      ...(extraction.release.length > 0 ? { release: extraction.release } : {}),
      ...(extraction.zipControlParseError ? { parseError: extraction.zipControlParseError } : {})
    },
    controlErrors
  }
}

/**
 * Whether an agent's Tool Notes are on: its own setting, else the user's global zip settings,
 * else ON. The compiler (what the agent is told) and the reply-end step (what is stored) read
 * this one rule.
 */
export function resolveZipToolNotesEnabled(
  agent: { readonly [field: string]: unknown } | null | undefined,
  globalZipSettings: { readonly [field: string]: unknown } | null | undefined
): boolean {
  if (typeof agent?.zip_tool_notes_enabled === 'boolean') return agent.zip_tool_notes_enabled
  if (typeof globalZipSettings?.zip_tool_notes_enabled === 'boolean') return globalZipSettings.zip_tool_notes_enabled
  return true
}
