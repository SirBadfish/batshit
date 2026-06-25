import type { ZipReference } from '$lib/server/zipService'
import {
  composeToolStreamContentFromEvents,
  injectZipReferencesIntoReplayEvents,
  type ToolStreamReplayEvent
} from '$lib/utils/toolStreamState'

export function buildEndStreamingContent(options: {
  streamEvents: ToolStreamReplayEvent[]
  inlineCapable: boolean
  toolZipRefs: ZipReference[]
  allZipRefs: ZipReference[]
}) {
  const { streamEvents, inlineCapable, toolZipRefs, allZipRefs } = options

  const replayEvents = inlineCapable
    ? injectZipReferencesIntoReplayEvents(streamEvents, toolZipRefs)
    : streamEvents

  let workingContent = inlineCapable
    ? composeToolStreamContentFromEvents(replayEvents)
    : streamEvents
        .filter((event) => event.type === 'chunk' && typeof event.content === 'string')
        .map((event) => event.content as string)
        .join('')

  const refsToAppend = allZipRefs.filter(
    (ref) =>
      typeof ref?.reference === 'string' &&
      ref.reference.length > 0 &&
      !workingContent.includes(ref.reference)
  )

  if (refsToAppend.length > 0) {
    const referencesBlock = refsToAppend.map((ref) => ref.reference).join('\n\n')
    workingContent = workingContent.trim().length > 0
      ? `${workingContent}\n\n${referencesBlock}`
      : referencesBlock
  }

  return {
    content: workingContent,
    replayEvents
  }
}
