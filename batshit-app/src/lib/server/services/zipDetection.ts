import { redisStreamService } from '$lib/server/redisStreamService';
import { createPermanentZip } from '$lib/server/zipService';
import type { ZipReference } from '$lib/server/zipService';
import { getTypeZipSettings } from '$lib/utils/toolRenderMap';
import { findCodeRegions, isInCodeRegion } from '$lib/utils/markdownCodeRegions';
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
 * and outside a zip reference; the block ends at the first closing tag after it. A block never
 * spans a zip reference (a tool card): the opening tag and its words stay text. An opening tag
 * with no closing tag is text: the words after it are held while the reply streams (the pair may
 * still close) and handed back by `takeUnclosedText`, in order, when the reply ends or a tool
 * card comes.
 */
const OPEN_TAG = /<error>/gi;
const OPEN_TAG_TEXT = '<error>';
const CLOSE_TAG = /<\/error>/gi;
const CLOSE_TAG_LENGTH = '</error>'.length;
const ZIP_TYPE: ZipType = 'error';
const ZIP_REFERENCE_OPEN = '{{batshit-zip:';
const BLANK_LINE = /\r?\n[ \t]*\r?\n/;

interface OpenBlock {
  /** The opening tag as written. */
  tag: string;
  /** The words after it so far. */
  body: string;
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
  /** A chunk's last characters that could still become an opening tag (`<`, `<e`, ... `<erro`). */
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
 *   The Codex adapter hands on a retract before any other text reaches the stream, so this is an
 *   error case.
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

function createBufferKey(sessionId: string, messageId: string) {
  return `${sessionId}:${messageId}`;
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
   * The words of a block that never closed: its opening tag and everything after it, as text
   * (BL-489). A caller hands them on as an ordinary chunk when the reply ends and before a tool
   * card, so the reply keeps its words in order. Empty when no block is open. `endOfReply` also
   * lets go of the message's scan state (a reply that ends without `end`: stopped or failed).
   */
  takeUnclosedText(sessionId: string, messageId: string, options?: { endOfReply?: boolean }): string {
    const key = createBufferKey(sessionId, messageId);
    const state = this.streamingBuffers.get(key);
    const text = state ? (state.open ? state.open.tag + state.open.body : '') + state.heldStart : '';
    if (options?.endOfReply) {
      // A reply that ends without `end` (stopped or failed) never reaches finalizeOpenBlocks.
      this.streamingBuffers.delete(key);
      this.messageZipReferences.delete(key);
      this.messageContexts.delete(key);
    } else if (state) {
      state.open = null;
      state.heldStart = '';
      state.emitted += text;
      // BL-759: the held words went out with no segment, before a tool card; the runs before
      // them can no longer be rewound exactly.
      if (text) state.marks = [];
    }
    return text;
  }

  /**
   * BL-759: takes a segment back out of the scan state (a managed lane retracted it: a Codex
   * message that dropped and was started again). Only the last run read, read in one run, can be
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
    state.open = mark.open ? { ...mark.open } : null;
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
        open: state.open ? { ...state.open } : null,
        heldStart: state.heldStart,
        referenceCount: this.messageZipReferences.get(bufferKey)?.length ?? 0
      });
      if (state.marks.length > MAX_SEGMENT_MARKS) state.marks.shift();
      state.runs.set(segment, (state.runs.get(segment) ?? 0) + 1);
    }

    let out = '';
    // A partial opening tag held from the last chunk is decided now, with this chunk after it.
    let pending = state.heldStart + content;
    state.heldStart = '';

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
        const becameCode =
          pending.includes('`') &&
          !BLANK_LINE.test(open.body) &&
          isInCodeRegion(findCodeRegions(text), openAt);
        // Only the new words (and a closing tag's worth of the old, for a tag split across
        // chunks) can hold a closing tag: the held words were searched already.
        CLOSE_TAG.lastIndex = Math.max(0, open.body.length - CLOSE_TAG_LENGTH + 1);
        const closeMatch = CLOSE_TAG.exec(rest);
        const closeAt = closeMatch ? closeMatch.index : -1;
        const referenceAt = rest.includes(ZIP_REFERENCE_OPEN)
          ? scanZipReferences(text).find((ref) => ref.start >= bodyStart)?.start ?? -1
          : -1;
        const spansReference =
          referenceAt !== -1 && (closeAt === -1 || referenceAt - bodyStart < closeAt);

        if (becameCode || spansReference) {
          state.open = null;
          out += open.tag;
          pending = rest;
          continue;
        }

        if (!closeMatch) {
          open.body = rest;
          pending = '';
          break;
        }

        const blockContent = rest.substring(0, closeAt);
        pending = rest.substring(closeAt + closeMatch[0].length);
        state.open = null;
        out += await this.zipBlock(sessionId, messageId, blockContent);
        continue;
      }

      const openAt = this.findOpeningTag(state.emitted + out, pending);
      if (!openAt) {
        // The chunk's last characters may be the start of an opening tag the next chunk
        // finishes: hold them until it decides (a split opening tag opens either way).
        const held = partialOpeningTagAtEnd(pending);
        out += pending.substring(0, pending.length - held);
        state.heldStart = pending.substring(pending.length - held);
        pending = '';
        break;
      }

      out += pending.substring(0, openAt.index);
      state.open = { tag: openAt.tag, body: '' };
      pending = pending.substring(openAt.index + openAt.tag.length);
    }

    state.emitted += out;
    return { shouldStream: out.length > 0, content: out };
  }

  /** The first opening tag in `pending` that is outside code and outside a zip reference. */
  private findOpeningTag(before: string, pending: string): { index: number; tag: string } | null {
    OPEN_TAG.lastIndex = 0;
    if (!OPEN_TAG.test(pending)) return null;

    const text = before + pending;
    const regions = findCodeRegions(text);
    const references = text.includes(ZIP_REFERENCE_OPEN) ? scanZipReferences(text) : [];

    OPEN_TAG.lastIndex = 0;
    for (const match of pending.matchAll(OPEN_TAG)) {
      const at = before.length + match.index;
      if (isInCodeRegion(regions, at) || insideZipReference(references, at)) continue;
      return { index: match.index, tag: match[0] };
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
    const processed = result.content + this.takeUnclosedText(sessionId, messageId);

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
}
