import { redisStreamService } from '$lib/server/redisStreamService';
import { createPermanentZip } from '$lib/server/zipService';
import type { ZipReference } from '$lib/server/zipService';
import { getTypeZipSettings } from '$lib/utils/toolRenderMap';
import { Lexer, getDefaults } from 'marked';
import {
  CHAT_MARKDOWN_OPTIONS,
  codeRegionAt,
  findCodeRegions,
  isInCodeRegion,
  type CodeRegion
} from '$lib/utils/markdownCodeRegions';
import { errorBlockFences, findErrorBlockClose } from '$lib/utils/structuredTagScan';
import { scanZipReferences } from '$lib/utils/zipReferenceSafety';

type ZipType = 'error';

interface StreamProcessingResult {
  shouldStream: boolean;
  content: string;
}

/**
 * The one assistant XML block still zipped here: `<error>...</error>` (either case). Fenced code
 * is not zipped; tools are zipped by the managed lanes at tool-result time.
 *
 * BL-489: a block is a MATCHED pair only. The opening tag counts when it lies outside code (as
 * the chat's Markdown view draws it: `findCodeRegions`, the same reader the control grammar uses)
 * and outside a zip reference; the block ends at the first closing tag after it that is not inside
 * a fence that opened in the block (BL-779 d, `findErrorBlockClose`, the chat view's rule too). A
 * block never spans a zip reference (a tool card): the opening tag and its words stay text. An
 * opening tag with no closing tag is text: the words after it are held while the reply streams
 * (the pair may still close) and handed back, in order, when the reply ends or a tool card comes.
 *
 * BL-779 (a): a closed pair whose opening tag follows a stray backtick in its paragraph may still
 * turn out to be code, when a later run of the same length pairs with it; such a pair is held,
 * with the words after it, until that is settled: handed back as text when it became code, zipped
 * at a blank line, a tool card, or the reply's end. The held words are taken with `takeHeldText`
 * (which settles them) before a tool card (`/api/sse`) and by the finalize's flush before it closes
 * the reply (`flushHeldReplyText`, BL-775); `releaseEndedReply` hands them back as words at
 * `complete` or `error`, after the save.
 */
const OPEN_TAG = /<error>/gi;
const OPEN_TAG_TEXT = '<error>';
const CLOSE_TAG_LENGTH = '</error>'.length;
const ZIP_TYPE: ZipType = 'error';
const ZIP_REFERENCE_OPEN = '{{batshit-zip:';
const BLANK_LINE = /\r?\n[ \t]*\r?\n/;

interface OpenBlock {
  /** The opening tag as written. */
  tag: string;
  /** The words after it so far (for a held pair: its words, its closing tag, and the words after). */
  body: string;
  /**
   * Where in `body` the next chunk's search for the closing tag starts (BL-779 d). Unset: a closing
   * tag's length before the new words. A last line that may be a fence's opening line still being
   * written is searched again, since a backtick later on the line means it opened no fence.
   */
  searchFrom?: number;
  /** BL-779 (a), a held pair: where its closing tag starts in `body`, and one past its end. */
  closeAt?: number;
  pairEnd?: number;
  /**
   * BL-779 (a), a held pair: the lengths a later backtick run needs to pair with a stray one before
   * the tag (`heldPairReading`). The reply is read again for code only when the new words bring a
   * run of one of these lengths.
   */
  openerLengths?: number[];
  /**
   * BL-779 (a), a held pair whose paragraph is a top-level one: the whole lines after the tag's own
   * line are read as they come (`readWholeLines`), and one that ends the paragraph settles the pair.
   * Absent: only a blank line, a tool card, or the reply's end settles it.
   */
  lines?: WholeLines;
  /**
   * BL-779 (a): the last chunk read the tag as code that the next words can still undo
   * (`codeMayBeUndone`); the block waits, unread for a close, until they decide.
   */
  codeUndecided?: boolean;
  /** Where in `body` the next search for a zip reference's opening starts (review N-a). */
  referenceFrom?: number;
  /** Where the last line of `body` begins, and how far `body` was read for line ends (`lastLineStartOf`). */
  lineScan?: { lineStart: number; scannedTo: number; fenceMark: boolean };
  /**
   * BL-779 (a), review N-a (BL-1803): an open block whose tag's paragraph has ended (a blank line, or
   * a line that ends it for good), so no later run can pair over the tag: it is no longer read for code.
   */
  codeSettled?: boolean;
}

/**
 * BL-779 (a): where the reading of a held pair's whole lines is. `lineStart` is where the next
 * line not read yet begins in the block's words (-1: the tag's own line has not ended), and
 * `searchFrom` where the next search for a line's end starts (every line end before it was read).
 */
interface WholeLines {
  lineStart: number;
  searchFrom: number;
}

/**
 * BL-759: the scan state as it was before one run of a segment's chunks (a managed lane's
 * segment: one vendor message). Marks stack up while consecutive runs are all segments; words with
 * no segment, or held words handed back before a tool card, clear the stack. The run on top can be
 * taken back exactly by restoring its mark.
 */
interface SegmentMark {
  segmentId: string;
  emittedLength: number;
  open: OpenBlock | null;
  heldStart: string;
  referenceCount: number;
}

/** At most this many marks are kept; an older segment is then `superseded`. */
const MAX_SEGMENT_MARKS = 64;

interface MessageScanState {
  /** What this message has handed back so far, as the chat view reads it (zips as references). */
  emitted: string;
  open: OpenBlock | null;
  /**
   * A chunk's last words that the next chunk decides: characters that could still become an
   * opening tag (`<`, `<e`, ... `<erro`), or an opening tag and the words after it whose code
   * reading the next words can still change (BL-779 a, `findOpeningTag`'s `undecided`).
   */
  heldStart: string;
  /** BL-759: the marks of the runs read since the last words with no segment (top = last run). */
  marks: SegmentMark[];
  /** BL-759: how many runs of each segment were read (a segment read in two runs is never rewound). */
  runs: Map<string, number>;
}

/**
 * BL-759: what `discardSegment` did.
 * - `rewound`: the segment was the last run read, in one run, and the scan state is exactly as it
 *   was before it; the zips made while it was read are handed back to be removed.
 * - `superseded`: other words were read after it, or it was read in two runs. Its words cannot be
 *   taken out of the scan state exactly, so NOTHING is changed: the caller must not trust the
 *   reply's stream record (send-routed then saves its own copy, which is taken back by segment).
 *   The removed Codex adapter handed on a retract before any other text reached the stream, so
 *   this is an error case.
 * - `unknown`: the detector never read that segment (or already took it back).
 */
export type SegmentDiscardOutcome = 'rewound' | 'unknown' | 'superseded';

/** The longest end of `text` that is the start of an opening tag (either case), shorter than the tag. */
function partialOpeningTagAtEnd(text: string): number {
  const max = Math.min(OPEN_TAG_TEXT.length - 1, text.length);
  for (let length = max; length > 0; length -= 1) {
    if (text.slice(-length).toLowerCase() === OPEN_TAG_TEXT.slice(0, length)) return length;
  }
  return 0;
}

/** A copy of an open block for a segment mark (BL-759), its line reading included (it is read in place). */
function copyOpenBlock(open: OpenBlock): OpenBlock {
  return {
    ...open,
    lines: open.lines ? { ...open.lines } : undefined,
    lineScan: open.lineScan ? { ...open.lineScan } : undefined
  };
}

function createBufferKey(sessionId: string, messageId: string) {
  return `${sessionId}:${messageId}`;
}

/** One past the last blank line before `index` (as `BLANK_LINE` reads one), or 0. */
function paragraphStartBefore(text: string, index: number): number {
  let lineEnd = text.lastIndexOf('\n', index - 1);
  while (lineEnd > 0) {
    const previous = text.lastIndexOf('\n', lineEnd - 1);
    if (/^[ \t]*\r?$/.test(text.slice(previous + 1, lineEnd))) return lineEnd + 1;
    lineEnd = previous;
  }
  return 0;
}

const BACKTICK = 96;
const BACKSLASH = 92;

/**
 * BL-779 (a): how the tag at `openAt` of `text` (the reply so far; the tag is not code now) may
 * still turn out to be code. It can when its paragraph has a backtick run before the tag, outside
 * code, that no run has closed (an opener): a later run of the opener's length, before the
 * paragraph ends, would pair with it over the tag, as the full-reply pass reads the whole reply.
 * The paragraph runs from the last blank line before the tag.
 * - `openerLengths`: the lengths such a later run needs (a run's own length; the opener's less a
 *   backtick a backslash takes out, as the code-span rule reads it). Empty when there is no opener.
 * - `lines`, when there is an opener and the paragraph is a top-level one (it begins at the start
 *   of its line, with no indentation, and the Markdown reader reads it alone as one paragraph): the
 *   whole lines after the tag's line are read as they come (`readWholeLines`), and one that ends the
 *   paragraph for good is told from that line alone (`lineEndsParagraph`). Inside a list item or a
 *   quote that rule does not hold, so there only a blank line ends it.
 * - `ended`: the words already written after the tag end its paragraph (a blank line, or such a
 *   line), so no later run can pair over the tag.
 * `regions` are the code regions of `text` when the caller has them. At most one read of the reply
 * for code, and one of the paragraph's own lines.
 */
function tagParagraphReading(
  text: string,
  openAt: number,
  bodyStart: number,
  regions?: readonly CodeRegion[]
): { openerLengths: number[]; lines?: WholeLines; ended: boolean } {
  const ended = BLANK_LINE.test(text.slice(openAt));
  const paragraphStart = paragraphStartBefore(text, openAt);
  if (ended || !text.slice(paragraphStart, openAt).includes('`')) return { openerLengths: [], ended };
  const codeRegions = regions ?? findCodeRegions(text);
  const openerLengths = new Set<number>();
  for (let at = text.indexOf('`', paragraphStart); at !== -1 && at < openAt; ) {
    let end = at;
    while (end < openAt && text.charCodeAt(end) === BACKTICK) end += 1;
    if (!isInCodeRegion(codeRegions, at)) {
      let slashes = 0;
      for (let before = at - 1; before >= paragraphStart && text.charCodeAt(before) === BACKSLASH; before -= 1) slashes += 1;
      const length = end - at - (slashes % 2);
      if (length > 0) openerLengths.add(length);
    }
    at = text.indexOf('`', end);
  }
  if (openerLengths.size === 0) return { openerLengths: [], ended: false };

  const tagLineEnd = text.indexOf('\n', openAt);
  const paragraphSoFar = text.slice(paragraphStart, tagLineEnd === -1 ? text.length : tagLineEnd);
  const tokens = /^\s/.test(paragraphSoFar) ? [] : markdownBlocks(paragraphSoFar);
  const topLevel = tokens.length === 1 && tokens[0].type === 'paragraph';
  if (!topLevel) return { openerLengths: [...openerLengths], ended: false };
  const lines: WholeLines = { lineStart: -1, searchFrom: 0 };
  // The lines already written after the tag's own line may have ended the paragraph.
  return { openerLengths: [...openerLengths], lines, ended: readWholeLines(text.slice(bodyStart), lines) };
}

/**
 * BL-779 (a): how a closed pair whose opening tag is at `openAt` of `text` may still turn out to be
 * code (`tagParagraphReading`), or null when it cannot (no opener, or its paragraph ended), so it is
 * zipped at once. One read of the reply for code, and of the paragraph's own lines, per pair held.
 */
function heldPairReading(
  text: string,
  openAt: number,
  bodyStart: number
): { openerLengths: number[]; lines?: WholeLines } | null {
  const reading = tagParagraphReading(text, openAt, bodyStart);
  return reading.openerLengths.length > 0 && !reading.ended ? reading : null;
}

/** The chat's Markdown reader's blocks of `text`, read alone (`CHAT_MARKDOWN_OPTIONS`). */
function markdownBlocks(text: string) {
  return new Lexer({ ...getDefaults(), ...CHAT_MARKDOWN_OPTIONS }).blockTokens(text, []);
}

/**
 * The blocks that end a paragraph for good when a line starts one: the Markdown reader's setext
 * heading never takes a list item, an ATX heading, a fence, a quote, or an HTML block into its
 * words, whatever underline comes later.
 */
const PARAGRAPH_ENDING_BLOCKS: ReadonlySet<string> = new Set(['list', 'heading', 'code', 'blockquote', 'html']);

/**
 * BL-779 (a): whether a whole line written right after a top-level paragraph's line ends that
 * paragraph for good, as the chat's Markdown reader reads it, so a backtick after it can no longer
 * pair with one before it. Read from the line alone, after a stand-in line.
 * - A line that starts a list item, an ATX heading, a fence, a quote, or an HTML block ends it.
 * - A setext underline ends it only when the line alone is a rule (`---`): the reader makes no
 *   setext heading of a paragraph with a line that starts an HTML block (an `<error>` alone on its
 *   line), and then `===` is the paragraph's words (review S1'); `---` ends it either way.
 * - A rule that is no underline (`***`, `___`) does not count: a later setext underline takes it,
 *   and the lines around it, into one heading's words.
 * - Nor does a line that makes a table of the line before it (that changes how that line reads).
 * Not counted, a held pair waits for a blank line.
 */
function lineEndsParagraph(line: string): boolean {
  const whole = line.replace(/\r$/, '');
  const [first, second] = markdownBlocks(`x\n${whole}\n`);
  if (!first) return false;
  if (first.type === 'heading' && first.raw.startsWith('x\n')) return markdownBlocks(`${whole}\n`)[0]?.type === 'hr';
  if (first.type !== 'paragraph' || first.raw.replace(/\n+$/, '') !== 'x') return false;
  return second !== undefined && PARAGRAPH_ENDING_BLOCKS.has(second.type);
}

/**
 * BL-779 (a): reads the whole lines of a held pair's words (`words`, from just after its opening
 * tag) that end after `lines` was last read, and answers whether one of them ends the pair's
 * paragraph (`lineEndsParagraph`). Each line is read once, when its end comes.
 */
function readWholeLines(words: string, lines: WholeLines): boolean {
  for (let end = words.indexOf('\n', lines.searchFrom); end !== -1; end = words.indexOf('\n', end + 1)) {
    if (lines.lineStart !== -1 && lineEndsParagraph(words.slice(lines.lineStart, end))) return true;
    lines.lineStart = end + 1;
  }
  lines.searchFrom = words.length;
  return false;
}

/**
 * BL-779 (a): whether the new words of a held pair (those after `previousLength` of `words`) bring a
 * backtick run of one of `lengths`: only such a run can pair with a stray one before the tag. A run
 * the new words continue is read whole; a run they leave unfinished at the end is read again with
 * the next chunk.
 */
function newRunOfLength(words: string, previousLength: number, lengths: readonly number[]): boolean {
  let at = previousLength;
  while (at > 0 && words.charCodeAt(at - 1) === BACKTICK) at -= 1;
  for (at = words.indexOf('`', at); at !== -1; ) {
    let end = at;
    while (end < words.length && words.charCodeAt(end) === BACKTICK) end += 1;
    if (end > previousLength && lengths.includes(end - at)) return true;
    at = words.indexOf('`', end);
  }
  return false;
}

/**
 * Where the next chunk's search for an open block's closing tag starts in its words (`open.body`):
 * a closing tag's length before the new words, or the start of the last line when that line may be
 * a fence's opening line still being written (BL-779 d: a closing tag on it was read as fenced, and
 * a backtick later on the line would mean the line opened no fence). The line is read once
 * (`lastLineStartOf`).
 */
function nextCloseSearchFrom(open: OpenBlock): number {
  const lastLineStart = Math.max(0, lastLineStartOf(open));
  const overlap = Math.max(0, open.body.length - CLOSE_TAG_LENGTH + 1);
  return open.lineScan?.fenceMark ? Math.min(lastLineStart, overlap) : overlap;
}

/**
 * Whether a blank line (as `BLANK_LINE` reads one) ends in the words after `previousLength` of
 * `words`: one that ends before them was found already. Reads the new words and, back from each of
 * their line ends, only the spaces before it: never the long lines already read again.
 */
function blankLineEnds(words: string, previousLength: number): boolean {
  for (let at = words.indexOf('\n', previousLength); at !== -1; at = words.indexOf('\n', at + 1)) {
    let before = at - 1;
    if (before >= 0 && words.charCodeAt(before) === 13) before -= 1;
    while (before >= 0 && (words[before] === ' ' || words[before] === '\t')) before -= 1;
    if (before >= 0 && words[before] === '\n') return true;
  }
  return false;
}

/**
 * Whether `words[from, to)` is a line that can change how the paragraph above it is grouped: a
 * setext underline or a table's delimiter row (up to three spaces, then only `-`, `=`, `|`, `:`,
 * spaces and tabs, starting with one of the four; a CR may end it). Reads only until it cannot be.
 */
function isRegroupingLine(words: string, from: number, to: number): boolean {
  let at = from;
  while (at < to && at - from < 3 && words[at] === ' ') at += 1;
  if (at >= to || !'-=|:'.includes(words[at])) return false;
  for (at += 1; at < to; at += 1) {
    if (!'-=|: \t'.includes(words[at]) && !(words[at] === '\r' && at === to - 1)) return false;
  }
  return true;
}

/**
 * BL-779 (a): whether the new words of a held block (those after `previousLength` of `words`; the
 * line they continue starts at `lineStart`, -1 for the tag's own line) end a line that can change how
 * the tag's paragraph is grouped (`isRegroupingLine`). The Markdown reader groups a paragraph by such
 * a line after it (a setext underline splits a paragraph at a line that starts an HTML block; a
 * delimiter row makes the line above a table's header), so two backtick runs already written can
 * pair over the tag, or no longer, without a new run (review S1'). A line counts only once it is
 * whole (review S3): `-` with the rest of its line still to come is as often a list item's marker,
 * and while the last line may still be such a line no reading of the tag is acted on
 * (`unfinishedRegroupingLine`). Reads the new words, and the old line only until it cannot be one.
 */
function regroupingLineTouched(words: string, previousLength: number, lineStart: number): boolean {
  let from = lineStart;
  for (let end = words.indexOf('\n', previousLength); end !== -1; end = words.indexOf('\n', from)) {
    if (from >= 0 && isRegroupingLine(words, from, end)) return true;
    from = end + 1;
  }
  return false;
}

/**
 * BL-779 (a), review S3: whether the tag at `at` of `text` (the reply so far) is in a paragraph
 * whose next line, the last one, is still unfinished and could yet regroup it
 * (`unfinishedRegroupingLine`): no blank line lies between them. Its reading waits for that line.
 */
function tagAboveUnfinishedRegroupingLine(text: string, at: number): boolean {
  const lastLineStart = text.lastIndexOf('\n') + 1;
  if (lastLineStart <= at || !unfinishedRegroupingLine(text, lastLineStart)) return false;
  return !BLANK_LINE.test(text.slice(at, lastLineStart));
}

/**
 * BL-779 (a), review S3: whether the last line of `words`, from `lineStart` (-1: the tag's own line,
 * never one), is still unfinished and could yet be a line that regroups the paragraph above it.
 * A reading of a tag in that paragraph is not decided while it is: it is made again once the line
 * ends (when it is whole and still such a line, `regroupingLineTouched` reads it then). A line with a
 * character that rules it out can never become one again; an empty or space-only last line counts as
 * not begun, so a reading made then can still be regrouped by the line that follows (BL-1781's class).
 */
function unfinishedRegroupingLine(words: string, lineStart: number): boolean {
  return lineStart >= 0 && isRegroupingLine(words, lineStart, words.length);
}

/**
 * Where the last line of an open block's words (`body`) begins (-1 while it is the tag's own line),
 * and whether that line holds a backtick fence mark (`open.lineScan.fenceMark`), read forward from
 * where the last call stopped, so a long line is never read back again.
 */
function lastLineStartOf(open: OpenBlock): number {
  const scan = (open.lineScan ??= { lineStart: -1, scannedTo: 0, fenceMark: false });
  const lineStartBefore = scan.lineStart;
  for (let at = open.body.indexOf('\n', scan.scannedTo); at !== -1; at = open.body.indexOf('\n', at + 1)) {
    scan.lineStart = at + 1;
  }
  const markFrom = Math.max(0, scan.lineStart === lineStartBefore ? Math.max(scan.lineStart, scan.scannedTo - 2) : scan.lineStart);
  scan.fenceMark = (scan.lineStart === lineStartBefore && scan.fenceMark) || open.body.includes('```', markFrom);
  scan.scannedTo = open.body.length;
  return scan.lineStart;
}

/**
 * BL-779 (d): whether the last line of a block's words (`rest`), still unfinished and holding a
 * backtick fence mark, has a closing tag before `before` (where a zip reference starts in `rest`):
 * one the close search skipped as fenced, which a backtick later on the line can make the block's
 * close after all (see `nextCloseSearchFrom`).
 */
function skippedCloseOnUnfinishedFenceLine(rest: string, before: number): boolean {
  const lastLineStart = rest.lastIndexOf('\n') + 1;
  if (before < lastLineStart) return false;
  const line = rest.slice(lastLineStart, before);
  return line.includes('```') && /<\/error>/i.test(line);
}

/**
 * BL-779: whether `at` lies on the last line of `text` (the reply so far), still unfinished, after
 * a fence mark on that line. Whether such a line is a fence is decided only when the line ends:
 * the Markdown reader takes a fence line right after a paragraph as the paragraph's words until its
 * newline comes, and a backtick later on a backtick fence's line means it opened no fence.
 */
function onUnfinishedFenceLine(text: string, at: number): boolean {
  if (text.includes('\n', at)) return false;
  const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
  return line.includes('```') || line.includes('~~~');
}

/**
 * BL-779 (a): whether the code `code` around a tag of `text` (the reply so far) can still be undone
 * by the next words: a span closed by the backtick run that ends the text (the next chunk may make
 * the run longer, and then it closes nothing), or code that ends, or a fence that starts, on the
 * text's last, unfinished line when that line holds a fence mark (once the line ends it may be a
 * fence, or no fence: see `onUnfinishedFenceLine`).
 */
function codeMayBeUndone(code: CodeRegion | null, text: string): boolean {
  if (!code) return false;
  if (code.kind === 'inline' && code.end === text.length) return true;
  const lastLineStart = text.lastIndexOf('\n') + 1;
  const lastLine = text.slice(lastLineStart);
  if (!lastLine.includes('```') && !lastLine.includes('~~~')) return false;
  return code.kind === 'inline' ? code.end > lastLineStart : code.start >= lastLineStart;
}

function insideZipReference(references: ReturnType<typeof scanZipReferences>, index: number) {
  return references.some((ref) => ref.start <= index && index < ref.end);
}

export class ZipDetectionService {
  private readonly streamingBuffers = new Map<string, MessageScanState>();
  private readonly messageZipReferences = new Map<string, ZipReference[]>();
  private readonly messageContexts = new Map<string, { agent?: any; globalSettings?: any; messagesFromEnd?: number }>();
  setContext(
    sessionId: string,
    messageId: string,
    context: { agent?: any; globalSettings?: any; messagesFromEnd?: number }
  ) {
    const key = createBufferKey(sessionId, messageId);
    this.messageContexts.set(key, context);
  }

  private getContext(sessionId: string, messageId: string) {
    const key = createBufferKey(sessionId, messageId);
    return this.messageContexts.get(key);
  }

  private clearContext(sessionId: string, messageId: string) {
    const key = createBufferKey(sessionId, messageId);
    this.messageContexts.delete(key);
  }

  deleteSessionBuffers(sessionId: string) {
    const prefix = `${sessionId}:`;
    for (const key of this.streamingBuffers.keys()) {
      if (key.startsWith(prefix)) {
        this.streamingBuffers.delete(key);
      }
    }
    for (const key of this.messageContexts.keys()) {
      if (key.startsWith(prefix)) {
        this.messageContexts.delete(key);
      }
    }
  }

  clearMessageReferences(messageKey: string) {
    this.messageZipReferences.delete(messageKey);
  }

  /** Every message's zip references of a chat (a deleted chat, BL-775). */
  clearSessionReferences(sessionId: string) {
    const prefix = `${sessionId}:`;
    for (const key of this.messageZipReferences.keys()) {
      if (key.startsWith(prefix)) this.messageZipReferences.delete(key);
    }
  }

  getMessageReferences(sessionId: string, messageId: string): ZipReference[] {
    return [...(this.messageZipReferences.get(`${sessionId}:${messageId}`) || [])];
  }

  /**
   * The words the detector still holds for a reply that ended with `complete` or `error` while
   * they were held (BL-489, BL-779), handed back as words: an open block, a held pair, the start of
   * a tag. Nothing is settled or zipped now: the finalize has saved the reply already, so a zip
   * made now would be named by no saved reply (the finalize's flush takes a recorded reply's held
   * words, settled, before it closes it). Lets go of the message's scan state, zip references and
   * context, as a reply that ends without `end` never reaches `finalizeOpenBlocks`. Empty when
   * nothing is held.
   */
  releaseEndedReply(sessionId: string, messageId: string): string {
    const key = createBufferKey(sessionId, messageId);
    const state = this.streamingBuffers.get(key);
    const text = state ? (state.open ? state.open.tag + state.open.body : '') + state.heldStart : '';
    this.streamingBuffers.delete(key);
    this.messageZipReferences.delete(key);
    this.messageContexts.delete(key);
    return text;
  }

  /**
   * The words the detector holds for this message, handed back where they were written, before a
   * tool card or at the reply's end (BL-779 a). No more words come before the card or the end, so
   * what the next words would have decided is decided now, as the full-reply pass reads it: a pair
   * held after a stray backtick is zipped (its reference is in the text, and in
   * `getMessageReferences`), a tag or a closing tag whose reading waited is read, and the words
   * after it are read too; a block that never closes, and the start of a tag, are handed back as
   * words. Empty when nothing is held. It keeps the message's scan state and zip references
   * (`releaseEndedReply` lets go of them).
   */
  async takeHeldText(sessionId: string, messageId: string): Promise<string> {
    const state = this.streamingBuffers.get(createBufferKey(sessionId, messageId));
    if (!state) return '';
    const held = state.heldStart;
    state.heldStart = '';
    const settled = state.open || held ? await this.scan(sessionId, messageId, state, held, true) : '';
    const unclosed = (state.open ? state.open.tag + state.open.body : '') + state.heldStart;
    state.open = null;
    state.heldStart = '';
    state.emitted += unclosed;
    const text = settled + unclosed;
    // BL-759: the held words went out with no segment; the runs before them can no longer be
    // rewound exactly.
    if (text) state.marks = [];
    return text;
  }

  /**
   * BL-759: takes a segment back out of the scan state (a managed lane retracted it: a message
   * the removed Codex CLI lane dropped and started again). Only the last run read, read in one run, can be
   * taken back: then everything is as it was before its first chunk (what was handed back, an open
   * block and its held words, a held start of a tag, an earlier segment's block it closed), and
   * the zips made while it was read are handed back for the caller to remove. Anything else
   * changes nothing; see `SegmentDiscardOutcome`.
   */
  discardSegment(
    sessionId: string,
    messageId: string,
    segmentId: string
  ): { outcome: SegmentDiscardOutcome; zipReferences: ZipReference[] } {
    const key = createBufferKey(sessionId, messageId);
    const state = this.streamingBuffers.get(key);
    const runs = segmentId ? state?.runs.get(segmentId) ?? 0 : 0;
    if (!state || runs === 0) return { outcome: 'unknown', zipReferences: [] };
    const mark = state.marks[state.marks.length - 1];
    if (!mark || mark.segmentId !== segmentId || runs !== 1) {
      return { outcome: 'superseded', zipReferences: [] };
    }
    state.marks.pop();
    state.runs.delete(segmentId);
    state.emitted = state.emitted.slice(0, mark.emittedLength);
    state.open = mark.open ? copyOpenBlock(mark.open) : null;
    state.heldStart = mark.heldStart;
    const references = this.messageZipReferences.get(key);
    const discarded = references ? references.splice(Math.min(mark.referenceCount, references.length)) : [];
    return { outcome: 'rewound', zipReferences: discarded };
  }

  async finalizeOpenBlocks(sessionId: string, messageId: string): Promise<ZipReference[]> {
    const bufferKey = createBufferKey(sessionId, messageId);
    this.streamingBuffers.delete(bufferKey);
    this.clearContext(sessionId, messageId);

    const messageKey = `${sessionId}:${messageId}`;
    const references = [...(this.messageZipReferences.get(messageKey) || [])];
    this.messageZipReferences.delete(messageKey);

    return references;
  }

  /**
   * One chunk of a streaming reply. `segmentId` (BL-759) names the managed lane's segment the words
   * belong to: what this call hands back or holds is that segment's, and the last run read can be
   * taken back with `discardSegment`. Words with no segment can never be taken back.
   */
  async processChunk(
    sessionId: string,
    messageId: string,
    content: string,
    segmentId?: string | null
  ): Promise<StreamProcessingResult> {
    const bufferKey = createBufferKey(sessionId, messageId);
    let state = this.streamingBuffers.get(bufferKey);
    if (!state) {
      state = { emitted: '', open: null, heldStart: '', marks: [], runs: new Map() };
      this.streamingBuffers.set(bufferKey, state);
    }
    const segment = typeof segmentId === 'string' && segmentId.length > 0 ? segmentId : null;
    if (!segment) {
      state.marks = [];
    } else if (state.marks[state.marks.length - 1]?.segmentId !== segment) {
      state.marks.push({
        segmentId: segment,
        emittedLength: state.emitted.length,
        open: state.open ? copyOpenBlock(state.open) : null,
        heldStart: state.heldStart,
        referenceCount: this.messageZipReferences.get(bufferKey)?.length ?? 0
      });
      if (state.marks.length > MAX_SEGMENT_MARKS) state.marks.shift();
      state.runs.set(segment, (state.runs.get(segment) ?? 0) + 1);
    }

    // A partial opening tag held from the last chunk is decided now, with this chunk after it.
    const pending = state.heldStart + content;
    state.heldStart = '';
    const out = await this.scan(sessionId, messageId, state, pending, false);
    return { shouldStream: out.length > 0, content: out };
  }

  /**
   * Reads `pending` after what the message has handed back and holds, and hands back what it can.
   * `settle` (a tool card or the reply's end, `takeHeldText`) means no more words come before a
   * card or the end: nothing waits for later words then, and a held pair is zipped.
   */
  private async scan(
    sessionId: string,
    messageId: string,
    state: MessageScanState,
    pending: string,
    settle: boolean
  ): Promise<string> {
    let out = '';
    while (pending || state.open) {
      if (state.open) {
        const open = state.open;
        const openAt = state.emitted.length + out.length;
        const text = state.emitted + out + open.tag + open.body + pending;
        const bodyStart = openAt + open.tag.length;
        const rest = open.body + pending;

        // A later backtick can close a code span that began before the tag: then the tag was
        // code all along, and it and the held words are text.
        // A code span never crosses a blank line, so once the held words have one the tag's
        // reading is settled and the whole text is not read again.
        // BL-779 (a): code the next words can still undo (`codeMayBeUndone`) is not decided yet:
        // the block waits for them, unread for a close. A held pair's words have no blank line, and
        // only a new run of a stray backtick's length can make its tag code (review S1: every chunk
        // with any backtick used to read the whole reply again while a pair was held).
        const held = open.pairEnd !== undefined;
        const readForCode = held
          ? open.codeUndecided === true ||
            newRunOfLength(rest, open.body.length, open.openerLengths ?? []) ||
            regroupingLineTouched(rest, open.body.length, lastLineStartOf(open))
          : !open.codeSettled &&
            (open.codeUndecided === true ||
              newRunOfLength(rest, open.body.length, open.openerLengths ?? []) ||
              regroupingLineTouched(rest, open.body.length, lastLineStartOf(open)));
        // Review S3: while the last line may still be a line that regroups the tag's paragraph, a
        // reading of the tag is not acted on; it is made again with the next chunk.
        const pendingNewline = pending.lastIndexOf('\n');
        const restLastLineStart = pendingNewline !== -1 ? open.body.length + pendingNewline + 1 : lastLineStartOf(open);
        const regroupPending = !settle && !open.codeSettled && unfinishedRegroupingLine(rest, restLastLineStart);
        let becameCode = false;
        let codeUndecided = false;
        if (readForCode && regroupPending) {
          codeUndecided = true;
        } else if (readForCode) {
          const code = codeRegionAt(findCodeRegions(text), openAt);
          if (code && !settle && codeMayBeUndone(code, text)) codeUndecided = true;
          else becameCode = code !== null;
        }
        if (codeUndecided) {
          open.searchFrom ??= Math.max(0, open.body.length - CLOSE_TAG_LENGTH + 1);
          open.codeUndecided = true;
          open.body = rest;
          pending = '';
          break;
        }
        open.codeUndecided = undefined;

        if (open.pairEnd !== undefined) {
          // BL-779 (a): a closed pair held while a backtick before it may still make it code. The
          // held words have no blank line (a pair is held only then), so only the new words can
          // end the paragraph: a blank line, or, for a top-level paragraph, a whole line that ends
          // it (a list item, a heading, a fence, a quote, a rule: `lineEndsParagraph`). That, a tool
          // card, or the reply's end settles it.
          if (becameCode) {
            state.open = null;
            out += open.tag;
            pending = rest;
            continue;
          }
          const paragraphEnded =
            blankLineEnds(rest, open.body.length) || (open.lines !== undefined && readWholeLines(rest, open.lines));
          if (settle || paragraphEnded) {
            state.open = null;
            out += await this.zipBlock(sessionId, messageId, rest.substring(0, open.closeAt));
            pending = rest.substring(open.pairEnd);
            continue;
          }
          open.body = rest;
          pending = '';
          break;
        }

        // Review N-a (BL-1803): once the tag's paragraph has ended, no later run can pair over it.
        if (!open.codeSettled && (blankLineEnds(rest, open.body.length) || (open.lines !== undefined && readWholeLines(rest, open.lines)))) {
          open.codeSettled = true;
        }

        // Only the new words (and a closing tag's worth of the old, for a tag split across
        // chunks) can hold a closing tag: the held words were searched already. A closing tag
        // inside a fence that opened in the block does not end it (BL-779 d).
        const searchFrom = open.searchFrom ?? Math.max(0, open.body.length - CLOSE_TAG_LENGTH + 1);
        const close = findErrorBlockClose(text, bodyStart, bodyStart + searchFrom, text.length, () =>
          errorBlockFences(text)
        );
        const closeAt = close ? close.at - bodyStart : -1;
        // Only the new words (and a reference's opening's worth of the old) can start a zip reference,
        // unless one the block waits on is held already (`referenceFrom`).
        const referenceIndex = rest.indexOf(ZIP_REFERENCE_OPEN, open.referenceFrom ?? 0);
        open.referenceFrom = referenceIndex !== -1 ? referenceIndex : Math.max(0, rest.length - ZIP_REFERENCE_OPEN.length + 1);
        const referenceAt = referenceIndex !== -1
          ? scanZipReferences(text).find((ref) => ref.start >= bodyStart)?.start ?? -1
          : -1;
        // A closing tag skipped as fenced on the last, unfinished line may still end the block
        // there (a backtick later on a backtick fence's line means it opened no fence, BL-779 d):
        // a zip reference after it cannot be judged against it until the line ends.
        const closeOnLineUndecided =
          !settle && !close && referenceAt !== -1 && skippedCloseOnUnfinishedFenceLine(rest, referenceAt - bodyStart);
        const spansReference =
          !closeOnLineUndecided && referenceAt !== -1 && (closeAt === -1 || referenceAt - bodyStart < closeAt);

        if (becameCode || spansReference) {
          state.open = null;
          out += open.tag;
          pending = rest;
          continue;
        }

        if (!close) {
          open.body = rest;
          open.searchFrom = nextCloseSearchFrom(open);
          pending = '';
          break;
        }

        if (!settle && onUnfinishedFenceLine(text, close.at)) {
          // The closing tag's line may still turn out to open a fence that holds it: read it
          // again, from the line's start, once the line ends (or at a tool card or the end).
          open.body = rest;
          open.searchFrom = Math.max(0, text.lastIndexOf('\n', close.at - 1) + 1 - bodyStart);
          pending = '';
          break;
        }

        if (regroupPending) {
          // Whether the pair is held or zipped reads the tag's code: decided once the line ends.
          open.body = rest;
          open.searchFrom = closeAt;
          pending = '';
          break;
        }

        const pairEnd = close.end - bodyStart;
        const reading = settle ? null : heldPairReading(text, openAt, bodyStart);
        if (reading) {
          open.body = rest;
          open.closeAt = closeAt;
          open.pairEnd = pairEnd;
          open.openerLengths = reading.openerLengths;
          open.lines = reading.lines;
          pending = '';
          break;
        }

        pending = rest.substring(pairEnd);
        state.open = null;
        out += await this.zipBlock(sessionId, messageId, rest.substring(0, closeAt));
        continue;
      }

      const openAt = this.findOpeningTag(state.emitted + out, pending, settle);
      if (!openAt) {
        // The chunk's last characters may be the start of an opening tag the next chunk
        // finishes: hold them until it decides (a split opening tag opens either way).
        const held = partialOpeningTagAtEnd(pending);
        out += pending.substring(0, pending.length - held);
        state.heldStart = pending.substring(pending.length - held);
        pending = '';
        break;
      }
      if (openAt.undecided) {
        // A tag whose reading the next chunk can still change (BL-779 a): held, with the words
        // after it, until the next chunk decides, as the full-reply pass reads the whole reply.
        out += pending.substring(0, openAt.index);
        state.heldStart = pending.substring(openAt.index);
        pending = '';
        break;
      }

      // Review N-a (BL-1803): how the tag may still turn out to be code is read once, here, so the
      // block is read for code again only when the new words can change that.
      const tagAt = state.emitted.length + out.length + openAt.index;
      const reading = tagParagraphReading(state.emitted + out + pending, tagAt, tagAt + openAt.tag.length, openAt.regions);
      out += pending.substring(0, openAt.index);
      state.open = {
        tag: openAt.tag,
        body: '',
        openerLengths: reading.openerLengths,
        lines: reading.lines,
        codeSettled: reading.ended
      };
      pending = pending.substring(openAt.index + openAt.tag.length);
    }

    state.emitted += out;
    return out;
  }

  /**
   * The first opening tag in `pending` that is outside code and outside a zip reference. Or, when
   * the first such tag's reading the next words can still change (BL-779 a), that tag's place,
   * with `undecided`, and the caller holds the words from there until the next chunk decides: the
   * tag is in code the next words can undo (`codeMayBeUndone`), or it is outside code on a last,
   * unfinished fence line (`onUnfinishedFenceLine`). `settle` (a tool card or the reply's end) means
   * no more words come: the reading is then decided.
   */
  private findOpeningTag(
    before: string,
    pending: string,
    settle: boolean
  ): { index: number; tag: string; undecided?: boolean; regions?: readonly CodeRegion[] } | null {
    OPEN_TAG.lastIndex = 0;
    if (!OPEN_TAG.test(pending)) return null;

    const text = before + pending;
    const regions = findCodeRegions(text);
    const references = text.includes(ZIP_REFERENCE_OPEN) ? scanZipReferences(text) : [];

    OPEN_TAG.lastIndex = 0;
    for (const match of pending.matchAll(OPEN_TAG)) {
      const at = before.length + match.index;
      if (insideZipReference(references, at)) continue;
      const code = codeRegionAt(regions, at);
      const undecided =
        !settle &&
        (codeMayBeUndone(code, text) ||
          (!code && onUnfinishedFenceLine(text, at)) ||
          tagAboveUnfinishedRegroupingLine(text, at));
      if (undecided) return { index: match.index, tag: match[0], undecided };
      if (!code) return { index: match.index, tag: match[0], regions };
    }
    return null;
  }

  /** A matched pair's words as an Error zip; its reference, or the words themselves when no zip is made. */
  private async zipBlock(sessionId: string, messageId: string, blockContent: string): Promise<string> {
    if (!blockContent) return '';

    const context = this.getContext(sessionId, messageId);
    const settings = getTypeZipSettings(ZIP_TYPE, context?.agent, context?.globalSettings);
    const metadata = {
      bufferSize: settings.bufferSize,
      threshold: settings.zipThreshold,
      messagesFromEnd: context?.messagesFromEnd ?? 0
    };

    const blockIndex = await redisStreamService.trackConcurrentBlock(sessionId, messageId, ZIP_TYPE);
    const tempKey = redisStreamService.createTempStorageKey(sessionId, messageId, ZIP_TYPE, blockIndex);
    await redisStreamService.appendChunk(tempKey, blockContent);

    const result = await createPermanentZip(sessionId, messageId, ZIP_TYPE, blockIndex, metadata);
    if (!result) return blockContent;

    this.addZipReference(sessionId, messageId, ZIP_TYPE, blockIndex, result.zipId, result.reference);
    // Stream the final reference immediately so the client never sees placeholders
    return result.reference;
  }

  /**
   * The whole reply at once (send-routed's pass when no tab listened). One scan: a matched pair
   * becomes an Error zip, and an opening tag that never closes stays text where it was (BL-489).
   */
  async processFullContent(
    sessionId: string,
    messageId: string,
    content: string,
    options?: { agent?: any; globalSettings?: any; messagesFromEnd?: number }
  ): Promise<{ content: string; references: ZipReference[] }> {
    if (options) {
      this.setContext(sessionId, messageId, options)
    }

    const result = await this.processChunk(sessionId, messageId, content);
    const processed = result.content + (await this.takeHeldText(sessionId, messageId));

    const references = await this.finalizeOpenBlocks(sessionId, messageId);
    this.deleteSessionBuffers(sessionId);

    return {
      content: processed,
      references
    };
  }

  private addZipReference(
    sessionId: string,
    messageId: string,
    type: ZipType,
    index: number,
    zipId: string,
    reference: string
  ) {
    const messageKey = `${sessionId}:${messageId}`;
    if (!this.messageZipReferences.has(messageKey)) {
      this.messageZipReferences.set(messageKey, []);
    }

    this.messageZipReferences.get(messageKey)!.push({
      zipId,
      placeholder: `{{ZIP_PLACEHOLDER_${type}_${index}}}`,
      reference
    });
  }

  /**
   * BL-871 (c): takes ONLY these zips out of a message's reference list, lets go of the list once it
   * is empty, and answers the references it removed (none for an id the list does not hold). For a
   * reply the finalize already closed: `/api/sse` drops the zips one chunk's detection made after
   * the close, so no later rebuild of the reply can take them. Every other reference stays, in order.
   */
  dropMessageReferences(sessionId: string, messageId: string, zipIds: string[]): ZipReference[] {
    const messageKey = `${sessionId}:${messageId}`;
    const references = this.messageZipReferences.get(messageKey);
    if (!references || zipIds.length === 0) return [];
    const dropped = new Set(zipIds);
    const removed = references.filter((ref) => typeof ref.zipId === 'string' && dropped.has(ref.zipId));
    if (removed.length === 0) return [];
    const kept = references.filter((ref) => !(typeof ref.zipId === 'string' && dropped.has(ref.zipId)));
    if (kept.length === 0) this.messageZipReferences.delete(messageKey);
    else this.messageZipReferences.set(messageKey, kept);
    return removed;
  }
}
