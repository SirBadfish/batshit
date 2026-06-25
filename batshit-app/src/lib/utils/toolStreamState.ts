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

const TOOL_ZIP_REGEX = /\{\{batshit-zip:([^:}]+)(?::::([^}]+))?\}\}/g

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
  TOOL_ZIP_REGEX.lastIndex = 0
  let match: RegExpExecArray | null = null

  while ((match = TOOL_ZIP_REGEX.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index)
    if (before) {
      state.textBuffer += before
    }

    const zipId = match[1] || ''
    const description = match[2] || ''
    const ref = match[0]

    if (isToolZipRef(zipId, description)) {
      state.insertions.push({
        pos: state.textBuffer.length,
        ref,
        order: nextOrder()
      })
    } else {
      state.textBuffer += ref
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < content.length) {
    state.textBuffer += content.slice(lastIndex)
  }

  return state
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
