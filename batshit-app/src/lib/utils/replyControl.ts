/**
 * SA-129 P2 (DL-08): the control blocks at the end of a finished reply, read in ONE place.
 *
 * An agent may end a reply with three hidden blocks: `<batshit-tool-notes>` (its notes, plus the
 * files it holds or releases, DL-02), `<batshit-memory>` (one save per block), and the parked
 * `<batshit-zip-control>` (zip actions by id; applied only when the hidden permission is ON).
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
  type ToolNotesHoldBlock,
  type ToolNotesPayload,
  type ZipControlToolSummary
} from './zipControl'

/** The metadata flag that says the server finalized this reply's control blocks. */
export const REPLY_CONTROL_FINALIZED_FLAG = 'replyControlFinalized'

export const TOOL_NOTES_BLOCK_HINT =
  'Use <batshit-tool-notes>{"notes":[{"toolName":"...","summary":"exact fact(s)"}],"hold":["path/to/file"],"release":["path/to/file"]}</batshit-tool-notes>; every key is optional.'

export const ZIP_CONTROL_BLOCK_HINT =
  'Wrap valid JSON like {"unzip":["tool_result_1"],"zip":["zipId"]} inside <batshit-zip-control>...</batshit-zip-control>.'

export interface ReplyControlExtraction {
  /** The reply with every notes, memory, and zip-control block removed. */
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
}

const REPLY_BLOCK_IDS = new Set(['tool-notes', 'memory', 'zip-control'])

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
  // `<batshit-` in full is the start of a cut block and is hidden, with no error (R4).
  const replyBlocks = blocks.filter((block) => REPLY_BLOCK_IDS.has(block.id) || block.kind === 'held-start')
  if (replyBlocks.length > 0) {
    working = removeControlBlocks(working, replyBlocks).replace(/\n{3,}/g, '\n\n').trim()
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
    memoryBlocks
  }
}

/** The reply as it is stored and shown: every notes, memory, and zip-control block removed. */
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

/**
 * The metadata a reply's notes and zip-control blocks leave on the stored message, with the same
 * rules the chat page applied: notes are kept only when Tool Notes are on for the agent, and every
 * malformed or unknown part is a loud `controlErrors` record (DL-104-05), never a silent drop.
 */
export function buildReplyControlMetadata(
  extraction: ReplyControlExtraction,
  options: { toolNotesEnabled: boolean }
): ReplyControlMetadata {
  const controlErrors: ControlErrorRecord[] = []
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
        'Tool Notes moved to their own block: <batshit-tool-notes>{"notes":[{"toolName":"...","summary":"..."}]}</batshit-tool-notes>.'
      )
    )
  }
  if (extraction.notesBlockCount > TOOL_NOTES_BLOCK_LIMIT) {
    // BL-543: past the limit the rest are removed but not read, and the agent is told which.
    controlErrors.push(
      buildControlErrorRecord(
        'batshit-tool-notes',
        `This reply had ${extraction.notesBlockCount} Tool Notes blocks. Batshit read the first ${TOOL_NOTES_BLOCK_LIMIT} and ignored the other ${extraction.notesBlockCount - TOOL_NOTES_BLOCK_LIMIT}: their notes were not kept and their holds and releases were not applied. Of the blocks read, the notes are kept together, and for a file named in more than one block the last hold or release counts.`,
        `Write one Tool Notes block, at the end of the reply. ${TOOL_NOTES_BLOCK_HINT}`
      )
    )
  } else if (extraction.notesBlockCount > 1) {
    controlErrors.push(
      buildControlErrorRecord(
        'batshit-tool-notes',
        `This reply had ${extraction.notesBlockCount} Tool Notes blocks. Batshit read them all: the notes are kept together, and for a file named in more than one block the last hold or release counts.`,
        `Write one Tool Notes block, at the end of the reply. ${TOOL_NOTES_BLOCK_HINT}`
      )
    )
  }
  if (extraction.notesParseError) {
    controlErrors.push(buildControlErrorRecord('batshit-tool-notes', extraction.notesParseError, TOOL_NOTES_BLOCK_HINT))
  }
  if (extraction.unknownNotesKeys.length > 0) {
    const keys = extraction.unknownNotesKeys.map((key) => `"${key}"`).join(', ')
    controlErrors.push(
      buildControlErrorRecord(
        'batshit-tool-notes',
        `The Tool Notes block does not know ${keys}; ${extraction.unknownNotesKeys.length === 1 ? 'it was' : 'they were'} ignored.`,
        TOOL_NOTES_BLOCK_HINT
      )
    )
  }
  for (const entry of extraction.invalidHoldEntries) {
    controlErrors.push(
      buildControlErrorRecord(
        'batshit-tool-notes',
        `"${entry.key}" takes file paths; ${entry.value || 'an empty entry'} is not one and was ignored.`,
        TOOL_NOTES_BLOCK_HINT
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
