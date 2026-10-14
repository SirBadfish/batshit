/**
 * A reply's text kept as pieces by segment (BL-759).
 *
 * A managed lane may take back a message its vendor never finished and started again: Codex's
 * app-server lane retries a dropped response stream by itself and starts the answer again as a
 * new item. Each text chunk of such a lane names its segment (the vendor message it belongs to),
 * and a retract names one segment. A reader that keeps the text removes that segment's pieces and
 * nothing else: never by a count of characters, never by a search for its words.
 *
 * Text with no segment (Batshit's own additions, and every lane that never takes text back) is
 * never removed. Adjacent pieces of the same segment are joined, so the list stays as long as the
 * number of segment changes, not the number of chunks.
 */
export class SegmentedText {
  private readonly pieces: Array<{ segmentId: string | null; text: string }> = []
  private joined = ''

  /** Adds `text` at the end, as part of `segmentId` (none for text no lane can take back). */
  append(text: string, segmentId?: string | null): void {
    if (!text) return
    const segment = typeof segmentId === 'string' && segmentId.length > 0 ? segmentId : null
    const last = this.pieces[this.pieces.length - 1]
    if (last && last.segmentId === segment) {
      last.text += text
    } else {
      this.pieces.push({ segmentId: segment, text })
    }
    this.joined += text
  }

  /** Removes every piece of `segmentId`. Answers the text it removed ('' when it held none). */
  retract(segmentId: string): string {
    if (!segmentId) return ''
    let removed = ''
    for (let index = this.pieces.length - 1; index >= 0; index -= 1) {
      if (this.pieces[index].segmentId !== segmentId) continue
      removed = this.pieces[index].text + removed
      this.pieces.splice(index, 1)
    }
    if (!removed) return ''
    // Two pieces of one segment that the removed segment kept apart are one piece again.
    for (let index = this.pieces.length - 1; index > 0; index -= 1) {
      if (this.pieces[index].segmentId === this.pieces[index - 1].segmentId) {
        this.pieces[index - 1].text += this.pieces[index].text
        this.pieces.splice(index, 1)
      }
    }
    this.joined = this.pieces.map((piece) => piece.text).join('')
    return removed
  }

  /**
   * The pieces that make up the last `suffix.length` characters, each with its segment, or null
   * when the text does not end with `suffix`. The group chat's control buffer (send-routed) hands
   * on what follows its leading control block, which is always the end of what it buffered, so
   * each piece it hands on keeps its segment and can still be taken back.
   */
  piecesOfSuffix(suffix: string): Array<{ segmentId: string | null; text: string }> | null {
    if (!this.joined.endsWith(suffix)) return null
    const pieces: Array<{ segmentId: string | null; text: string }> = []
    let needed = suffix.length
    for (let index = this.pieces.length - 1; index >= 0 && needed > 0; index -= 1) {
      const piece = this.pieces[index]
      const text = piece.text.length <= needed ? piece.text : piece.text.slice(piece.text.length - needed)
      pieces.unshift({ segmentId: piece.segmentId, text })
      needed -= text.length
    }
    return pieces
  }

  /** Whether any text of `segmentId` is held. */
  hasSegment(segmentId: string): boolean {
    return this.pieces.some((piece) => piece.segmentId === segmentId)
  }

  get length(): number {
    return this.joined.length
  }

  toString(): string {
    return this.joined
  }
}
