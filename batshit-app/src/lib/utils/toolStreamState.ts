import { scanZipReferences } from './zipReferenceSafety'

export type ToolStreamInsertion = { pos: number; ref: string; order: number }

export type ToolStreamState = {
  textBuffer: string
  insertions: ToolStreamInsertion[]
  toolPositions: Map<string, { pos: number; order: number }>
}

export type ToolStreamReplayEvent = {
  type?: string | null
  content?: string | null
  toolCallId?: string | null
  placeholderId?: string | null
  order?: number | null
  zipReferences?: Array<{ zipId?: string | null; reference?: string | null }> | null
}

export function isToolZipRef(zipId: string, description: string) {
  return zipId.includes('cool_tool') || description.toLowerCase().includes('tool execution')
}

export function buildToolStreamStateFromContent(
  content: string,
  nextOrder: () => number
): ToolStreamState {
  const state: ToolStreamState = {
    textBuffer: '',
    insertions: [],
    toolPositions: new Map()
  }

  if (!content) return state

  let lastIndex = 0
  // BL-609: the trust reader's one shape, read in one pass (the old pattern was a whole-text
  // regex with its own id rule, BL-708).
  for (const reference of scanZipReferences(content)) {
    const before = content.slice(lastIndex, reference.start)
    if (before) {
      state.textBuffer += before
    }

    const zipId = reference.id
    const description = reference.description ?? ''
    const ref = reference.match

    if (isToolZipRef(zipId, description)) {
      state.insertions.push({
        pos: state.textBuffer.length,
        ref,
        order: nextOrder()
      })
    } else {
      state.textBuffer += ref
    }

    lastIndex = reference.end
  }

  if (lastIndex < content.length) {
    state.textBuffer += content.slice(lastIndex)
  }

  return state
}

/**
 * BL-759: a managed lane took a segment of the reply back, and the server sent the reply's text as
 * it now reads (`content_reset`). The tab's live state is rebuilt from that text, and it keeps its
 * tool cards: a finished card comes back from its reference in the text; a card still running (a
 * position only) and a card the tab drew that the text does not name (the tab's own fallback for a
 * tool result with no zip) stay where they were. The text taken back is always the reply's end (the
 * lane hands the retract on before anything else is written), so a kept position is never past the
 * end of the new text; it is clamped there all the same.
 *
 * BL-946: a kept place was measured in the tab's live text, which has no line breaks around its
 * cards (`composeToolStreamContent` adds them when it draws), while the text rebuilt from the
 * server's content has them. So each kept place is carried into the new text
 * (`mapTextPositionIntoResetText`), and a kept card keeps its order among the cards the text names
 * (the ones before it at its place stay before it). All cards then get new orders, in that order.
 */
export function resetToolStreamStateFromContent(
  previous: ToolStreamState | null | undefined,
  content: string,
  nextOrder: () => number
): ToolStreamState {
  if (!previous) return buildToolStreamStateFromContent(content, nextOrder)
  const next = buildToolStreamStateFromContent(content, () => 0)
  const end = next.textBuffer.length
  const toNext = (pos: number) =>
    Math.min(mapTextPositionIntoResetText(previous.textBuffer, next.textBuffer, pos), end)
  const byPlace = (a: ToolStreamInsertion, b: ToolStreamInsertion) => a.pos - b.pos || a.order - b.order

  // Where each card the text names was in the tab, and where it is now.
  const namedNow = new Map(next.insertions.map((insertion) => [insertion.ref, insertion.pos]))
  const namedBefore = previous.insertions.filter((insertion) => namedNow.has(insertion.ref))

  // A running card's result lands after every card already at its place.
  for (const [key, position] of previous.toolPositions) {
    let pos = toNext(position.pos)
    for (const named of namedBefore) {
      if (named.pos <= position.pos) pos = Math.max(pos, namedNow.get(named.ref) ?? 0)
    }
    next.toolPositions.set(key, { pos: Math.min(pos, end), order: position.order })
  }

  // The cards in the order they are drawn: the named ones in the text's order, each kept card just
  // before the first named card that came after it in the tab, between its neighbours' places.
  const kept = previous.insertions
    .filter((insertion) => !content.includes(insertion.ref))
    .sort(byPlace)
  const oldPlaceOf = new Map(namedBefore.map((insertion) => [insertion.ref, insertion]))
  const drawn: Array<{ pos: number; ref: string }> = []
  let keptIndex = 0
  const placeKept = (until: ToolStreamInsertion | null, upTo: number) => {
    while (keptIndex < kept.length && (!until || byPlace(kept[keptIndex], until) < 0)) {
      const after = drawn.length > 0 ? drawn[drawn.length - 1].pos : 0
      const card = kept[keptIndex]
      drawn.push({ pos: Math.min(Math.max(toNext(card.pos), after), upTo), ref: card.ref })
      keptIndex += 1
    }
  }
  for (const insertion of next.insertions) {
    const oldPlace = oldPlaceOf.get(insertion.ref)
    if (oldPlace) placeKept(oldPlace, insertion.pos)
    drawn.push({ pos: insertion.pos, ref: insertion.ref })
  }
  placeKept(null, end)
  next.insertions = drawn.map((entry) => ({ pos: entry.pos, ref: entry.ref, order: nextOrder() }))
  return next
}

/**
 * BL-946: where a point of the tab's live text is in the text rebuilt from the server's content.
 * That text is the tab's text (up to the part taken back) with only line breaks added around the
 * cards, so each character of the tab's text is matched to its first place there, passing over
 * added line breaks. A point past the matched text (the part taken back) is the end of the match.
 */
export function mapTextPositionIntoResetText(previousText: string, nextText: string, position: number): number {
  let from = 0
  let to = 0
  while (from < position && to < nextText.length) {
    if (previousText[from] === nextText[to]) {
      from += 1
      to += 1
    } else if (nextText[to] === '\n') {
      to += 1
    } else {
      break
    }
  }
  return to
}

export function composeToolStreamContent(state: ToolStreamState) {
  if (state.insertions.length === 0) {
    return state.textBuffer
  }

  const sorted = [...state.insertions].sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos
    return a.order - b.order
  })

  let result = ''
  let cursor = 0

  for (const insertion of sorted) {
    const before = state.textBuffer.slice(cursor, insertion.pos)
    result += before

    if (result && !result.endsWith('\n')) {
      result += '\n\n'
    } else if (result && result.endsWith('\n') && !result.endsWith('\n\n')) {
      result += '\n'
    }

    result += insertion.ref

    const nextText = state.textBuffer.slice(insertion.pos)
    if (nextText.trim()) {
      if (!nextText.startsWith('\n')) {
        result += '\n\n'
      } else if (nextText.startsWith('\n') && !nextText.startsWith('\n\n')) {
        result += '\n'
      }
    }

    cursor = insertion.pos
  }

  result += state.textBuffer.slice(cursor)
  return result
}

function resolveReplayToolKey(event: ToolStreamReplayEvent) {
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
  if (toolCallId) return toolCallId
  const placeholderId = typeof event.placeholderId === 'string' ? event.placeholderId : ''
  if (placeholderId) return placeholderId
  const order = typeof event.order === 'number' && Number.isFinite(event.order) ? event.order : null
  if (order !== null) return `order-${order}`
  return null
}

export function buildToolStreamStateFromEvents(events: ToolStreamReplayEvent[]): ToolStreamState {
  const state: ToolStreamState = {
    textBuffer: '',
    insertions: [],
    toolPositions: new Map()
  }

  let fallbackOrder = 0

  for (const event of events) {
    const type = typeof event?.type === 'string' ? event.type.toLowerCase() : ''

    if (type === 'chunk') {
      if (typeof event.content === 'string' && event.content.length > 0) {
        state.textBuffer += event.content
      }
      continue
    }

    if (type === 'tool_start' || type === 'tool-call' || type === 'tool_call') {
      const toolKey = resolveReplayToolKey(event)
      if (!toolKey || state.toolPositions.has(toolKey)) {
        continue
      }

      const order =
        typeof event.order === 'number' && Number.isFinite(event.order)
          ? event.order
          : fallbackOrder++

      state.toolPositions.set(toolKey, {
        pos: state.textBuffer.length,
        order
      })
      continue
    }

    if (type !== 'tool-result' && type !== 'tool_result') {
      continue
    }

    const refs = Array.isArray(event.zipReferences)
      ? event.zipReferences
          .map((ref) => (typeof ref?.reference === 'string' ? ref.reference : ''))
          .filter((ref) => ref.length > 0)
      : []

    if (refs.length === 0) {
      continue
    }

    const toolKey = resolveReplayToolKey(event)
    const insertionPosition =
      toolKey && state.toolPositions.has(toolKey)
        ? state.toolPositions.get(toolKey)?.pos ?? state.textBuffer.length
        : state.textBuffer.length

    if (toolKey) {
      state.toolPositions.delete(toolKey)
    }

    const baseOrder =
      typeof event.order === 'number' && Number.isFinite(event.order)
        ? event.order * 1000
        : fallbackOrder++ * 1000

    refs.forEach((ref, index) => {
      state.insertions.push({
        pos: insertionPosition,
        ref,
        order: baseOrder + index
      })
    })
  }

  return state
}

export function composeToolStreamContentFromEvents(events: ToolStreamReplayEvent[]) {
  return composeToolStreamContent(buildToolStreamStateFromEvents(events))
}

export function injectZipReferencesIntoReplayEvents(
  events: ToolStreamReplayEvent[],
  refs: Array<{ zipId?: string | null; reference?: string | null }>
) {
  const pendingRefs = refs
    .map((ref) => ({
      zipId: typeof ref?.zipId === 'string' ? ref.zipId : null,
      reference: typeof ref?.reference === 'string' ? ref.reference : ''
    }))
    .filter((ref) => ref.reference.length > 0)

  const replayEvents = events.map((event) => ({
    ...event,
    ...(Array.isArray(event?.zipReferences)
      ? {
          zipReferences: event.zipReferences.map((ref) => ({
            zipId: typeof ref?.zipId === 'string' ? ref.zipId : null,
            reference: typeof ref?.reference === 'string' ? ref.reference : ''
          }))
        }
      : {})
  }))

  if (pendingRefs.length === 0) {
    return replayEvents
  }

  const matchedToolKeys = new Set<string>()

  for (let index = 0; index < replayEvents.length; index += 1) {
    const event = replayEvents[index]
    const type = typeof event?.type === 'string' ? event.type.toLowerCase() : ''
    if (type !== 'tool-result' && type !== 'tool_result') {
      continue
    }

    const toolKey = resolveReplayToolKey(event)
    const existingRefs = Array.isArray(event.zipReferences)
      ? event.zipReferences
          .map((ref) => (typeof ref?.reference === 'string' ? ref.reference : ''))
          .filter((ref) => ref.length > 0)
      : []

    if (existingRefs.length > 0) {
      if (toolKey) matchedToolKeys.add(toolKey)
      continue
    }

    const nextRef = pendingRefs.shift()
    if (!nextRef) {
      break
    }

    replayEvents[index] = {
      ...event,
      zipReferences: [nextRef]
    }

    if (toolKey) matchedToolKeys.add(toolKey)
  }

  if (pendingRefs.length === 0) {
    return replayEvents
  }

  const toolPositionSources = replayEvents.filter((event) => {
    const type = typeof event?.type === 'string' ? event.type.toLowerCase() : ''
    if (type !== 'tool_start' && type !== 'tool-call' && type !== 'tool_call') {
      return false
    }
    const toolKey = resolveReplayToolKey(event)
    return Boolean(toolKey) && !matchedToolKeys.has(toolKey as string)
  })

  for (const source of toolPositionSources) {
    const nextRef = pendingRefs.shift()
    if (!nextRef) {
      break
    }

    const toolKey = resolveReplayToolKey(source)
    if (toolKey) matchedToolKeys.add(toolKey)

    replayEvents.push({
      type: 'tool-result',
      toolCallId: source.toolCallId,
      placeholderId: source.placeholderId,
      order: source.order,
      zipReferences: [nextRef]
    })
  }

  while (pendingRefs.length > 0) {
    replayEvents.push({
      type: 'tool-result',
      zipReferences: [pendingRefs.shift()!]
    })
  }

  return replayEvents
}
